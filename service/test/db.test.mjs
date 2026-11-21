import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, listPlan, createRoom, updateRoom, deleteRoom,
  createActivity, updateActivity, deleteActivity,
  listIterations, getIteration, createIteration, linkTodoTask, deleteIteration,
  taskTitle, getSetting, setSetting,
} from '../app/db.mjs';

const vacuum = (overrides = {}) => ({
  name: 'Vacuum', interval_value: 2, interval_unit: 'days',
  default_assignee_id: 2, target_time: '18:00', first_due: '2026-11-03', ...overrides,
});

test('createRoom returns the room and listPlan nests activities under it', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  assert.equal(room.name, 'Kitchen');
  const act = createActivity(db, room.id, vacuum());
  const plan = listPlan(db);
  assert.equal(plan.rooms.length, 1);
  assert.equal(plan.rooms[0].id, room.id);
  assert.deepEqual(plan.rooms[0].activities, [act]);
  assert.deepEqual(act.schedule, { interval_value: 2, interval_unit: 'days' });
  assert.equal(act.next_due, '2026-11-03');
  assert.equal(act.active, true);
});

test('createActivity on unknown room returns null', () => {
  const db = openDb(':memory:');
  assert.equal(createActivity(db, 999, vacuum()), null);
});

test('updateActivity with first_due rewrites next_due and keeps the rest', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  const act = createActivity(db, room.id, vacuum());
  const updated = updateActivity(db, act.id, { first_due: '2026-12-01', name: 'Vacuum floor' });
  assert.equal(updated.next_due, '2026-12-01');
  assert.equal(updated.name, 'Vacuum floor');
  assert.equal(updated.target_time, '18:00');
  assert.equal(updated.default_assignee_id, 2);
  assert.deepEqual(updated.schedule, { interval_value: 2, interval_unit: 'days' });
  assert.equal(updateActivity(db, 999, { name: 'x' }), null);
});

test('updateRoom renames and returns null for unknown id', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  assert.equal(updateRoom(db, room.id, { name: 'Bath' }).name, 'Bath');
  assert.equal(updateRoom(db, 999, { name: 'x' }), null);
});

test('deleteRoom cascades its activities', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  createActivity(db, room.id, vacuum());
  assert.equal(deleteRoom(db, room.id), true);
  assert.equal(deleteRoom(db, room.id), false);
  assert.deepEqual(listPlan(db), { rooms: [] });
});

test('deleteActivity removes it', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  const act = createActivity(db, room.id, vacuum());
  assert.equal(deleteActivity(db, act.id), true);
  assert.equal(deleteActivity(db, act.id), false);
  assert.deepEqual(listPlan(db).rooms[0].activities, []);
});

test('createIteration stores one todo per generated date and advances next_due', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  const act = createActivity(db, room.id, vacuum());
  const generate = (activity, start, end) => {
    assert.equal(activity.id, act.id);
    assert.equal(start, '2026-11-03');
    assert.equal(end, '2026-11-09');
    return { dates: ['2026-11-03', '2026-11-05'], next_due: '2026-11-07' };
  };
  const it = createIteration(db, { start_date: '2026-11-03', end_date: '2026-11-09', created_by: 1, generate });
  assert.equal(it.todo_count, 2);
  assert.equal(it.linked_count, 0);
  assert.equal(it.created_by, 1);
  assert.deepEqual(it.todos.map((t) => t.due_date), ['2026-11-03', '2026-11-05']);
  for (const todo of it.todos) {
    assert.equal(todo.title, 'Kitchen: Vacuum');
    assert.equal(todo.room_name, 'Kitchen');
    assert.equal(todo.activity_name, 'Vacuum');
    assert.equal(todo.due_time, '18:00');
    assert.equal(todo.assignee_id, 2);
    assert.equal(todo.activity_id, act.id);
    assert.equal(todo.yuvomi_task_id, null);
    assert.equal(todo.iteration_id, it.id);
  }
  assert.equal(listPlan(db).rooms[0].activities[0].next_due, '2026-11-07');
  assert.deepEqual(getIteration(db, it.id), it);
  assert.equal(getIteration(db, 999), null);
});

