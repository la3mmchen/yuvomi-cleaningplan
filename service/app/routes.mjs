// HTTP surface of the sidecar (design section 7). One function per route, a flat
// table, validation before storage. Every route except /health resolves the caller
// through Yuvomi first; mutations additionally pass the CSRF/Origin check and need
// write access.
import { HttpError } from './auth.mjs';
import * as store from './db.mjs';
import { dueDatesInWindow, isIsoDate } from './schedule.mjs';

export const DEFAULT_PREFIX = '/api/extensions/cleaningplan';
const BODY_LIMIT = 64 * 1024;
const NAME_MAX = 100;
const NOTE_MAX = 1000;    // goes into the Yuvomi task description (max 5000) after a short prefix
const INTERVAL_MAX = 365;
const WINDOW_MAX_DAYS = 92;
const TAGS_MAX = 30;      // Yuvomi keeps at most 32 tags per task; two are the module's own
const RESERVED_TAG_RE = /^cleaningplan(?::|$)/i; // the module finds its tasks by these
const TAG_MAX_LENGTH = 64;
const UNITS = new Set(['days', 'weeks', 'months']);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// ---- validation (each throws HttpError 400 with the reason from the plan) ----

function bad(reason) { return new HttpError(400, reason); }

function vName(value) {
  if (typeof value !== 'string') throw bad('bad_name');
  const name = value.trim();
  if (name.length < 1 || name.length > NAME_MAX) throw bad('bad_name');
  return name;
}

// Free text shown under the activity and copied into each generated task's description.
function vNote(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw bad('bad_note');
  const note = value.trim();
  if (note.length > NOTE_MAX) throw bad('bad_note');
  return note || null;
}

function vSchedule(value) {
  const v = value?.interval_value;
  const unit = value?.interval_unit;
  if (!Number.isInteger(v) || v < 1 || v > INTERVAL_MAX || !UNITS.has(unit)) throw bad('bad_interval');
  return { interval_value: v, interval_unit: unit };
}

function vTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !TIME_RE.test(value)) throw bad('bad_time');
  return value;
}

function vDate(value) {
  if (!isIsoDate(value)) throw bad('bad_date');
  return value;
}

function vAssignee(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!Number.isInteger(value) || value < 1) throw bad('bad_assignee');
  return value;
}

function vPositiveInt(value, reason) {
  if (!Number.isInteger(value) || value < 1) throw bad(reason);
  return value;
}

function vSortOrder(value) {
  if (!Number.isInteger(value) || value < 0) throw bad('bad_sort_order');
  return value;
}

// Free-form tags for every task of an iteration, in Yuvomi's own limits: trimmed, empty
// ones dropped, duplicates (ignoring case) collapsed to the first spelling.
function vTags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((t) => typeof t !== 'string')) throw bad('bad_tags');
  const seen = new Set();
  const tags = [];
  for (const raw of value) {
    const tag = raw.trim();
    if (!tag) continue;
    if (tag.length > TAG_MAX_LENGTH || RESERVED_TAG_RE.test(tag)) throw bad('bad_tags');
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > TAGS_MAX) throw bad('bad_tags');
  return tags;
}

// Rooms an iteration is limited to; empty or absent means every room. Each id must exist.
function vRoomIds(value, db) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => !Number.isInteger(id) || id < 1)) throw bad('bad_rooms');
  const known = new Set(store.listPlan(db).rooms.map((room) => room.id));
  const ids = [...new Set(value)];
  if (ids.some((id) => !known.has(id))) throw bad('bad_rooms');
  return ids;
}

function vActive(value) {
  if (typeof value !== 'boolean') throw bad('bad_active');
  return value;
}

function today() { return new Date().toISOString().slice(0, 10); }

