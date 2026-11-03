import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByDay, todoState, scheduleLabel, memberName } from '../../modules/cleaningplan/lib/format.js';

const todo = (id, due_date, due_time = null, extra = {}) => ({ id, due_date, due_time, yuvomi_task_id: null, ...extra });

test('groupByDay sorts by date, time then id, nulls last', () => {
  const groups = groupByDay([
    todo(5, '2026-11-04', null),
    todo(3, '2026-11-03', '18:00'),
    todo(4, '2026-11-04', '09:00'),
    todo(2, '2026-11-03', null),
    todo(1, '2026-11-03', '08:30'),
  ]);
  assert.deepEqual(groups.map((g) => g.date), ['2026-11-03', '2026-11-04']);
  assert.deepEqual(groups[0].todos.map((t) => t.id), [1, 3, 2]);
  assert.deepEqual(groups[1].todos.map((t) => t.id), [4, 5]);
  assert.deepEqual(groupByDay([]), []);
});

test('todoState covers missing, removed, open, done', () => {
  const tasks = new Map([[41, { id: 41, status: 'done' }], [42, { id: 42, status: 'open' }], [43, { id: 43, status: 'in_progress' }]]);
  assert.equal(todoState(todo(1, '2026-11-03'), tasks), 'missing');
  assert.equal(todoState(todo(2, '2026-11-03', null, { yuvomi_task_id: 99 }), tasks), 'removed');
  assert.equal(todoState(todo(3, '2026-11-03', null, { yuvomi_task_id: 42 }), tasks), 'open');
  assert.equal(todoState(todo(4, '2026-11-03', null, { yuvomi_task_id: 43 }), tasks), 'open');
  assert.equal(todoState(todo(5, '2026-11-03', null, { yuvomi_task_id: 41 }), tasks), 'done');
});

test('scheduleLabel calls t with the unit key and n', () => {
  const t = (key, params) => `${key}|${JSON.stringify(params)}`;
  assert.equal(scheduleLabel({ interval_value: 2, interval_unit: 'days' }, t), 'extensions.cleaningplan.every.days|{"n":2}');
  assert.equal(scheduleLabel({ interval_value: 1, interval_unit: 'weeks' }, t), 'extensions.cleaningplan.every.weeks|{"n":1}');
});

test('memberName resolves display_name or empty', () => {
  const members = [{ id: 2, display_name: 'Sam' }, { id: 3, display_name: 'Kim' }];
  assert.equal(memberName(3, members), 'Kim');
  assert.equal(memberName(9, members), '');
  assert.equal(memberName(null, members), '');
});

test('parseTags splits a comma list, trims, drops empties and case-duplicates', async () => {
  const { parseTags } = await import('../../modules/cleaningplan/lib/format.js');
  assert.deepEqual(parseTags(' week-46, Deep Clean ,,deep clean , '), ['week-46', 'Deep Clean']);
  assert.deepEqual(parseTags(''), []);
  assert.deepEqual(parseTags(undefined), []);
});

test('roomNames resolves ids against the plan and skips unknown ones', async () => {
  const { roomNames } = await import('../../modules/cleaningplan/lib/format.js');
  const rooms = [{ id: 1, name: 'Kitchen' }, { id: 2, name: 'Bath' }];
  assert.deepEqual(roomNames([2, 1, 9], rooms), ['Bath', 'Kitchen']);
  assert.deepEqual(roomNames([], rooms), []);
});

test('buildGenerateRequest derives the window, tags and room limit', async () => {
  const { buildGenerateRequest, parseTags } = await import('../../modules/cleaningplan/lib/format.js');
  const r = buildGenerateRequest({ start_date: '2026-11-03', length: 7, tags: 'week-46, x', roomIds: [1, 2], roomCount: 2 });
  assert.deepEqual(r, { start_date: '2026-11-03', end_date: '2026-11-09', tags: ['week-46', 'x'], room_ids: [], no_rooms: false });
  assert.deepEqual(buildGenerateRequest({ start_date: '2026-11-03', length: 14, tags: '', roomIds: [2], roomCount: 3 }).room_ids, [2]);
  assert.equal(buildGenerateRequest({ start_date: '2026-11-03', length: 7, tags: '', roomIds: [], roomCount: 2 }).no_rooms, true);
  assert.equal(buildGenerateRequest({ start_date: '2026-11-03', length: 7, tags: '', roomIds: [], roomCount: 0 }).no_rooms, false);
  assert.deepEqual(parseTags('cleaningplan, cleaningplan:4, ok'), ['ok']);
});