test('createIteration skips inactive activities', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  createActivity(db, room.id, vacuum({ active: false }));
  let calls = 0;
  const it = createIteration(db, {
    start_date: '2026-11-03', end_date: '2026-11-09', created_by: 1,
    generate: () => { calls++; return { dates: ['2026-11-03'], next_due: '2026-11-05' }; },
  });
  assert.equal(calls, 0);
  assert.equal(it.todos.length, 0);
});

test('deleteIteration restores next_due and refuses a non-newest one', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  createActivity(db, room.id, vacuum());
  const gen = (a) => ({ dates: [a.next_due], next_due: '2026-11-20' });
  const first = createIteration(db, { start_date: '2026-11-03', end_date: '2026-11-09', created_by: 1, generate: gen });
  const second = createIteration(db, { start_date: '2026-11-10', end_date: '2026-11-16', created_by: 1, generate: (a) => ({ dates: [a.next_due], next_due: '2026-11-30' }) });
  assert.equal(listPlan(db).rooms[0].activities[0].next_due, '2026-11-30');
  assert.equal(deleteIteration(db, first.id), 'not_newest');
  assert.equal(deleteIteration(db, 999), 'not_found');
  assert.equal(deleteIteration(db, second.id), 'deleted');
  assert.equal(listPlan(db).rooms[0].activities[0].next_due, '2026-11-20');
  assert.equal(listIterations(db).length, 1);
  assert.equal(listIterations(db)[0].id, first.id);
});

test('listIterations is newest first with counts', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  createActivity(db, room.id, vacuum());
  const gen = (a) => ({ dates: [a.next_due], next_due: '2026-12-01' });
  const a = createIteration(db, { start_date: '2026-11-03', end_date: '2026-11-09', created_by: 1, generate: gen });
  const b = createIteration(db, { start_date: '2026-11-10', end_date: '2026-11-16', created_by: 1, generate: gen });
  const list = listIterations(db);
  assert.deepEqual(list.map((i) => i.id), [b.id, a.id]);
  assert.equal(list[1].todo_count, 1);
  assert.equal(list[1].linked_count, 0);
  assert.equal('todos' in list[0], false);
});

test('linkTodoTask sets yuvomi_task_id and returns null for a foreign iteration', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  createActivity(db, room.id, vacuum());
  const it = createIteration(db, { start_date: '2026-11-03', end_date: '2026-11-09', created_by: 1, generate: (a) => ({ dates: [a.next_due], next_due: '2026-12-01' }) });
  const todo = it.todos[0];
  const linked = linkTodoTask(db, it.id, todo.id, 41);
  assert.equal(linked.ok, true);
  assert.equal(linked.todo.yuvomi_task_id, 41);
  assert.deepEqual(linkTodoTask(db, it.id + 1, todo.id, 42), { ok: false, reason: 'not_found' });
  assert.equal(getIteration(db, it.id).linked_count, 1);
});

test('taskTitle cuts to 200 characters', () => {
  assert.equal(taskTitle('Kitchen', 'Vacuum'), 'Kitchen: Vacuum');
  const t = taskTitle('r'.repeat(150), 'a'.repeat(100));
  assert.equal(t.length, 200);
  assert.ok(t.startsWith('r'.repeat(150) + ': '));
});

test('settings round-trip', () => {
  const db = openDb(':memory:');
  assert.equal(getSetting(db, 'category_key'), null);
  setSetting(db, 'category_key', 'cleaning');
  assert.equal(getSetting(db, 'category_key'), 'cleaning');
  setSetting(db, 'category_key', 'other');
  assert.equal(getSetting(db, 'category_key'), 'other');
  assert.equal(getSetting(db, 'schema_version'), '1');
});

