import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureCategoryKey, createMissingTasks, fetchIterationTasks, fetchCompletions, deleteOpenTasks } from '../../modules/cleaningplan/lib/yuvomi-tasks.js';

function fakes({ categoryKey = null, categories = [], postCategory = null, completions = [], tasks = [] } = {}) {
  const calls = [];
  const api = {
    get: async (path) => {
      calls.push(['api.get', path]);
      if (path === '/tasks/categories') return { data: categories };
      if (path.startsWith('/tasks/completions')) return { data: completions };
      if (path.startsWith('/tasks?')) return { data: tasks };
      throw new Error(`unexpected get ${path}`);
    },
    post: async (path, body) => {
      calls.push(['api.post', path, body]);
      if (path === '/tasks/categories') { if (postCategory instanceof Error) throw postCategory; return { data: postCategory }; }
      if (path === '/tasks') { if (body.title.includes('FAIL')) throw new Error('boom'); return { data: { id: 100 + calls.length } }; }
      throw new Error(`unexpected post ${path}`);
    },
    delete: async (path) => { calls.push(['api.delete', path]); return { data: {} }; },
  };
  const ext = {
    get: async (path) => { calls.push(['ext.get', path]); if (path === '/settings') return { category_key: categoryKey }; throw new Error('unexpected'); },
    patch: async (path, body) => { calls.push(['ext.patch', path, body]); return body; },
  };
  return { api, ext, calls };
}

test('ensureCategoryKey returns the stored key once Yuvomi confirms it still exists', async () => {
  const d = fakes({ categoryKey: 'cleaning', categories: [{ key: 'cleaning', name: 'Cleaning' }] });
  assert.equal(await ensureCategoryKey({ deps: d }), 'cleaning');
  assert.deepEqual(d.calls.map((c) => c[0]), ['ext.get', 'api.get']);
});

test('ensureCategoryKey finds an existing category by name and stores it', async () => {
  const d = fakes({ categories: [{ key: 'misc', name: 'Misc' }, { key: 'cleaning', name: 'extensions.cleaningplan.category.name' }] });
  assert.equal(await ensureCategoryKey({ deps: d }), 'cleaning');
  assert.deepEqual(d.calls.at(-1), ['ext.patch', '/settings', { category_key: 'cleaning' }]);
  assert.ok(!d.calls.some((c) => c[0] === 'api.post'));
});

test('ensureCategoryKey creates the category when missing', async () => {
  const d = fakes({ categories: [{ key: 'misc', name: 'Misc' }], postCategory: { key: 'cleaning-2', name: 'Cleaning' } });
  assert.equal(await ensureCategoryKey({ deps: d }), 'cleaning-2');
  assert.deepEqual(d.calls.find((c) => c[0] === 'api.post'), ['api.post', '/tasks/categories', { name: 'extensions.cleaningplan.category.name' }]);
});

test('createMissingTasks creates only unlinked todos and links each', async () => {
  const d = fakes();
  const iteration = { id: 7, todos: [
    { id: 1, title: 'Kitchen: Vacuum', room_name: 'Kitchen', activity_name: 'Vacuum', due_date: '2026-11-03', due_time: '18:00', assignee_id: 2, yuvomi_task_id: 41 },
    { id: 2, title: 'Kitchen: Wipe', room_name: 'Kitchen', activity_name: 'Wipe', due_date: '2026-11-03', due_time: null, assignee_id: null, yuvomi_task_id: null },
    { id: 3, title: 'Kitchen: FAIL', room_name: 'Kitchen', activity_name: 'FAIL', due_date: '2026-11-04', due_time: null, assignee_id: null, yuvomi_task_id: null },
    { id: 4, title: 'Bath: Scrub', room_name: 'Bath', activity_name: 'Scrub', due_date: '2026-11-05', due_time: '09:30', assignee_id: 3, yuvomi_task_id: null },
  ] };
  const progress = [];
  const result = await createMissingTasks(iteration, { categoryKey: 'cleaning', onProgress: (p) => progress.push({ ...p }), deps: d });
  assert.deepEqual(result, { created: 2, failed: 1, error: { message: 'boom', status: null } });
  const posts = d.calls.filter((c) => c[0] === 'api.post');
  assert.equal(posts.length, 3);
  assert.deepEqual(posts[0][2], {
    title: 'Kitchen: Wipe', due_date: '2026-11-03', category: 'cleaning',
    tags: ['cleaningplan', 'cleaningplan:7'], description: 'extensions.cleaningplan.task.description(room=Kitchen,activity=Wipe)',
  });
  assert.deepEqual(posts[2][2].assigned_to, 3);
  assert.equal(posts[2][2].due_time, '09:30');
  const links = d.calls.filter((c) => c[0] === 'ext.patch');
  assert.deepEqual(links.map((l) => l[1]), ['/iterations/7/todos/2', '/iterations/7/todos/4']);
  assert.ok(links.every((l) => Number.isInteger(l[2].yuvomi_task_id)));
  assert.deepEqual(progress.at(-1), { created: 2, failed: 1, total: 3 });
});

