import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../app/db.mjs';
import { createAuth } from '../app/auth.mjs';
import { createHandler } from '../app/routes.mjs';
import { startFakeYuvomi, accessFake } from './helpers.mjs';

const ORIGIN = 'http://localhost:3000';
const PREFIX = '/api/extensions/cleaningplan';
let yuvomi, server, base, db;

before(async () => {
  yuvomi = await startFakeYuvomi(accessFake().handler);
  db = openDb(':memory:');
  const auth = createAuth({ yuvomiUrl: yuvomi.url, publicOrigin: ORIGIN, cacheMs: 0 });
  server = http.createServer(createHandler({ db, auth }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}${PREFIX}`;
});
after(async () => { await new Promise((r) => server.close(r)); await yuvomi.close(); });

async function call(method, path, { body, access = 'write', csrf = true, auth = true, raw } = {}) {
  const headers = { origin: ORIGIN };
  if (auth) headers.cookie = `sid=${access}; uid=5; csrf-token=t1`;
  if (csrf) headers['x-csrf-token'] = 't1';
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

test('health needs no auth', async () => {
  const r = await call('GET', '/health', { auth: false, csrf: false });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { data: { ok: true } });
});

test('me returns user id and access', async () => {
  assert.deepEqual((await call('GET', '/me')).json, { data: { user_id: 5, access: 'write' } });
  assert.equal((await call('GET', '/me', { access: 'read' })).json.data.access, 'read');
  const anon = await call('GET', '/me', { auth: false });
  assert.equal(anon.status, 401);
  assert.equal(anon.json.reason, 'not_authenticated');
});

test('rooms and activities round trip', async () => {
  const room = await call('POST', '/rooms', { body: { name: 'Kitchen' } });
  assert.equal(room.status, 201);
  assert.equal(room.json.data.name, 'Kitchen');
  const rid = room.json.data.id;

  const act = await call('POST', `/rooms/${rid}/activities`, {
    body: { name: 'Vacuum', schedule: { interval_value: 2, interval_unit: 'days' }, default_assignee_id: 2, target_time: '18:00', first_due: '2026-11-03' },
  });
  assert.equal(act.status, 201);
  assert.equal(act.json.data.next_due, '2026-11-03');
  assert.deepEqual(act.json.data.schedule, { interval_value: 2, interval_unit: 'days' });
  const aid = act.json.data.id;

  const plan = await call('GET', '/plan');
  assert.equal(plan.status, 200);
  assert.equal(plan.json.data.rooms[0].activities[0].id, aid);

  const patched = await call('PATCH', `/activities/${aid}`, { body: { name: 'Vacuum floor', schedule: { interval_value: 1, interval_unit: 'weeks' }, active: false } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.name, 'Vacuum floor');
  assert.deepEqual(patched.json.data.schedule, { interval_value: 1, interval_unit: 'weeks' });
  assert.equal(patched.json.data.active, false);

  assert.equal((await call('PATCH', '/rooms/999', { body: { name: 'x' } })).status, 404);
  assert.equal((await call('POST', '/rooms/999/activities', { body: { name: 'x', schedule: { interval_value: 1, interval_unit: 'days' } } })).status, 404);
  assert.equal((await call('DELETE', `/activities/${aid}`)).status, 200);
  assert.equal((await call('DELETE', `/activities/${aid}`)).status, 404);
  assert.equal((await call('DELETE', `/rooms/${rid}`)).status, 200);
  assert.deepEqual((await call('GET', '/plan')).json.data, { rooms: [] });
});

test('activity validation', async () => {
  const rid = (await call('POST', '/rooms', { body: { name: 'Bath' } })).json.data.id;
  const post = (body) => call('POST', `/rooms/${rid}/activities`, { body });
  const base = { name: 'Scrub', schedule: { interval_value: 1, interval_unit: 'days' } };
  assert.equal((await post({ ...base, schedule: { interval_value: 0, interval_unit: 'days' } })).json.reason, 'bad_interval');
  assert.equal((await post({ ...base, schedule: { interval_value: 366, interval_unit: 'days' } })).json.reason, 'bad_interval');
  assert.equal((await post({ ...base, schedule: { interval_value: 1, interval_unit: 'years' } })).json.reason, 'bad_interval');
  assert.equal((await post({ ...base, target_time: '25:00' })).json.reason, 'bad_time');
  assert.equal((await post({ ...base, name: 'x'.repeat(101) })).json.reason, 'bad_name');
  assert.equal((await post({ ...base, name: '  ' })).json.reason, 'bad_name');
  assert.equal((await post({ ...base, first_due: '2026-02-30' })).json.reason, 'bad_date');
  assert.equal((await post({ ...base, default_assignee_id: 'sam' })).json.reason, 'bad_assignee');
  assert.equal((await post({ ...base, default_assignee_id: 0 })).json.reason, 'bad_assignee');
  assert.equal((await post({ ...base, note: 42 })).json.reason, 'bad_note');
  assert.equal((await post({ ...base, note: 'x'.repeat(1001) })).json.reason, 'bad_note');
  const noted = await post({ ...base, note: '  * newspapers away\n* glasses away  ' });
  assert.equal(noted.json.data.note, '* newspapers away\n* glasses away');
  assert.equal((await call('PATCH', `/activities/${noted.json.data.id}`, { body: { note: '   ' } })).json.data.note, null);
  const ok = await post({ ...base, target_time: null, default_assignee_id: null });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.data.target_time, null);
  assert.equal((await call('POST', '/rooms', { body: { name: '' } })).json.reason, 'bad_name');
  assert.equal((await call('PATCH', `/rooms/${rid}`, { body: { sort_order: -1 } })).json.reason, 'bad_sort_order');
  await call('DELETE', `/rooms/${rid}`);
});

test('write routes refuse read access', async () => {
  const rid = (await call('POST', '/rooms', { body: { name: 'Hall' } })).json.data.id;
  for (const [m, p, body] of [['POST', '/rooms', { name: 'x' }], ['POST', '/iterations', { start_date: '2026-11-03', end_date: '2026-11-09' }], ['DELETE', `/rooms/${rid}`], ['PATCH', '/settings', { category_key: 'x' }]]) {
    const r = await call(m, p, { body, access: 'read' });
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.json.reason, 'read_only');
  }
  assert.equal((await call('GET', '/plan', { access: 'read' })).status, 200);
  await call('DELETE', `/rooms/${rid}`);
});

test('none access is refused everywhere', async () => {
  const r = await call('GET', '/plan', { access: 'none' });
  assert.equal(r.status, 403);
  assert.equal(r.json.reason, 'forbidden');
  assert.equal((await call('POST', '/rooms', { body: { name: 'x' }, access: 'none' })).status, 403);
});

test('mutations without csrf are refused', async () => {
  const r = await call('POST', '/rooms', { body: { name: 'x' }, csrf: false });
  assert.equal(r.status, 403);
  assert.equal(r.json.reason, 'csrf_invalid');
  assert.deepEqual((await call('GET', '/plan')).json.data, { rooms: [] });
});

test('iteration generation end to end', async () => {
  const rid = (await call('POST', '/rooms', { body: { name: 'Kitchen' } })).json.data.id;
  await call('POST', `/rooms/${rid}/activities`, { body: { name: 'Wipe', schedule: { interval_value: 1, interval_unit: 'days' }, first_due: '2026-11-03' } });
  await call('POST', `/rooms/${rid}/activities`, { body: { name: 'Vacuum', schedule: { interval_value: 2, interval_unit: 'days' }, first_due: '2026-11-03', default_assignee_id: 2, target_time: '18:00' } });

  const it = await call('POST', '/iterations', { body: { start_date: '2026-11-03', end_date: '2026-11-09' } });
  assert.equal(it.status, 201);
  assert.equal(it.json.data.todos.length, 11);
  assert.equal(it.json.data.created_by, 5);
  const vac = it.json.data.todos.filter((t) => t.activity_name === 'Vacuum');
  assert.deepEqual(vac.map((t) => t.due_date), ['2026-11-03', '2026-11-05', '2026-11-07', '2026-11-09']);
  assert.equal(vac[0].title, 'Kitchen: Vacuum');
  assert.equal(vac[0].assignee_id, 2);
  assert.equal(vac[0].due_time, '18:00');

  const list = await call('GET', '/iterations');
  assert.equal(list.json.data[0].todo_count, 11);
  assert.equal(list.json.data[0].linked_count, 0);

  const link = await call('PATCH', `/iterations/${it.json.data.id}/todos/${vac[0].id}`, { body: { yuvomi_task_id: 41 } });
  assert.equal(link.status, 200);
  assert.equal(link.json.data.yuvomi_task_id, 41);
  assert.equal((await call('GET', `/iterations/${it.json.data.id}`)).json.data.linked_count, 1);
  const again = await call('PATCH', `/iterations/${it.json.data.id}/todos/${vac[0].id}`, { body: { yuvomi_task_id: 99 } });
  assert.equal(again.status, 409);
  assert.equal(again.json.reason, 'already_linked');
  assert.equal((await call('PATCH', `/iterations/${it.json.data.id}/todos/${vac[0].id}`, { body: { yuvomi_task_id: 'x' } })).status, 400);
  assert.equal((await call('PATCH', `/iterations/${it.json.data.id + 1}/todos/${vac[0].id}`, { body: { yuvomi_task_id: 42 } })).status, 404);
  assert.equal((await call('GET', '/plan')).json.data.rooms[0].activities[1].next_due, '2026-11-11');
});

test('second iteration over an overlapping window generates nothing new', async () => {
  const again = await call('POST', '/iterations', { body: { start_date: '2026-11-03', end_date: '2026-11-09' } });
  assert.equal(again.status, 201);
  assert.equal(again.json.data.todos.length, 0);
  await call('DELETE', `/iterations/${again.json.data.id}`);
});

test('window validation', async () => {
  const post = (body) => call('POST', '/iterations', { body });
  assert.equal((await post({ start_date: '2026-11-09', end_date: '2026-11-03' })).json.reason, 'bad_window');
  assert.equal((await post({ start_date: '2026-01-01', end_date: '2026-04-03' })).json.reason, 'bad_window');
  assert.equal((await post({ start_date: '2026-01-01', end_date: '2026-04-02' })).status, 201); // 92 days
  assert.equal((await post({ start_date: 'nope', end_date: '2026-04-02' })).json.reason, 'bad_date');
  const list = (await call('GET', '/iterations')).json.data;
  await call('DELETE', `/iterations/${list[0].id}`);
});

test('delete iteration', async () => {
  const first = (await call('GET', '/iterations')).json.data[0];
  const second = await call('POST', '/iterations', { body: { start_date: '2026-11-10', end_date: '2026-11-16' } });
  assert.equal(second.status, 201);
  const notNewest = await call('DELETE', `/iterations/${first.id}`);
  assert.equal(notNewest.status, 409);
  assert.equal(notNewest.json.reason, 'not_newest');
  const del = await call('DELETE', `/iterations/${second.json.data.id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.json.data, { id: second.json.data.id, deleted: true });
  assert.equal((await call('GET', '/plan')).json.data.rooms[0].activities[1].next_due, '2026-11-11');
  assert.equal((await call('DELETE', '/iterations/999')).status, 404);
});

test('settings round trip', async () => {
  assert.deepEqual((await call('GET', '/settings')).json.data, { category_key: null });
  assert.equal((await call('PATCH', '/settings', { body: { category_key: 'cleaning' } })).json.data.category_key, 'cleaning');
  assert.equal((await call('PATCH', '/settings', { body: { category_key: 7 } })).status, 400);
});

test('unknown path is 404 and bad json is 400', async () => {
  const r = await call('GET', '/nope');
  assert.equal(r.status, 404);
  assert.equal(r.json.reason, 'not_found');
  const bad = await call('POST', '/rooms', { raw: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.reason, 'bad_json');
  const big = await call('POST', '/rooms', { raw: JSON.stringify({ name: 'x'.repeat(70000) }) });
  assert.equal(big.status, 413);
});

test('monthly activity generation keeps month ends', async () => {
  const rid = (await call('POST', '/rooms', { body: { name: 'Attic' } })).json.data.id;
  await call('POST', `/rooms/${rid}/activities`, { body: { name: 'Dust', schedule: { interval_value: 1, interval_unit: 'months' }, first_due: '2026-01-31' } });
  const it = await call('POST', '/iterations', { body: { start_date: '2026-01-01', end_date: '2026-03-31' } });
  assert.equal(it.status, 201);
  assert.deepEqual(it.json.data.todos.filter((t) => t.activity_name === 'Dust').map((t) => t.due_date), ['2026-01-31', '2026-02-28', '2026-03-31']);
  await call('DELETE', `/iterations/${it.json.data.id}`);
  await call('DELETE', `/rooms/${rid}`);
});

test('iteration tags round trip and are validated', async () => {
  const post = (body) => call('POST', '/iterations', { body: { start_date: '2027-01-01', end_date: '2027-01-07', ...body } });
  const ok = await post({ tags: [' week-46 ', 'Deep-Clean', 'deep-clean', ''] });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.json.data.tags, ['week-46', 'Deep-Clean']);
  assert.deepEqual((await call('GET', `/iterations/${ok.json.data.id}`)).json.data.tags, ['week-46', 'Deep-Clean']);
  await call('DELETE', `/iterations/${ok.json.data.id}`);
  assert.equal((await post({ tags: 'week-46' })).json.reason, 'bad_tags');
  assert.equal((await post({ tags: ['x'.repeat(65)] })).json.reason, 'bad_tags');
  assert.equal((await post({ tags: Array.from({ length: 33 }, (_, i) => `t${i}`) })).json.reason, 'bad_tags');
  assert.equal((await post({ tags: [7] })).json.reason, 'bad_tags');
  const none = await post({});
  assert.equal(none.status, 201);
  assert.deepEqual(none.json.data.tags, []);
  await call('DELETE', `/iterations/${none.json.data.id}`);
});

test('iteration room_ids narrow generation and are validated', async () => {
  const rid = (await call('POST', '/rooms', { body: { name: 'Garage' } })).json.data.id;
  await call('POST', `/rooms/${rid}/activities`, { body: { name: 'Sweep', schedule: { interval_value: 1, interval_unit: 'days' }, first_due: '2027-02-01' } });
  const post = (body) => call('POST', '/iterations', { body: { start_date: '2027-02-01', end_date: '2027-02-03', ...body } });
  const only = await post({ room_ids: [rid] });
  assert.equal(only.status, 201);
  assert.deepEqual(only.json.data.room_ids, [rid]);
  assert.deepEqual([...new Set(only.json.data.todos.map((t) => t.room_name))], ['Garage']);
  assert.equal(only.json.data.todos.length, 3);
  assert.deepEqual((await call('GET', `/iterations/${only.json.data.id}`)).json.data.room_ids, [rid]);
  await call('DELETE', `/iterations/${only.json.data.id}`);
  assert.equal((await post({ room_ids: rid })).json.reason, 'bad_rooms');
  assert.equal((await post({ room_ids: ['x'] })).json.reason, 'bad_rooms');
  assert.equal((await post({ room_ids: [999999] })).json.reason, 'bad_rooms');
  assert.equal((await post({ room_ids: [] })).status, 201);
  const list = (await call('GET', '/iterations')).json.data;
  await call('DELETE', `/iterations/${list[0].id}`);
  await call('DELETE', `/rooms/${rid}`);
});

test('tags leave room for the two automatic tags and never use the module namespace', async () => {
  const post = (tags) => call('POST', '/iterations', { body: { start_date: '2027-03-01', end_date: '2027-03-02', tags } });
  const ok = await post(Array.from({ length: 30 }, (_, i) => `t${i}`));
  assert.equal(ok.status, 201);
  await call('DELETE', `/iterations/${ok.json.data.id}`);
  assert.equal((await post(Array.from({ length: 31 }, (_, i) => `t${i}`))).json.reason, 'bad_tags');
  assert.equal((await post(['cleaningplan'])).json.reason, 'bad_tags');
  assert.equal((await post(['CleaningPlan:3'])).json.reason, 'bad_tags');
  assert.equal((await post(['cleaningplanner'])).status, 201);
  await call('DELETE', `/iterations/${(await call('GET', '/iterations')).json.data[0].id}`);
});