test('createActivity stores anchor_day from first_due and a first_due patch updates it', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  const act = createActivity(db, room.id, vacuum({ first_due: '2026-01-31', interval_unit: 'months', interval_value: 1 }));
  assert.equal(act.anchor_day, 31);
  assert.equal(updateActivity(db, act.id, { first_due: '2026-02-15' }).anchor_day, 15);
  assert.equal(updateActivity(db, act.id, { name: 'x' }).anchor_day, 15);
});

test('migrate adds anchor_day to a database created before it existed', async () => {
  const { migrate } = await import('../app/db.mjs');
  const db = openDb(':memory:');
  db.exec('ALTER TABLE activities DROP COLUMN anchor_day');
  migrate(db);
  const room = createRoom(db, { name: 'Kitchen' });
  assert.equal(createActivity(db, room.id, vacuum({ first_due: '2026-01-31' })).anchor_day, 31);
});

test('linkTodoTask refuses to relink an already linked todo', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  createActivity(db, room.id, vacuum());
  const it = createIteration(db, { start_date: '2026-11-03', end_date: '2026-11-09', created_by: 1, generate: (a) => ({ dates: [a.next_due], next_due: '2026-12-01' }) });
  const todo = it.todos[0];
  assert.deepEqual(linkTodoTask(db, it.id, todo.id, 41).ok, true);
  assert.deepEqual(linkTodoTask(db, it.id, todo.id, 42), { ok: false, reason: 'already_linked' });
  assert.equal(getIteration(db, it.id).todos[0].yuvomi_task_id, 41);
});

test('createIteration stores tags on the iteration and lists return them', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  createActivity(db, room.id, vacuum());
  const gen = (a) => ({ dates: [a.next_due], next_due: '2026-12-01' });
  const tagged = createIteration(db, { start_date: '2026-11-03', end_date: '2026-11-09', created_by: 1, tags: ['week-45', 'Deep Clean'], generate: gen });
  assert.deepEqual(tagged.tags, ['week-45', 'Deep Clean']);
  const plain = createIteration(db, { start_date: '2026-11-10', end_date: '2026-11-16', created_by: 1, generate: gen });
  assert.deepEqual(plain.tags, []);
  assert.deepEqual(listIterations(db).map((i) => i.tags), [[], ['week-45', 'Deep Clean']]);
  assert.deepEqual(getIteration(db, tagged.id).tags, ['week-45', 'Deep Clean']);
});

test('createIteration with room_ids covers only those rooms and delete restores only them', () => {
  const db = openDb(':memory:');
  const kitchen = createRoom(db, { name: 'Kitchen' });
  const bath = createRoom(db, { name: 'Bath' });
  createActivity(db, kitchen.id, vacuum({ name: 'Vacuum' }));
  createActivity(db, bath.id, vacuum({ name: 'Scrub', first_due: '2026-11-04' }));
  const gen = (a) => ({ dates: [a.next_due], next_due: '2026-12-01' });
  const it = createIteration(db, { start_date: '2026-11-03', end_date: '2026-11-09', created_by: 1, room_ids: [bath.id], generate: gen });
  assert.deepEqual(it.room_ids, [bath.id]);
  assert.deepEqual(it.todos.map((t) => t.activity_name), ['Scrub']);
  const plan = listPlan(db);
  assert.equal(plan.rooms[0].activities[0].next_due, '2026-11-03'); // kitchen untouched
  assert.equal(plan.rooms[1].activities[0].next_due, '2026-12-01');
  assert.equal(deleteIteration(db, it.id), 'deleted');
  assert.equal(listPlan(db).rooms[1].activities[0].next_due, '2026-11-04');
  const all = createIteration(db, { start_date: '2026-11-03', end_date: '2026-11-09', created_by: 1, generate: gen });
  assert.deepEqual(all.room_ids, []);
  assert.equal(all.todos.length, 2);
  assert.deepEqual(listIterations(db)[0].room_ids, []);
});

