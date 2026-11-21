import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPlanSection } from '../../modules/cleaningplan/lib/plan-view.js';

const members = [{ id: 2, display_name: 'Sam' }, { id: 3, display_name: 'Kim' }];
const plan = {
  rooms: [{
    id: 1, name: '<b>Bad</b> "kitchen"', sort_order: 0,
    activities: [{
      id: 10, room_id: 1, name: 'Vac "x" & more', default_assignee_id: 2, target_time: '18:00',
      next_due: '2026-11-03', active: true, sort_order: 0, schedule: { interval_value: 2, interval_unit: 'days' },
      note: '* papers <away>\n* glasses',
    }],
  }],
};

test('renderPlanSection escapes names and lists activities with their meta', () => {
  const html = renderPlanSection({ plan, members, canWrite: true, editing: null });
  assert.ok(html.includes('&lt;b&gt;Bad&lt;/b&gt; &quot;kitchen&quot;'));
  assert.ok(!html.includes('<b>Bad</b>'));
  assert.ok(html.includes('Vac &quot;x&quot; &amp; more'));
  assert.ok(html.includes('extensions.cleaningplan.every.days(n=2)'));
  assert.ok(html.includes('Sam'));
  assert.ok(html.includes('18:00'));
  assert.ok(html.includes('2026-11-03'));
});

test('renderPlanSection hides controls for read access', () => {
  const ro = renderPlanSection({ plan, members, canWrite: false, editing: null });
  assert.ok(!ro.includes('data-action='));
  const rw = renderPlanSection({ plan, members, canWrite: true, editing: null });
  assert.ok(rw.includes('data-action="add-room"'));
  assert.ok(rw.includes('data-action="add-activity"'));
  assert.ok(rw.includes('data-action="edit-activity"'));
  assert.ok(rw.includes('data-action="edit-room"'));
});

test('renderPlanSection shows the inline activity form with current values', () => {
  const html = renderPlanSection({ plan, members, canWrite: true, editing: { kind: 'activity', id: 10, roomId: 1 } });
  assert.ok(html.includes('<form'));
  assert.ok(html.includes('data-form="activity"'));
  assert.ok(html.includes('name="name"') && html.includes('value="Vac &quot;x&quot; &amp; more"'));
  assert.ok(html.includes('name="interval_value"') && html.includes('value="2"'));
  assert.ok(/<option value="days" selected/.test(html));
  assert.ok(/<option value="2" selected>Sam<\/option>/.test(html));
  assert.ok(/<option value="">extensions\.cleaningplan\.activity\.nobody<\/option>/.test(html));
  assert.ok(html.includes('name="target_time"') && html.includes('value="18:00"'));
  assert.ok(html.includes('name="first_due"') && html.includes('value="2026-11-03"'));
  assert.ok(html.includes('name="active"') && html.includes('checked'));
  assert.ok(html.includes('data-action="delete-activity"'));
});

test('renderPlanSection shows the room form for a new room and the empty state for no rooms', () => {
  const html = renderPlanSection({ plan: { rooms: [] }, members, canWrite: true, editing: { kind: 'room', id: null } });
  assert.ok(html.includes('data-form="room"'));
  assert.ok(!html.includes('data-action="delete-room"'));
  const empty = renderPlanSection({ plan: { rooms: [] }, members, canWrite: true, editing: null });
  assert.ok(empty.includes('empty-state'));
  assert.ok(empty.includes('extensions.cleaningplan.plan.empty.title'));
});

test('activity form carries the stored next due so an unchanged date is not re-sent', () => {
  const html = renderPlanSection({ plan, members, canWrite: true, editing: { kind: 'activity', id: 10, roomId: 1 } });
  assert.ok(html.includes('data-next-due="2026-11-03"'));
  assert.ok(!html.includes('class="select"'));
});

test('activity note shows escaped under the row and prefilled in the form', () => {
  const row = renderPlanSection({ plan, members, canWrite: false, editing: null });
  assert.ok(row.includes('cleaningplan-activity__note">* papers &lt;away&gt;\n* glasses</div>'));
  const form = renderPlanSection({ plan, members, canWrite: true, editing: { kind: 'activity', id: 10, roomId: 1 } });
  assert.ok(/<textarea[^>]*name="note"[^>]*>\* papers &lt;away&gt;\n\* glasses<\/textarea>/.test(form));
});
