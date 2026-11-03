// Iterations section: the generate control, the list of iterations and, for the opened
// one, its to-dos grouped by day with the state read back from Yuvomi.
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderListSection } from '/utils/page-layout.js';
import { emptyStateHTML } from '/utils/empty-state.js';
import { groupByDay, todoState, memberName, roomNames, buildGenerateRequest } from './format.js';

const tt = (key, params) => t(`extensions.cleaningplan.${key}`, params);
const LENGTHS = [7, 14, 28];

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function defaultStartDate(iterations) {
  if (iterations.length) return addDays(iterations[0].end_date, 1);
  return addDays(new Date().toISOString().slice(0, 10), 1);
}

function formatWhen(iso) {
  const lang = globalThis.document?.documentElement?.lang || 'en';
  try { return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; }
}

export function renderIterationsSection({ iterations, open, tasksById, completions, members, rooms = [], canWrite, generating, progress, busy = false, error = null }) {
  const head = `<div class="cleaningplan-section-head"><h2 class="cleaningplan-section-title">${esc(tt('iterations.title'))}</h2>${renderGenerateControl({ canWrite, generating, progress, busy })}</div>`;
  const form = canWrite && generating && !progress ? renderGenerateForm(iterations, rooms, busy) : '';
  const err = error ? `<p class="form-error cleaningplan-form__error">${esc(error)}</p>` : '';
  const list = iterations.length
    ? `<div class="list-group"><div class="list-rows">${iterations.map((it, index) => renderIterationRow(it, { index, open, tasksById, completions, members, rooms, canWrite, busy })).join('')}</div></div>`
    : emptyStateHTML({ icon: 'calendar-check', title: tt('iterations.empty.title'), description: tt('iterations.empty.description') });
  return renderListSection({ className: 'cleaningplan-iterations', id: 'cleaningplan-iterations-section', content: head + form + err + list });
}

function renderGenerateControl({ canWrite, generating, progress, busy }) {
  if (!canWrite) return '';
  if (progress) return `<span class="cleaningplan-progress" role="status">${esc(tt('iterations.progress', { created: progress.created, total: progress.total }))}</span>`;
  if (generating) return '';
  return `<button type="button" class="btn btn--primary btn--sm" data-action="generate"${busy ? ' disabled' : ''}>${esc(tt('iterations.generate'))}</button>`;
}

function renderGenerateForm(iterations, rooms, busy) {
  const options = LENGTHS.map((n) => `<option value="${n}"${n === 7 ? ' selected' : ''}>${esc(tt('iterations.days', { n }))}</option>`).join('');
  const roomChecks = rooms.map((room) => `<label class="form-check"><input type="checkbox" name="room_ids" value="${room.id}" checked> ${esc(room.name)}</label>`).join('');
  const roomRow = rooms.length ? `<div class="form-row"><span class="form-label">${esc(tt('iterations.roomsLabel'))}</span><div class="cleaningplan-rooms">${roomChecks}</div></div>` : '';
  return `<form class="cleaningplan-form cleaningplan-generate" data-form="generate" data-room-count="${rooms.length}">
    <div class="form-row"><label class="form-label" for="cp-gen-start">${esc(tt('iterations.start'))}</label>
      <input class="input" id="cp-gen-start" type="date" name="start_date" required value="${defaultStartDate(iterations)}"></div>
    <div class="form-row"><label class="form-label" for="cp-gen-length">${esc(tt('iterations.length'))}</label>
      <select class="input" id="cp-gen-length" name="length">${options}</select></div>
    ${roomRow}
    <div class="form-row"><label class="form-label" for="cp-gen-tags">${esc(tt('iterations.tags'))}</label>
      <input class="input" id="cp-gen-tags" name="tags" autocomplete="off" placeholder="${esc(tt('iterations.tagsPlaceholder'))}"></div>
    <div class="cleaningplan-form__actions">
      <button type="submit" class="btn btn--primary btn--sm"${busy ? ' disabled' : ''}>${esc(tt('iterations.generate'))}</button>
      <button type="button" class="btn btn--ghost btn--sm" data-action="cancel-generate">${esc(tt('action.cancel'))}</button>
    </div>
  </form>`;
}