test('updateActivity keeps anchor_day when first_due equals the stored next_due', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  const act = createActivity(db, room.id, vacuum({ first_due: '2026-01-31', interval_unit: 'months', interval_value: 1 }));
  createIteration(db, { start_date: '2026-01-01', end_date: '2026-01-31', created_by: 1, generate: () => ({ dates: ['2026-01-31'], next_due: '2026-02-28' }) });
  const same = updateActivity(db, act.id, { name: 'Dust shelves', first_due: '2026-02-28' });
  assert.equal(same.anchor_day, 31);
  assert.equal(same.next_due, '2026-02-28');
  const moved = updateActivity(db, act.id, { first_due: '2026-03-15' });
  assert.equal(moved.anchor_day, 15);
});

test('migrate adds tags and room_ids to iterations of an older database', async () => {
  const { migrate } = await import('../app/db.mjs');
  const db = openDb(':memory:');
  db.exec('ALTER TABLE iterations DROP COLUMN tags');
  db.exec('ALTER TABLE iterations DROP COLUMN room_ids');
  db.exec("INSERT INTO iterations (start_date, end_date, created_by) VALUES ('2026-11-03', '2026-11-09', 1)");
  migrate(db);
  const [it] = listIterations(db);
  assert.deepEqual(it.tags, []);
  assert.deepEqual(it.room_ids, []);
  assert.deepEqual(getIteration(db, it.id).room_ids, []);
});

test('deleting a room keeps its generated todos and deleteIteration tolerates the gap', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Kitchen' });
  createActivity(db, room.id, vacuum());
  const it = createIteration(db, { start_date: '2026-11-03', end_date: '2026-11-09', created_by: 1, generate: (a) => ({ dates: [a.next_due], next_due: '2026-12-01' }) });
  assert.equal(deleteRoom(db, room.id), true);
  const kept = getIteration(db, it.id);
  assert.equal(kept.todos.length, 1);
  assert.equal(kept.todos[0].activity_id, null);
  assert.equal(kept.todos[0].room_name, 'Kitchen');
  assert.equal(deleteIteration(db, it.id), 'deleted');
});

test('activity note is stored, editable, clearable and copied onto generated todos', () => {
  const db = openDb(':memory:');
  const room = createRoom(db, { name: 'Dining' });
  const act = createActivity(db, room.id, vacuum({ name: 'Tidy table', note: '* newspapers away, glasses away' }));
  assert.equal(act.note, '* newspapers away, glasses away');
  assert.equal(createActivity(db, room.id, vacuum()).note, null);
  const generate = () => ({ dates: ['2026-11-03'], next_due: '2026-11-05' });
  const it = createIteration(db, { start_date: '2026-11-03', end_date: '2026-11-04', created_by: 1, room_ids: [room.id], generate });
  assert.equal(it.todos.find((t) => t.activity_id === act.id).note, '* newspapers away, glasses away');
  assert.equal(updateActivity(db, act.id, { note: 'only glasses' }).note, 'only glasses');
  assert.equal(updateActivity(db, act.id, { name: 'Tidy dining table' }).note, 'only glasses');
  assert.equal(updateActivity(db, act.id, { note: null }).note, null);
  // the todo keeps the note it was generated with
  assert.equal(getIteration(db, it.id).todos.find((t) => t.activity_id === act.id).note, '* newspapers away, glasses away');
});

test('migrate adds note to activities and todos of an older database', async () => {
  const { migrate } = await import('../app/db.mjs');
  const db = openDb(':memory:');
  db.exec('ALTER TABLE activities DROP COLUMN note');
  db.exec('ALTER TABLE todos DROP COLUMN note');
  migrate(db);
  const room = createRoom(db, { name: 'Kitchen' });
  assert.equal(createActivity(db, room.id, vacuum({ note: 'x' })).note, 'x');
  assert.ok(db.prepare('PRAGMA table_info(todos)').all().some((c) => c.name === 'note'));
});