test('createMissingTasks relinks an orphan task with the same title and date instead of creating it again', async () => {
  const d = fakes({ tasks: [{ id: 77, status: 'open', title: 'Kitchen: Wipe', due_date: '2026-11-03', due_time: null }, { id: 41, status: 'done', title: 'Kitchen: Vacuum', due_date: '2026-11-03', due_time: '18:00' }] });
  const iteration = { id: 7, todos: [
    { id: 1, title: 'Kitchen: Vacuum', room_name: 'Kitchen', activity_name: 'Vacuum', due_date: '2026-11-03', due_time: '18:00', assignee_id: 2, yuvomi_task_id: 41 },
    { id: 2, title: 'Kitchen: Wipe', room_name: 'Kitchen', activity_name: 'Wipe', due_date: '2026-11-03', due_time: null, assignee_id: null, yuvomi_task_id: null },
  ] };
  const result = await createMissingTasks(iteration, { categoryKey: 'cleaning', deps: d });
  assert.deepEqual(result, { created: 1, failed: 0, error: null });
  assert.ok(!d.calls.some((c) => c[0] === 'api.post'));
  assert.deepEqual(d.calls.find((c) => c[0] === 'ext.patch'), ['ext.patch', '/iterations/7/todos/2', { yuvomi_task_id: 77 }]);
});

test('fetchIterationTasks and fetchCompletions build maps', async () => {
  const d = fakes({
    tasks: [{ id: 41, status: 'done' }, { id: 42, status: 'open' }],
    completions: [{ task_id: 41, completed_at: '2026-11-10T13:02:00Z', person_name: 'Kim' }, { task_id: 41, completed_at: '2026-11-01T00:00:00Z', person_name: 'Old' }],
  });
  const tasks = await fetchIterationTasks(7, { deps: d });
  assert.equal(tasks.get(42).status, 'open');
  assert.ok(d.calls[0][1].includes('tag=cleaningplan%3A7'));
  const comps = await fetchCompletions({ deps: d });
  assert.equal(comps.get(41).person_name, 'Kim');
});

test('deleteOpenTasks leaves done tasks alone', async () => {
  const d = fakes();
  await deleteOpenTasks(new Map([[41, { id: 41, status: 'done' }], [42, { id: 42, status: 'open' }], [43, { id: 43, status: 'in_progress' }]]), { deps: d });
  assert.deepEqual(d.calls.map((c) => c[1]).sort(), ['/tasks/42', '/tasks/43']);
});

test('ensureCategoryKey re-validates a stored key that no longer exists', async () => {
  const d = fakes({ categoryKey: 'gone', categories: [{ key: 'misc', name: 'Misc' }], postCategory: { key: 'cleaning', name: 'Cleaning' } });
  assert.equal(await ensureCategoryKey({ deps: d }), 'cleaning');
  assert.deepEqual(d.calls.at(-1), ['ext.patch', '/settings', { category_key: 'cleaning' }]);
});

test('createMissingTasks reports the first error it swallowed', async () => {
  const d = fakes();
  const iteration = { id: 7, todos: [
    { id: 3, title: 'Kitchen: FAIL', room_name: 'Kitchen', activity_name: 'FAIL', due_date: '2026-11-04', due_time: null, assignee_id: null, yuvomi_task_id: null },
  ] };
  const result = await createMissingTasks(iteration, { categoryKey: 'cleaning', deps: d });
  assert.equal(result.failed, 1);
  assert.equal(result.error.message, 'boom');
});