function daysInclusive(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

function activityInput(body, { create }) {
  const out = {};
  if (create || body.name !== undefined) out.name = vName(body.name);
  if (create || body.note !== undefined) out.note = vNote(body.note);
  if (create || body.schedule !== undefined) Object.assign(out, vSchedule(body.schedule));
  if (create || body.target_time !== undefined) out.target_time = vTime(body.target_time);
  if (create || body.default_assignee_id !== undefined) out.default_assignee_id = vAssignee(body.default_assignee_id);
  if (create) out.first_due = body.first_due === undefined || body.first_due === null ? today() : vDate(body.first_due);
  else if (body.first_due !== undefined) out.first_due = vDate(body.first_due);
  if (body.active !== undefined) out.active = vActive(body.active);
  if (!create && body.sort_order !== undefined) out.sort_order = vSortOrder(body.sort_order);
  return out;
}

// ---- routes: (ctx) => { status?, data } ----

const routes = [
  ['GET', '/health', () => ({ data: { ok: true } }), { open: true }],
  ['GET', '/me', ({ who }) => ({ data: { user_id: who.userId, access: who.access } })],
  ['GET', '/plan', ({ db }) => ({ data: store.listPlan(db) })],

  ['POST', '/rooms', ({ db, body }) => ({ status: 201, data: store.createRoom(db, { name: vName(body.name) }) })],
  ['PATCH', '/rooms/:id', ({ db, params, body }) => {
    const patch = {};
    if (body.name !== undefined) patch.name = vName(body.name);
    if (body.sort_order !== undefined) patch.sort_order = vSortOrder(body.sort_order);
    return { data: found(store.updateRoom(db, params.id, patch)) };
  }],
  ['DELETE', '/rooms/:id', ({ db, params }) => {
    if (!store.deleteRoom(db, params.id)) throw new HttpError(404, 'not_found');
    return { data: { id: params.id, deleted: true } };
  }],

  ['POST', '/rooms/:id/activities', ({ db, params, body }) => ({
    status: 201, data: found(store.createActivity(db, params.id, activityInput(body, { create: true }))),
  })],
  ['PATCH', '/activities/:id', ({ db, params, body }) => ({
    data: found(store.updateActivity(db, params.id, activityInput(body, { create: false }))),
  })],
  ['DELETE', '/activities/:id', ({ db, params }) => {
    if (!store.deleteActivity(db, params.id)) throw new HttpError(404, 'not_found');
    return { data: { id: params.id, deleted: true } };
  }],

  ['GET', '/iterations', ({ db }) => ({ data: store.listIterations(db) })],
  ['POST', '/iterations', ({ db, body, who }) => {
    const start_date = vDate(body.start_date);
    const end_date = vDate(body.end_date);
    if (end_date < start_date || daysInclusive(start_date, end_date) > WINDOW_MAX_DAYS) throw bad('bad_window');
    const tags = vTags(body.tags);
    const room_ids = vRoomIds(body.room_ids, db);
    const iteration = store.createIteration(db, { start_date, end_date, created_by: who.userId, tags, room_ids, generate: dueDatesInWindow });
    return { status: 201, data: iteration };
  }],
  ['GET', '/iterations/:id', ({ db, params }) => ({ data: found(store.getIteration(db, params.id)) })],
  ['PATCH', '/iterations/:id/todos/:tid', ({ db, params, body }) => {
    const result = store.linkTodoTask(db, params.id, params.tid, vPositiveInt(body.yuvomi_task_id, 'bad_task_id'));
    if (!result.ok) throw new HttpError(result.reason === 'already_linked' ? 409 : 404, result.reason);
    return { data: result.todo };
  }],
  ['DELETE', '/iterations/:id', ({ db, params }) => {
    const result = store.deleteIteration(db, params.id);
    if (result === 'not_found') throw new HttpError(404, 'not_found');
    if (result === 'not_newest') throw new HttpError(409, 'not_newest');
    return { data: { id: params.id, deleted: true } };
  }],

  ['GET', '/settings', ({ db }) => ({ data: { category_key: store.getSetting(db, 'category_key') } })],
  ['PATCH', '/settings', ({ db, body }) => {
    if (body.category_key !== undefined) {
      const key = body.category_key;
      if (key !== null && (typeof key !== 'string' || key.length < 1 || key.length > NAME_MAX)) throw bad('bad_setting');
      store.setSetting(db, 'category_key', key ?? '');
    }
    const value = store.getSetting(db, 'category_key');
    return { data: { category_key: value || null } };
  }],
].map(([method, pattern, fn, opts = {}]) => ({ method, parts: pattern.split('/').slice(1), fn, open: Boolean(opts.open) }));

function found(value) {
  if (value === null) throw new HttpError(404, 'not_found');
  return value;
}

function match(method, path) {
  const segments = path.split('/').slice(1);
  for (const route of routes) {
    if (route.method !== method || route.parts.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segments.length; i++) {
      const p = route.parts[i];
      if (p.startsWith(':')) {
        const n = Number(segments[i]);
        if (!/^\d+$/.test(segments[i]) || !Number.isSafeInteger(n)) { ok = false; break; }
        params[p.slice(1)] = n;
      } else if (p !== segments[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // Over the limit the rest is drained and 413 answered at the end: destroying the
    // socket mid-upload makes the browser see a network error instead of the status.
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > BODY_LIMIT) return reject(new HttpError(413, 'too_large'));
      if (!size) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(new HttpError(400, 'bad_json'));
        resolve(parsed);
      } catch { reject(new HttpError(400, 'bad_json')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export function createHandler({ db, auth, prefix = DEFAULT_PREFIX }) {
  return (req, res) => {
    handle(req).then(
      ({ status = 200, data }) => send(res, status, { data }),
      (err) => {
        if (err instanceof HttpError) return send(res, err.status, { error: err.message, code: err.status, reason: err.reason });
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: err?.message, stack: err?.stack }));
        send(res, 500, { error: 'Internal server error.', code: 500 });
      },
    );
  };

  async function handle(req) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : null;
    const hit = path && match(req.method, path.length > 1 ? path.replace(/\/$/, '') : path);
    if (!hit) throw new HttpError(404, 'not_found');
    const ctx = { db, params: hit.params, body: {} };
    if (!hit.route.open) {
      ctx.who = await auth.resolve(req);
      if (ctx.who.access === 'none') throw new HttpError(403, 'forbidden');
      if (MUTATING.has(req.method)) {
        auth.assertCsrf(req);
        if (ctx.who.access !== 'write') throw new HttpError(403, 'read_only');
        ctx.body = await readBody(req);
      }
    }
    return hit.route.fn(ctx);
  }
}
