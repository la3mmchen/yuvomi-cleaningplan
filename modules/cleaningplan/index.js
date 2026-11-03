// Page entry: loads access, plan, members and iterations; owns the page state; renders
// the Plan and the Iterations section into two stable mounts and wires their handlers.
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderPageHeader, renderPageTitle, renderPageBody, renderPageSection } from '/utils/page-layout.js';
import { mountLoadError } from '/utils/empty-state.js';
import { ext } from './lib/client.js';
import { renderPlanSection, bindPlanSection } from './lib/plan-view.js';
import { renderIterationsSection, bindIterationsSection } from './lib/iterations-view.js';
import { ensureCategoryKey, createMissingTasks, fetchIterationTasks, fetchCompletions, deleteIterationOpenTasks } from './lib/yuvomi-tasks.js';

const tt = (key, params) => t(`extensions.cleaningplan.${key}`, params);

export async function render(container, { signal }) {
  const state = {
    access: 'read', plan: { rooms: [] }, members: [], editing: null, formError: null, error: null,
    iterations: [], open: null, tasksById: new Map(), completions: new Map(),
    generating: false, progress: null, iterationsError: null, busy: false,
  };

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend',
    renderPageHeader({ title: renderPageTitle(esc(tt('title'))) })
    + renderPageBody({
      content: renderPageSection({ className: 'cleaningplan-readonly-section', content: '<p class="cleaningplan-readonly" id="cleaningplan-readonly" hidden></p>' })
        + '<div id="cleaningplan-plan"></div><div id="cleaningplan-iterations"></div>',
    }));
  const planMount = container.querySelector('#cleaningplan-plan');
  const iterMount = container.querySelector('#cleaningplan-iterations');
  const readOnlyHint = container.querySelector('#cleaningplan-readonly');
  const canWrite = () => state.access === 'write';

  // ---- drawing ----

  function drawPlan({ focusForm = false } = {}) {
    readOnlyHint.textContent = tt('readOnly');
    readOnlyHint.hidden = canWrite() || Boolean(state.error);
    readOnlyHint.closest('.page-section').hidden = readOnlyHint.hidden;
    if (state.error) {
      iterMount.replaceChildren();
      mountLoadError(planMount, { title: tt('error.load'), error: state.error, retryLabel: tt('error.retry'), onRetry: load });
      return;
    }
    planMount.replaceChildren();
    planMount.insertAdjacentHTML('beforeend', renderPlanSection({
      plan: state.plan, members: state.members, canWrite: canWrite(), editing: state.editing, formError: state.formError,
    }));
    if (focusForm) planMount.querySelector('form input[name="name"]')?.focus();
  }

  function drawIterations() {
    if (state.error) return;
    iterMount.replaceChildren();
    iterMount.insertAdjacentHTML('beforeend', renderIterationsSection({
      iterations: state.iterations, open: state.open, tasksById: state.tasksById, completions: state.completions,
      members: state.members, rooms: state.plan.rooms, canWrite: canWrite(), generating: state.generating, progress: state.progress, busy: state.busy, error: state.iterationsError,
    }));
  }

  // ---- loading ----

  async function reloadPlan() { state.plan = await ext.get('/plan', { signal }); }
  async function reloadIterations() { state.iterations = await ext.get('/iterations', { signal }); }

  async function openIteration(id) {
    if (id === null) {
      state.open = null;
      history.replaceState(null, '', location.pathname);
      return;
    }
    const [iteration, tasksById] = await Promise.all([ext.get(`/iterations/${id}`, { signal }), fetchIterationTasks(id, { signal })]);
    const doneIds = new Set([...tasksById.values()].filter((task) => task.status === 'done').map((task) => task.id));
    const completions = doneIds.size ? await fetchCompletions({ wanted: doneIds, signal }) : new Map();
    state.open = iteration;
    state.tasksById = tasksById;
    state.completions = completions;
    history.replaceState(null, '', `${location.pathname}?iteration=${id}`);
  }

  async function load() {
    try {
      const [me, plan, members, iterations] = await Promise.all([
        ext.get('/me', { signal }), ext.get('/plan', { signal }), api.get('/family/members', { signal }), ext.get('/iterations', { signal }),
      ]);
      if (signal.aborted) return;
      Object.assign(state, { access: me.access, plan, members: members.data ?? [], iterations, error: null });
      const wanted = Number(new URLSearchParams(location.search).get('iteration'));
      if (wanted && iterations.some((it) => it.id === wanted)) {
        await openIteration(wanted).catch((err) => {
          state.iterationsError = err.message;
          history.replaceState(null, '', location.pathname);
        });
      }
    } catch (err) {
      if (signal.aborted) return;
      state.error = err;
    }
    if (signal.aborted) return;
    drawPlan();
    drawIterations();
  }

  // ---- plan handlers ----

  // A failed write stays in the form; a failed reload after a successful write is a page
  // error with retry, never a silently stale list.
  async function mutatePlan(fn) {
    try {
      await fn();
    } catch (err) {
      if (signal.aborted) return;
      state.formError = err.message;
      drawPlan({ focusForm: true });
      return;
    }
    if (signal.aborted) return;
    state.editing = null;
    state.formError = null;
    try {
      await reloadPlan();
    } catch (err) {
      if (signal.aborted) return;
      state.error = err;
    }
    if (!signal.aborted) drawPlan();
  }

  bindPlanSection(planMount, {
    onEdit: (editing) => { state.editing = editing; state.formError = null; drawPlan({ focusForm: true }); },
    onCancel: () => { state.editing = null; state.formError = null; drawPlan(); },
    onSaveRoom: (id, input) => mutatePlan(() => (id === null ? ext.post('/rooms', input, { signal }) : ext.patch(`/rooms/${id}`, input, { signal }))),
    onDeleteRoom: (id) => { if (window.confirm(tt('confirm.deleteRoom'))) mutatePlan(() => ext.delete(`/rooms/${id}`, { signal })); },
    onSaveActivity: (id, roomId, input) => mutatePlan(() => (id === null
      ? ext.post(`/rooms/${roomId}/activities`, input, { signal })
      : ext.patch(`/activities/${id}`, input, { signal }))),
    onDeleteActivity: (id) => { if (window.confirm(tt('confirm.deleteActivity'))) mutatePlan(() => ext.delete(`/activities/${id}`, { signal })); },
  }, signal);

  // ---- iteration handlers ----

  // One iteration action at a time: a second click while one runs is ignored, and the
  // controls are drawn disabled meanwhile (a double tap would otherwise generate twice).
  async function withIterations(fn) {
    if (state.busy) return;
    state.busy = true;
    state.iterationsError = null;
    drawIterations();
    try {
      await fn();
    } catch (err) {
      if (signal.aborted) return;
      state.iterationsError = err.message;
      // The sidecar may well have done its part before the failure: show what it holds
      // rather than a stale list that would make the next Generate repeat the window.
      await Promise.allSettled([reloadIterations(), reloadPlan()]);
      if (signal.aborted) return;
      drawPlan();
    }
    if (signal.aborted) return;
    state.busy = false;
    state.progress = null;
    drawIterations();
  }

  async function createTasks(iteration, categoryKey) {
    state.progress = { created: 0, failed: 0, total: iteration.todos.filter((todo) => todo.yuvomi_task_id === null).length };
    drawIterations();
    const result = await createMissingTasks(iteration, {
      categoryKey, members: state.members, signal, onProgress: (p) => { state.progress = { ...p }; drawIterations(); },
    });
    if (result.failed) state.iterationsError = `${tt('iterations.partial', { n: result.failed })}${result.error ? ` (${result.error.message})` : ''}`;
    await Promise.all([reloadIterations(), reloadPlan()]);
    await openIteration(iteration.id);
    drawPlan();
  }

  bindIterationsSection(iterMount, {
    onOpen: (id) => withIterations(() => openIteration(state.open?.id === id ? null : id)),
    onGenerateStart: () => { state.generating = true; state.iterationsError = null; drawIterations(); iterMount.querySelector('input[name="start_date"]')?.focus(); },
    onGenerateCancel: () => { state.generating = false; drawIterations(); },
    onGenerateSubmit: ({ no_rooms, ...range }) => {
      if (no_rooms) { state.iterationsError = tt('iterations.noRooms'); drawIterations(); return; }
      state.generating = false;
      withIterations(async () => {
        const categoryKey = await ensureCategoryKey({ signal });
        const iteration = await ext.post('/iterations', range, { signal });
        await createTasks(iteration, categoryKey);
      });
    },
    onCreateMissing: (id) => withIterations(async () => {
      const categoryKey = await ensureCategoryKey({ signal });
      const iteration = await ext.get(`/iterations/${id}`, { signal });
      await createTasks(iteration, categoryKey);
    }),
    onDelete: (id) => {
      if (!window.confirm(tt('iterations.deleteConfirm'))) return;
      withIterations(async () => {
        await reloadIterations();
        if (state.iterations[0]?.id !== id) throw new Error(tt('iterations.notNewest'));
        await deleteIterationOpenTasks(id, { signal });
        await ext.delete(`/iterations/${id}`, { signal });
        state.open = null;
        history.replaceState(null, '', location.pathname);
        await Promise.all([reloadIterations(), reloadPlan()]);
        drawPlan();
      });
    },
  }, signal);

  await load();
}