function renderIterationRow(it, { index, open, tasksById, completions, members, rooms, canWrite, busy }) {
  const dis = busy ? ' disabled' : '';
  const isOpen = open?.id === it.id;
  const states = isOpen ? open.todos.map((todo) => todoState(todo, tasksById)) : [];
  const meta = [tt('iterations.todos', { n: it.todo_count })];
  if (isOpen) meta.push(tt('iterations.done', { n: states.filter((s) => s === 'done').length }));
  else if (it.linked_count !== it.todo_count) meta.push(tt('iterations.linked', { n: it.linked_count, total: it.todo_count }));
  if (it.room_ids?.length) {
    const names = roomNames(it.room_ids, rooms);
    if (names.length) meta.push(tt('iterations.rooms', { names: names.join(', ') }));
  }
  if (it.tags?.length) meta.push(it.tags.join(', '));
  const row = `<div class="list-row cleaningplan-iteration${isOpen ? ' cleaningplan-iteration--open' : ''}" data-iteration-id="${it.id}">
    <button type="button" class="list-row__main list-row__main--interactive cleaningplan-iteration__open" data-action="open-iteration" data-id="${it.id}" aria-expanded="${isOpen}">
      <div class="list-row__name">${esc(it.start_date)} – ${esc(it.end_date)}</div>
      <div class="list-row__meta">${meta.map(esc).join(' · ')}</div>
    </button>
  </div>`;
  if (!isOpen) return row;
  const missing = states.filter((s) => s === 'missing').length;
  const actions = !canWrite ? '' : [
    missing ? `<button type="button" class="btn btn--secondary btn--sm" data-action="create-missing" data-id="${it.id}"${dis}>${esc(tt('iterations.createMissing', { n: missing }))}</button>` : '',
    index === 0 ? `<button type="button" class="btn btn--danger-outline btn--sm" data-action="delete-iteration" data-id="${it.id}"${dis}>${esc(tt('iterations.delete'))}</button>` : '',
  ].join('');
  const days = groupByDay(open.todos).map((group) => `<h3 class="cleaningplan-day__title">${esc(group.date)}</h3>
    <div class="list-rows">${group.todos.map((todo) => renderTodoRow(todo, { tasksById, completions, members })).join('')}</div>`).join('');
  return `${row}<div class="cleaningplan-iteration__detail">${actions ? `<div class="cleaningplan-form__actions">${actions}</div>` : ''}${days || `<p class="cleaningplan-muted">${esc(tt('iterations.noTodos'))}</p>`}</div>`;
}

function renderTodoRow(todo, { tasksById, completions, members }) {
  const state = todoState(todo, tasksById);
  const who = memberName(todo.assignee_id, members) || tt('todo.unassigned');
  let status = '';
  if (state === 'missing') status = tt('todo.missing');
  else if (state === 'removed') status = tt('todo.removed');
  else if (state === 'done') {
    const c = completions.get(todo.yuvomi_task_id);
    const name = c?.person_name || c?.user_name || '';
    if (!c) status = tt('todo.done');
    else status = name ? tt('todo.doneBy', { name, when: formatWhen(c.completed_at) }) : tt('todo.doneAt', { when: formatWhen(c.completed_at) });
  }
  const meta = [todo.due_time, who, status].filter(Boolean).map(esc).join(' · ');
  return `<div class="list-row cleaningplan-todo cleaningplan-todo--${state}" data-state="${state}" data-todo-id="${todo.id}">
    <span class="check-ring check-ring--static${state === 'done' ? ' check-ring--done' : ''}" aria-hidden="true"></span>
    <div class="list-row__main"><div class="list-row__name">${esc(todo.title)}</div><div class="list-row__meta">${meta}</div></div>
  </div>`;
}

export function bindIterationsSection(root, handlers, signal) {
  root.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    const id = el.dataset.id ? Number(el.dataset.id) : null;
    switch (el.dataset.action) {
      case 'open-iteration': return handlers.onOpen(id);
      case 'generate': return handlers.onGenerateStart();
      case 'cancel-generate': return handlers.onGenerateCancel();
      case 'create-missing': return handlers.onCreateMissing(id);
      case 'delete-iteration': return handlers.onDelete(id);
      default: return undefined;
    }
  }, { signal });
  root.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-form="generate"]');
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form);
    const { no_rooms, ...request } = buildGenerateRequest({
      start_date: String(data.get('start_date')), length: data.get('length'), tags: data.get('tags'),
      roomIds: data.getAll('room_ids').map(Number), roomCount: Number(form.dataset.roomCount) || 0,
    });
    if (no_rooms) {
      // Complain on the form itself: a redraw would reset what the person typed.
      const box = form.querySelector('input[name="room_ids"]');
      box.setCustomValidity(tt('iterations.noRooms'));
      box.reportValidity();
      form.addEventListener('change', () => box.setCustomValidity(''), { once: true });
      return;
    }
    handlers.onGenerateSubmit(request);
  }, { signal });
}
