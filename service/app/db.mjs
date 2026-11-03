// Data layer of the cleaningplan sidecar: one SQLite file, every query in this file.
// Rows map to the API shapes from the design (section 5/7); booleans are 0/1 in SQLite.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE TABLE IF NOT EXISTS activities (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id             INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name                TEXT    NOT NULL,
  default_assignee_id INTEGER,
  target_time         TEXT,
  interval_value      INTEGER NOT NULL,
  interval_unit       TEXT    NOT NULL CHECK (interval_unit IN ('days', 'weeks', 'months')),
  next_due            TEXT    NOT NULL,
  anchor_day          INTEGER,
  active              INTEGER NOT NULL DEFAULT 1,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE TABLE IF NOT EXISTS iterations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date            TEXT    NOT NULL,
  end_date              TEXT    NOT NULL,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  created_by            INTEGER NOT NULL,
  activity_state_before TEXT    NOT NULL DEFAULT '{}',
  tags                  TEXT    NOT NULL DEFAULT '[]',
  room_ids              TEXT    NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS todos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  iteration_id   INTEGER NOT NULL REFERENCES iterations(id) ON DELETE CASCADE,
  activity_id    INTEGER REFERENCES activities(id) ON DELETE SET NULL,
  room_name      TEXT    NOT NULL,
  activity_name  TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  due_date       TEXT    NOT NULL,
  due_time       TEXT,
  assignee_id    INTEGER,
  yuvomi_task_id INTEGER,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS todos_yuvomi_task ON todos(yuvomi_task_id) WHERE yuvomi_task_id IS NOT NULL;
