import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderIterationsSection } from '../../modules/cleaningplan/lib/iterations-view.js';

const members = [{ id: 2, display_name: 'Sam' }, { id: 3, display_name: 'Kim' }];
const iterations = [
  { id: 2, start_date: '2026-11-10', end_date: '2026-11-16', todo_count: 3, linked_count: 2 },
  { id: 1, start_date: '2026-11-03', end_date: '2026-11-09', todo_count: 11, linked_count: 11 },
];
const open = {
  ...iterations[0],
  todos: [
    { id: 21, due_date: '2026-11-10', due_time: '18:00', title: 'Kitchen: Vacuum', room_name: 'Kitchen', activity_name: 'Vacuum', assignee_id: 2, yuvomi_task_id: 41 },
    { id: 22, due_date: '2026-11-10', due_time: null, title: 'Kitchen: <Wipe>', room_name: 'Kitchen', activity_name: '<Wipe>', assignee_id: null, yuvomi_task_id: 42 },
    { id: 23, due_date: '2026-11-11', due_time: null, title: 'Kitchen: <Wipe>', room_name: 'Kitchen', activity_name: '<Wipe>', assignee_id: null, yuvomi_task_id: null },
  ],
};
const tasksById = new Map([[41, { id: 41, status: 'done' }], [42, { id: 42, status: 'open' }]]);
const completions = new Map([[41, { task_id: 41, completed_at: '2026-11-10T13:02:00Z', person_name: 'Kim' }]]);
const base = { iterations, open: null, tasksById: new Map(), completions: new Map(), members, canWrite: true, generating: false, progress: null };

test('empty list shows the empty state', () => {
  const html = renderIterationsSection({ ...base, iterations: [] });
  assert.ok(html.includes('empty-state'));
  assert.ok(html.includes('extensions.cleaningplan.iterations.empty.title'));
});

test('list rows show window, counts and an open control', () => {
  const html = renderIterationsSection(base);
  assert.ok(html.includes('2026-11-03') && html.includes('2026-11-09'));
  assert.ok(html.includes('extensions.cleaningplan.iterations.todos(n=11)'));
  assert.ok(html.includes('extensions.cleaningplan.iterations.linked(n=2,total=3)'));
  assert.equal((html.match(/data-action="open-iteration"/g) || []).length, 2);
});

test('open iteration renders days, states, assignee and completion', () => {
  const html = renderIterationsSection({ ...base, open, tasksById, completions });
  assert.ok(html.includes('data-state="done"') && html.includes('data-state="open"') && html.includes('data-state="missing"'));
  assert.ok(html.includes('extensions.cleaningplan.todo.doneBy(name=Kim,'));
  assert.ok(html.includes('Sam'));
  assert.ok(html.includes('Kitchen: &lt;Wipe&gt;') && !html.includes('<Wipe>'));
  assert.ok(html.includes('extensions.cleaningplan.todo.missing'));
  assert.ok(html.includes('extensions.cleaningplan.iterations.done(n=1)'));
  assert.ok(html.includes('data-action="create-missing"'));
  assert.ok(html.includes('extensions.cleaningplan.iterations.createMissing(n=1)'));
  assert.ok(html.includes('data-action="delete-iteration"'));
  const dayHeadings = html.match(/class="cleaningplan-day__title"/g) || [];
  assert.equal(dayHeadings.length, 2);
});

test('removed task state and no missing button when all linked', () => {
  const allLinked = { ...open, todos: open.todos.filter((t) => t.yuvomi_task_id !== null) };
  const html = renderIterationsSection({ ...base, open: allLinked, tasksById: new Map([[41, { id: 41, status: 'done' }]]), completions });
  assert.ok(html.includes('data-state="removed"'));
  assert.ok(!html.includes('data-action="create-missing"'));
});

test('delete only on the newest iteration', () => {
  const older = { ...iterations[1], todos: [] };
  const html = renderIterationsSection({ ...base, open: older });
  assert.ok(!html.includes('data-action="delete-iteration"'));
});

