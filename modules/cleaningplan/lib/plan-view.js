// Plan section: rooms as list groups, activities as rows, one inline form at a time.
// render* return HTML strings (every value through esc()); bindPlanSection attaches two
// delegated listeners once on the mount so re-rendering never re-binds.
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { renderListSection } from '/utils/page-layout.js';
import { emptyStateHTML } from '/utils/empty-state.js';
import { scheduleLabel, memberName } from './format.js';

const tt = (key, params) => t(`extensions.cleaningplan.${key}`, params);
const UNITS = ['days', 'weeks', 'months'];

export function renderPlanSection({ plan, members, canWrite, editing, formError = null }) {
  const rooms = plan.rooms;
  const newRoom = canWrite && editing?.kind === 'room' && editing.id == null;
  const body = rooms.length
    ? rooms.map((room) => renderRoom(room, { members, canWrite, editing, formError })).join('')
    : (newRoom ? '' : emptyStateHTML({ icon: 'sparkles', title: tt('plan.empty.title'), description: tt('plan.empty.description') }));
  const footer = !canWrite ? '' : newRoom
    ? renderRoomForm(null, formError)
    : `<div class="cleaningplan-add"><button type="button" class="btn btn--secondary btn--sm" data-action="add-room">${esc(tt('room.add'))}</button></div>`;
  return renderListSection({
    className: 'cleaningplan-plan',
    id: 'cleaningplan-plan-section',
    content: `<h2 class="cleaningplan-section-title">${esc(tt('plan.title'))}</h2>${body}${footer}`,
  });
}

function renderRoom(room, { members, canWrite, editing, formError }) {
  const editingRoom = editing?.kind === 'room' && editing.id === room.id;
  const title = editingRoom
    ? renderRoomForm(room, formError)
    : `<div class="list-group__title cleaningplan-room__title"><span>${esc(room.name)}</span>${canWrite ? iconButton('edit-room', room.id, tt('action.edit')) : ''}</div>`;
  const rows = room.activities.map((activity) => (
    editing?.kind === 'activity' && editing.id === activity.id
      ? renderActivityForm(activity, room.id, members, formError)
      : renderActivityRow(activity, members, canWrite)
  )).join('');
  const addingHere = editing?.kind === 'activity' && editing.id == null && editing.roomId === room.id;
  const add = !canWrite ? '' : addingHere
    ? renderActivityForm(null, room.id, members, formError)
    : `<div class="cleaningplan-add"><button type="button" class="btn btn--ghost btn--sm" data-action="add-activity" data-room-id="${room.id}">${esc(tt('activity.add'))}</button></div>`;
  return `<div class="list-group cleaningplan-room" data-room-id="${room.id}">${title}<div class="list-rows">${rows}</div>${add}</div>`;
}

function renderActivityRow(activity, members, canWrite) {
  const meta = [
    scheduleLabel(activity.schedule, t),
    memberName(activity.default_assignee_id, members),
    activity.target_time,
    tt('activity.nextDue', { date: activity.next_due }),
  ].filter(Boolean).map(esc).join(' · ');
  const inactive = activity.active ? '' : ` <span class="cleaningplan-inactive">${esc(tt('activity.inactive'))}</span>`;
  return `<div class="list-row cleaningplan-activity${activity.active ? '' : ' cleaningplan-activity--inactive'}" data-activity-id="${activity.id}">
    <div class="list-row__main"><div class="list-row__name">${esc(activity.name)}${inactive}</div><div class="list-row__meta">${meta}</div></div>
    ${canWrite ? `<div class="list-row__end">${iconButton('edit-activity', activity.id, tt('action.edit'), activity.room_id)}</div>` : ''}
  </div>`;
}

function iconButton(action, id, label, roomId) {
  const room = roomId === undefined ? '' : ` data-room-id="${roomId}"`;
  return `<button type="button" class="btn btn--ghost btn--sm" data-action="${action}" data-id="${id}"${room}>${esc(label)}</button>`;
}

function renderRoomForm(room, formError) {
  const id = room ? room.id : '';
  return `<form class="cleaningplan-form" data-form="room" data-id="${id}">
    <div class="form-row"><label class="form-label" for="cleaningplan-room-name">${esc(tt('room.name'))}</label>
      <input class="input" id="cleaningplan-room-name" name="name" value="${esc(room?.name ?? '')}" required maxlength="100" autocomplete="off"></div>
    ${renderFormError(formError)}
    ${renderFormActions(room ? 'delete-room' : null, room?.id)}
  </form>`;
}