test('createMissingTasks removes the task it just created when the link answers already_linked', async () => {
  const d = fakes();
  const realPatch = d.ext.patch;
  d.ext.patch = async (path, body) => {
    if (path.endsWith('/todos/2')) { const e = new Error('already_linked'); e.status = 409; e.reason = 'already_linked'; throw e; }
    return realPatch(path, body);
  };
  const iteration = { id: 7, todos: [
    { id: 2, title: 'Kitchen: Wipe', room_name: 'Kitchen', activity_name: 'Wipe', due_date: '2026-11-03', due_time: null, assignee_id: null, yuvomi_task_id: null },
  ] };
  const result = await createMissingTasks(iteration, { categoryKey: 'cleaning', deps: d });
  assert.deepEqual({ created: result.created, failed: result.failed }, { created: 0, failed: 0 });
  const created = d.calls.find((c) => c[0] === 'api.post' && c[1] === '/tasks');
  assert.ok(created);
  assert.ok(d.calls.some((c) => c[0] === 'api.delete' && /^\/tasks\/\d+$/.test(c[1])));
});

test('deleteIterationOpenTasks fetches the current tasks and deletes only open ones', async () => {
  const { deleteIterationOpenTasks } = await import('../../modules/cleaningplan/lib/yuvomi-tasks.js');
  const d = fakes({ tasks: [{ id: 41, status: 'done' }, { id: 42, status: 'open' }, { id: 43, status: 'in_progress' }] });
  await deleteIterationOpenTasks(7, { deps: d });
  assert.ok(d.calls[0][0] === 'api.get' && d.calls[0][1].includes('tag=cleaningplan%3A7'));
  assert.deepEqual(d.calls.filter((c) => c[0] === 'api.delete').map((c) => c[1]).sort(), ['/tasks/42', '/tasks/43']);
});

test('createMissingTasks adds the iteration tags after the automatic ones', async () => {
  const d = fakes();
  const iteration = { id: 7, tags: ['week-46', 'Deep Clean'], todos: [
    { id: 2, title: 'Kitchen: Wipe', room_name: 'Kitchen', activity_name: 'Wipe', due_date: '2026-11-03', due_time: null, assignee_id: null, yuvomi_task_id: null },
  ] };
  await createMissingTasks(iteration, { categoryKey: 'cleaning', deps: d });
  const post = d.calls.find((c) => c[0] === 'api.post' && c[1] === '/tasks');
  assert.deepEqual(post[2].tags, ['cleaningplan', 'cleaningplan:7', 'week-46', 'Deep Clean']);
});

test('createMissingTasks drops an assignee who is no longer a member', async () => {
  const d = fakes();
  const iteration = { id: 7, todos: [
    { id: 2, title: 'Kitchen: Wipe', room_name: 'Kitchen', activity_name: 'Wipe', due_date: '2026-11-03', due_time: null, assignee_id: 9, yuvomi_task_id: null },
    { id: 3, title: 'Kitchen: Vac', room_name: 'Kitchen', activity_name: 'Vac', due_date: '2026-11-03', due_time: null, assignee_id: 2, yuvomi_task_id: null },
  ] };
  await createMissingTasks(iteration, { categoryKey: 'cleaning', members: [{ id: 2, display_name: 'Sam' }], deps: d });
  const posts = d.calls.filter((c) => c[0] === 'api.post' && c[1] === '/tasks').map((c) => c[2]);
  assert.equal('assigned_to' in posts[0], false);
  assert.equal(posts[1].assigned_to, 2);
});

test('fetchCompletions follows the cursor until the wanted tasks are resolved', async () => {
  const pages = [
    { data: [{ task_id: 50, completed_at: '2026-11-20T10:00:00Z', person_name: 'A' }], has_more: true, next_cursor: { before_at: '2026-11-20T10:00:00Z', before_id: 50 } },
    { data: [{ task_id: 41, completed_at: '2026-11-10T10:00:00Z', person_name: 'Kim' }], has_more: true, next_cursor: { before_at: '2026-11-10T10:00:00Z', before_id: 41 } },
    { data: [{ task_id: 1, completed_at: '2026-10-01T10:00:00Z', person_name: 'Old' }], has_more: false, next_cursor: null },
  ];
  const calls = [];
  const api = { get: async (path) => { calls.push(path); return pages.shift(); } };
  const comps = await fetchCompletions({ wanted: new Set([41]), deps: { api, ext: {} } });
  assert.equal(comps.get(41).person_name, 'Kim');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('before_id=50'));
});