test('read access shows no mutating controls but can open', () => {
  const html = renderIterationsSection({ ...base, open, tasksById, completions, canWrite: false });
  assert.ok(!html.includes('data-action="create-missing"') && !html.includes('data-action="delete-iteration"') && !html.includes('data-action="generate"'));
  assert.ok(html.includes('data-action="open-iteration"'));
});

test('generate form defaults to the day after the newest iteration', () => {
  const html = renderIterationsSection({ ...base, generating: true });
  assert.ok(html.includes('data-form="generate"'));
  assert.ok(html.includes('name="start_date"') && html.includes('value="2026-11-17"'));
  assert.ok(/<option value="7" selected>/.test(html) && html.includes('<option value="14">') && html.includes('<option value="28">'));
  const fresh = renderIterationsSection({ ...base, iterations: [], generating: true });
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.ok(fresh.includes(`value="${tomorrow}"`));
});

test('progress replaces the generate button while creating tasks', () => {
  const html = renderIterationsSection({ ...base, progress: { created: 3, total: 11 } });
  assert.ok(html.includes('extensions.cleaningplan.iterations.progress(created=3,total=11)'));
});

test('busy disables the generate control and the detail actions', () => {
  const html = renderIterationsSection({ ...base, open, tasksById, completions, busy: true });
  assert.ok(/data-action="generate"[^>]*disabled/.test(html) || /disabled[^>]*data-action="generate"/.test(html));
  assert.ok(/data-action="create-missing"[^>]*disabled/.test(html) || /disabled[^>]*data-action="create-missing"/.test(html));
  assert.ok(/data-action="delete-iteration"[^>]*disabled/.test(html) || /disabled[^>]*data-action="delete-iteration"/.test(html));
  const idle = renderIterationsSection({ ...base, open, tasksById, completions, busy: false });
  assert.ok(!/data-action="generate"[^>]*disabled/.test(idle));
});

test('generate form has a tags field and rows show the iteration tags escaped', () => {
  const html = renderIterationsSection({ ...base, generating: true });
  assert.ok(html.includes('name="tags"'));
  assert.ok(html.includes('extensions.cleaningplan.iterations.tags'));
  const tagged = { ...iterations[0], tags: ['week-46', '<b>x</b>'] };
  const rows = renderIterationsSection({ ...base, iterations: [tagged, iterations[1]] });
  assert.ok(rows.includes('week-46'));
  assert.ok(rows.includes('&lt;b&gt;x&lt;/b&gt;') && !rows.includes('<b>x</b>'));
});

test('generate form lists every room as a ticked checkbox and rows name covered rooms', () => {
  const rooms = [{ id: 1, name: 'Kitchen <1>' }, { id: 2, name: 'Bath' }];
  const html = renderIterationsSection({ ...base, rooms, generating: true });
  assert.equal((html.match(/name="room_ids"/g) || []).length, 2);
  assert.ok(/name="room_ids" value="1" checked/.test(html) && /name="room_ids" value="2" checked/.test(html));
  assert.ok(html.includes('Kitchen &lt;1&gt;'));
  const narrowed = { ...iterations[0], room_ids: [2] };
  const rows = renderIterationsSection({ ...base, rooms, iterations: [narrowed, iterations[1]] });
  assert.ok(rows.includes('extensions.cleaningplan.iterations.rooms(names=Bath)'));
  assert.ok(!rows.includes('iterations.rooms(names=Kitchen'));
});

test('form controls use Yuvomi classes, submit is disabled while busy, done rows degrade without a person', () => {
  const html = renderIterationsSection({ ...base, generating: true, busy: true });
  assert.ok(!html.includes('class="select"'));
  assert.ok(/<select class="input"/.test(html));
  assert.ok(/<button type="submit"[^>]*disabled/.test(html));
  const noPerson = new Map([[41, { task_id: 41, completed_at: '2026-11-10T13:02:00Z', person_name: null, user_name: null }]]);
  const rows = renderIterationsSection({ ...base, open, tasksById, completions: noPerson });
  assert.ok(rows.includes('extensions.cleaningplan.todo.doneAt('));
  assert.ok(!rows.includes('todo.doneBy(name=,'));
  assert.ok(rows.includes('check-ring check-ring--static'));
});