`;

// Columns added after the first release, applied to databases that predate them.
const ADDED_COLUMNS = [
  ['activities', 'anchor_day', 'INTEGER'],
  ['iterations', 'tags', "TEXT NOT NULL DEFAULT '[]'"],
  ['iterations', 'room_ids', "TEXT NOT NULL DEFAULT '[]'"],
];

const TITLE_MAX = 200;

export function migrate(db) {
  db.exec(SCHEMA);
  for (const [table, column, type] of ADDED_COLUMNS) {
    const present = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('schema_version', '1');
}

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function dayOfMonth(isoDate) {
  return Number(isoDate.slice(8, 10));
}

export function taskTitle(roomName, activityName) {
  return `${roomName}: ${activityName}`.slice(0, TITLE_MAX);
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---- rooms ----

function roomRow(row) {
  return row ? { id: row.id, name: row.name, sort_order: row.sort_order } : null;
}

function getRoom(db, id) {
  return roomRow(db.prepare('SELECT id, name, sort_order FROM rooms WHERE id = ?').get(id));
}

export function createRoom(db, { name }) {
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM rooms').get().m;
  const { lastInsertRowid } = db.prepare('INSERT INTO rooms (name, sort_order) VALUES (?, ?)').run(name, max + 1);
  return getRoom(db, Number(lastInsertRowid));
}

export function updateRoom(db, id, patch) {
  const current = getRoom(db, id);
  if (!current) return null;
  const next = { ...current, ...pick(patch, ['name', 'sort_order']) };
  db.prepare('UPDATE rooms SET name = ?, sort_order = ? WHERE id = ?').run(next.name, next.sort_order, id);
  return getRoom(db, id);
}

export function deleteRoom(db, id) {
  return db.prepare('DELETE FROM rooms WHERE id = ?').run(id).changes > 0;
}

// ---- activities ----

function activityRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    room_id: row.room_id,
    name: row.name,
    default_assignee_id: row.default_assignee_id,
    target_time: row.target_time,
    next_due: row.next_due,
    anchor_day: row.anchor_day,
    active: row.active === 1,
    sort_order: row.sort_order,
    schedule: { interval_value: row.interval_value, interval_unit: row.interval_unit },
  };
}

const ACTIVITY_SELECT = 'SELECT id, room_id, name, default_assignee_id, target_time, interval_value, interval_unit, next_due, anchor_day, active, sort_order FROM activities';

function getActivity(db, id) {
  return activityRow(db.prepare(`${ACTIVITY_SELECT} WHERE id = ?`).get(id));
}

export function createActivity(db, roomId, input) {
  if (!getRoom(db, roomId)) return null;
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM activities WHERE room_id = ?').get(roomId).m;
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO activities (room_id, name, default_assignee_id, target_time, interval_value, interval_unit, next_due, anchor_day, active, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    roomId, input.name, input.default_assignee_id ?? null, input.target_time ?? null,
    input.interval_value, input.interval_unit, input.first_due, dayOfMonth(input.first_due), input.active === false ? 0 : 1, max + 1,
  );
  return getActivity(db, Number(lastInsertRowid));
}

export function updateActivity(db, id, patch) {
  const current = db.prepare(`${ACTIVITY_SELECT} WHERE id = ?`).get(id);
  if (!current) return null;
  const next = { ...current, ...pick(patch, ['name', 'default_assignee_id', 'target_time', 'interval_value', 'interval_unit', 'sort_order']) };
  // The edit form sends the date it was shown; only a different date is a phase change
  // (re-anchoring on the clamped Feb 28 would bring back the month-end drift).
  if (patch.first_due !== undefined && patch.first_due !== current.next_due) {
    next.next_due = patch.first_due;
    next.anchor_day = dayOfMonth(patch.first_due);
  }
  if (patch.active !== undefined) next.active = patch.active ? 1 : 0;
  db.prepare(`
    UPDATE activities SET name = ?, default_assignee_id = ?, target_time = ?, interval_value = ?, interval_unit = ?,
      next_due = ?, anchor_day = ?, active = ?, sort_order = ? WHERE id = ?
  `).run(next.name, next.default_assignee_id, next.target_time, next.interval_value, next.interval_unit,
    next.next_due, next.anchor_day, next.active, next.sort_order, id);
  return getActivity(db, id);
}

export function deleteActivity(db, id) {
  return db.prepare('DELETE FROM activities WHERE id = ?').run(id).changes > 0;
}

export function listPlan(db) {
  const rooms = db.prepare('SELECT id, name, sort_order FROM rooms ORDER BY sort_order, id').all().map(roomRow);
  const byRoom = new Map(rooms.map((r) => [r.id, []]));
  for (const row of db.prepare(`${ACTIVITY_SELECT} ORDER BY sort_order, id`).all()) {
    byRoom.get(row.room_id)?.push(activityRow(row));
  }
  return { rooms: rooms.map((r) => ({ ...r, activities: byRoom.get(r.id) })) };
}

// ---- iterations and todos ----

const ITERATION_SELECT = `
  SELECT i.id, i.start_date, i.end_date, i.created_at, i.created_by, i.tags, i.room_ids,
         (SELECT COUNT(*) FROM todos t WHERE t.iteration_id = i.id) AS todo_count,
         (SELECT COUNT(*) FROM todos t WHERE t.iteration_id = i.id AND t.yuvomi_task_id IS NOT NULL) AS linked_count
  FROM iterations i`;

function todoRow(row) {
  return {
    id: row.id, iteration_id: row.iteration_id, activity_id: row.activity_id,
    room_name: row.room_name, activity_name: row.activity_name, title: row.title,
    due_date: row.due_date, due_time: row.due_time, assignee_id: row.assignee_id,
    yuvomi_task_id: row.yuvomi_task_id,
  };
}

const TODO_SELECT = 'SELECT id, iteration_id, activity_id, room_name, activity_name, title, due_date, due_time, assignee_id, yuvomi_task_id FROM todos';

function jsonArray(text) {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; }
}

// `room_ids` empty means "every room"; otherwise the rooms this iteration covered.
function iterationRow(row) {
  return { ...row, tags: jsonArray(row.tags), room_ids: jsonArray(row.room_ids) };
}

export function listIterations(db) {
  return db.prepare(`${ITERATION_SELECT} ORDER BY i.id DESC`).all().map(iterationRow);
}

export function getIteration(db, id) {
  const row = db.prepare(`${ITERATION_SELECT} WHERE i.id = ?`).get(id);
  if (!row) return null;
  const todos = db.prepare(`${TODO_SELECT} WHERE iteration_id = ? ORDER BY due_date, due_time IS NULL, due_time, id`).all(id).map(todoRow);
  return { ...iterationRow(row), todos };
}

export function createIteration(db, { start_date, end_date, created_by, tags = [], room_ids = [], generate }) {
  return transaction(db, () => {
    const plan = listPlan(db);
    const rooms = room_ids.length ? plan.rooms.filter((room) => room_ids.includes(room.id)) : plan.rooms;
    const active = rooms.flatMap((room) => room.activities.filter((a) => a.active).map((a) => ({ room, activity: a })));
    const snapshot = Object.fromEntries(active.map(({ activity }) => [activity.id, activity.next_due]));
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO iterations (start_date, end_date, created_by, activity_state_before, tags, room_ids) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(start_date, end_date, created_by, JSON.stringify(snapshot), JSON.stringify(tags), JSON.stringify(room_ids));
    const iterationId = Number(lastInsertRowid);
    const insertTodo = db.prepare(`
      INSERT INTO todos (iteration_id, activity_id, room_name, activity_name, title, due_date, due_time, assignee_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const advance = db.prepare('UPDATE activities SET next_due = ? WHERE id = ?');
    for (const { room, activity } of active) {
      const { dates, next_due } = generate(activity, start_date, end_date);
      for (const date of dates) {
        insertTodo.run(iterationId, activity.id, room.name, activity.name, taskTitle(room.name, activity.name),
          date, activity.target_time, activity.default_assignee_id);
      }
      advance.run(next_due, activity.id);
    }
    return getIteration(db, iterationId);
  });
}

// Links a todo to the Yuvomi task made for it. A todo is linked once: a second writer
// (double click, second tab) gets `already_linked` and must drop the task it created.
export function linkTodoTask(db, iterationId, todoId, yuvomiTaskId) {
  const changed = db.prepare('UPDATE todos SET yuvomi_task_id = ? WHERE id = ? AND iteration_id = ? AND yuvomi_task_id IS NULL')
    .run(yuvomiTaskId, todoId, iterationId).changes;
  if (changed) return { ok: true, todo: todoRow(db.prepare(`${TODO_SELECT} WHERE id = ?`).get(todoId)) };
  const exists = db.prepare('SELECT 1 FROM todos WHERE id = ? AND iteration_id = ?').get(todoId, iterationId);
  return { ok: false, reason: exists ? 'already_linked' : 'not_found' };
}

export function deleteIteration(db, id) {
  return transaction(db, () => {
    const row = db.prepare('SELECT id, activity_state_before FROM iterations WHERE id = ?').get(id);
    if (!row) return 'not_found';
    const newest = db.prepare('SELECT MAX(id) AS id FROM iterations').get().id;
    if (newest !== id) return 'not_newest';
    const restore = db.prepare('UPDATE activities SET next_due = ? WHERE id = ?');
    for (const [activityId, nextDue] of Object.entries(JSON.parse(row.activity_state_before))) {
      restore.run(nextDue, Number(activityId));
    }
    db.prepare('DELETE FROM iterations WHERE id = ?').run(id);
    return 'deleted';
  });
}

// ---- settings ----

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