function renderActivityForm(activity, roomId, members, formError) {
  const id = activity ? activity.id : '';
  const sel = (cond) => (cond ? ' selected' : '');
  const units = UNITS.map((u) => `<option value="${u}"${sel((activity?.schedule.interval_unit ?? 'days') === u)}>${esc(tt(`unit.${u}`))}</option>`).join('');
  const people = [`<option value=""${sel(!activity?.default_assignee_id)}>${esc(tt('activity.nobody'))}</option>`]
    .concat(members.map((m) => `<option value="${m.id}"${sel(activity?.default_assignee_id === m.id)}>${esc(m.display_name)}</option>`)).join('');
  return `<form class="cleaningplan-form" data-form="activity" data-id="${id}" data-room-id="${roomId}" data-next-due="${esc(activity?.next_due ?? '')}">
    <div class="form-row"><label class="form-label" for="cp-act-name">${esc(tt('activity.name'))}</label>
      <input class="input" id="cp-act-name" name="name" value="${esc(activity?.name ?? '')}" required maxlength="100" autocomplete="off"></div>
    <div class="form-row"><label class="form-label" for="cp-act-interval">${esc(tt('activity.interval'))}</label>
      <div class="cleaningplan-form__interval">
        <input class="input" id="cp-act-interval" type="number" name="interval_value" min="1" max="365" required value="${activity?.schedule.interval_value ?? 1}">
        <select class="input" name="interval_unit" aria-label="${esc(tt('activity.unit'))}">${units}</select>
      </div></div>
    <div class="form-row"><label class="form-label" for="cp-act-assignee">${esc(tt('activity.assignee'))}</label>
      <select class="input" id="cp-act-assignee" name="default_assignee_id">${people}</select></div>
    <div class="form-row"><label class="form-label" for="cp-act-time">${esc(tt('activity.time'))}</label>
      <input class="input" id="cp-act-time" type="time" name="target_time" value="${esc(activity?.target_time ?? '')}"></div>
    <div class="form-row"><label class="form-label" for="cp-act-first">${esc(tt(activity ? 'activity.nextDueLabel' : 'activity.firstDue'))}</label>
      <input class="input" id="cp-act-first" type="date" name="first_due" value="${esc(activity?.next_due ?? '')}"></div>
    ${activity ? `<label class="form-check"><input type="checkbox" name="active"${activity.active ? ' checked' : ''}> ${esc(tt('activity.active'))}</label>` : ''}
    ${renderFormError(formError)}
    ${renderFormActions(activity ? 'delete-activity' : null, activity?.id)}
  </form>`;
}

function renderFormError(formError) {
  return formError ? `<p class="form-error cleaningplan-form__error">${esc(formError)}</p>` : '';
}

function renderFormActions(deleteAction, id) {
  const del = deleteAction ? `<button type="button" class="btn btn--danger-outline btn--sm" data-action="${deleteAction}" data-id="${id}">${esc(tt('action.delete'))}</button>` : '';
  return `<div class="cleaningplan-form__actions">
    <button type="submit" class="btn btn--primary btn--sm">${esc(tt('action.save'))}</button>
    <button type="button" class="btn btn--ghost btn--sm" data-action="cancel">${esc(tt('action.cancel'))}</button>${del}
  </div>`;
}

export function bindPlanSection(root, handlers, signal) {
  root.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    const id = el.dataset.id ? Number(el.dataset.id) : null;
    const roomId = el.dataset.roomId ? Number(el.dataset.roomId) : null;
    switch (el.dataset.action) {
      case 'add-room': return handlers.onEdit({ kind: 'room', id: null });
      case 'edit-room': return handlers.onEdit({ kind: 'room', id });
      case 'add-activity': return handlers.onEdit({ kind: 'activity', id: null, roomId });
      case 'edit-activity': return handlers.onEdit({ kind: 'activity', id, roomId });
      case 'cancel': return handlers.onCancel();
      case 'delete-room': return handlers.onDeleteRoom(id);
      case 'delete-activity': return handlers.onDeleteActivity(id);
      default: return undefined;
    }
  }, { signal });

  root.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form);
    const id = form.dataset.id ? Number(form.dataset.id) : null;
    if (form.dataset.form === 'room') {
      return handlers.onSaveRoom(id, { name: String(data.get('name') ?? '').trim() });
    }
    const input = {
      name: String(data.get('name') ?? '').trim(),
      schedule: { interval_value: Number(data.get('interval_value')), interval_unit: String(data.get('interval_unit')) },
      default_assignee_id: data.get('default_assignee_id') ? Number(data.get('default_assignee_id')) : null,
      target_time: data.get('target_time') ? String(data.get('target_time')) : null,
    };
    // Send the date only when the person changed it; the stored one is a phase, not a form value.
    const firstDue = data.get('first_due') ? String(data.get('first_due')) : '';
    if (firstDue && firstDue !== form.dataset.nextDue) input.first_due = firstDue;
    if (id !== null) input.active = data.get('active') === 'on';
    return handlers.onSaveActivity(id, Number(form.dataset.roomId), input);
  }, { signal });
}
