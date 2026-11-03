// Everything the page does against Yuvomi's own task API for generated to-dos.
// `deps` exists so Node tests can hand in fakes; the browser uses the real modules.
import { api } from '/api.js';
import { t } from '/i18n.js';
import { ext } from './client.js';

export const TAG = 'cleaningplan';
const realDeps = () => ({ api, ext });
const iterationTag = (iterationId) => `${TAG}:${iterationId}`;

async function findCategory(name, { api, signal }) {
  const { data } = await api.get('/tasks/categories', { signal });
  return data.find((c) => String(c.name || c.key).toLowerCase() === name.toLowerCase())?.key ?? null;
}

// The stored key is checked against Yuvomi every time: a restored backup or a deleted
// category would otherwise make every task creation fail with nothing to reset.
export async function ensureCategoryKey({ signal, deps = realDeps() } = {}) {
  const settings = await deps.ext.get('/settings', { signal });
  const { data: categories } = await deps.api.get('/tasks/categories', { signal });
  if (settings.category_key && categories.some((c) => c.key === settings.category_key)) return settings.category_key;
  const name = t('extensions.cleaningplan.category.name');
  let key = categories.find((c) => String(c.name || c.key).toLowerCase() === name.toLowerCase())?.key ?? null;
  if (!key) {
    try {
      key = (await deps.api.post('/tasks/categories', { name }, { signal })).data.key;
    } catch (err) {
      if (err.status !== 409) throw err;
      key = await findCategory(name, { api: deps.api, signal });
      if (!key) throw err;
    }
  }
  await deps.ext.patch('/settings', { category_key: key }, { signal });
  return key;
}

export async function createTaskForTodo(todo, { iterationId, categoryKey, tags = [], members = null, signal, deps = realDeps() }) {
  const body = {
    title: todo.title,
    due_date: todo.due_date,
    category: categoryKey,
    tags: [TAG, iterationTag(iterationId), ...tags],
    description: t('extensions.cleaningplan.task.description', { room: todo.room_name, activity: todo.activity_name }),
  };
  if (todo.due_time) body.due_time = todo.due_time;
  // A default person who has left the household would make Yuvomi refuse the task (400).
  const stillMember = !members || members.some((m) => m.id === todo.assignee_id);
  if (todo.assignee_id && stillMember) body.assigned_to = todo.assignee_id;
  return (await deps.api.post('/tasks', body, { signal })).data.id;
}

export async function fetchIterationTasks(iterationId, { signal, deps = realDeps() } = {}) {
  const { data } = await deps.api.get(`/tasks?tag=${encodeURIComponent(iterationTag(iterationId))}&archived=1`, { signal });
  return new Map(data.map((task) => [task.id, task]));
}

// The completion feed is household-wide and newest first, 200 per page. Pages are followed
// until every wanted task id has been seen (or the feed ends), so an older iteration keeps
// its "done by" names; `wanted` is the set of the open iteration's done task ids.
export async function fetchCompletions({ wanted = new Set(), signal, deps = realDeps(), maxPages = 25 } = {}) {
  const byTask = new Map();
  const missing = new Set(wanted);
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const query = cursor ? `&before_at=${encodeURIComponent(cursor.before_at)}&before_id=${cursor.before_id}` : '';
    const res = await deps.api.get(`/tasks/completions?limit=200${query}`, { signal });
    for (const row of res.data) {
      if (!byTask.has(row.task_id)) byTask.set(row.task_id, row);
      missing.delete(row.task_id);
    }
    if (!missing.size || !res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return byTask;
}

// Creates a Yuvomi task for every todo without one, sequentially, and records the id.
// A task that already exists for the iteration with the same title and date (left by an
// earlier run that was cut off between create and link) is linked instead of duplicated.
export async function createMissingTasks(iteration, { categoryKey, members = null, signal, onProgress, deps = realDeps() }) {
  const missing = iteration.todos.filter((todo) => todo.yuvomi_task_id === null || todo.yuvomi_task_id === undefined);
  const progress = { created: 0, failed: 0, total: missing.length };
  let error = null;
  if (!missing.length) return { created: 0, failed: 0, error };

  const existing = await fetchIterationTasks(iteration.id, { signal, deps });
  const linked = new Set(iteration.todos.map((todo) => todo.yuvomi_task_id).filter((id) => id !== null && id !== undefined));
  const orphans = [...existing.values()].filter((task) => !linked.has(task.id));

  for (const todo of missing) {
    if (signal?.aborted) break;
    let createdId = null;
    try {
      const orphanIndex = orphans.findIndex((task) => task.title === todo.title && task.due_date === todo.due_date && (task.due_time ?? null) === (todo.due_time ?? null));
      const taskId = orphanIndex >= 0
        ? orphans.splice(orphanIndex, 1)[0].id
        : (createdId = await createTaskForTodo(todo, { iterationId: iteration.id, categoryKey, tags: iteration.tags ?? [], members, signal, deps }));
      await deps.ext.patch(`/iterations/${iteration.id}/todos/${todo.id}`, { yuvomi_task_id: taskId }, { signal });
      progress.created += 1;
    } catch (err) {
      if (signal?.aborted) break;
      if (err.status === 409 && err.reason === 'already_linked') {
        // Somebody else linked this todo first (double click, second tab): our task is surplus.
        if (createdId !== null) await deps.api.delete(`/tasks/${createdId}`, { signal }).catch(() => {});
        progress.total -= 1;
      } else {
        progress.failed += 1;
        error ??= { message: err.message, status: err.status ?? null };
      }
    }
    onProgress?.(progress);
  }
  return { created: progress.created, failed: progress.failed, error };
}

// Always works from a fresh fetch: a map taken when the iteration was opened may call a
// task "open" that somebody has since completed, and deleting it would erase that history.
export async function deleteIterationOpenTasks(iterationId, { signal, deps = realDeps() } = {}) {
  const tasks = await fetchIterationTasks(iterationId, { signal, deps });
  await deleteOpenTasks(tasks, { signal, deps });
}

export async function deleteOpenTasks(tasksById, { signal, deps = realDeps() } = {}) {
  for (const task of tasksById.values()) {
    if (task.status === 'done') continue;
    await deps.api.delete(`/tasks/${task.id}`, { signal });
  }
}
