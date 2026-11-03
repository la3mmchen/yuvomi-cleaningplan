import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addInterval, dueDatesInWindow, isIsoDate } from '../app/schedule.mjs';

const act = (next_due, interval_value, interval_unit) => ({ next_due, schedule: { interval_value, interval_unit } });

test('addInterval adds days, weeks, months', () => {
  assert.equal(addInterval('2026-11-03', 2, 'days'), '2026-11-05');
  assert.equal(addInterval('2026-11-03', 1, 'weeks'), '2026-11-10');
  assert.equal(addInterval('2026-11-03', 1, 'months'), '2026-12-03');
});

test('addInterval clamps month end', () => {
  assert.equal(addInterval('2026-01-31', 1, 'months'), '2026-02-28');
  assert.equal(addInterval('2024-01-31', 1, 'months'), '2024-02-29');
  assert.equal(addInterval('2026-10-31', 1, 'months'), '2026-11-30');
});

test('addInterval crosses a year', () => {
  assert.equal(addInterval('2026-12-30', 5, 'days'), '2027-01-04');
  assert.equal(addInterval('2026-11-15', 3, 'months'), '2027-02-15');
});

test('dueDatesInWindow daily in a week yields 7 dates and next_due after the window', () => {
  const r = dueDatesInWindow(act('2026-11-03', 1, 'days'), '2026-11-03', '2026-11-09');
  assert.deepEqual(r.dates, ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']);
  assert.equal(r.next_due, '2026-11-10');
});

test('dueDatesInWindow every 2 days yields 4 dates', () => {
  const r = dueDatesInWindow(act('2026-11-03', 2, 'days'), '2026-11-03', '2026-11-09');
  assert.deepEqual(r.dates, ['2026-11-03', '2026-11-05', '2026-11-07', '2026-11-09']);
  assert.equal(r.next_due, '2026-11-11');
});

test('dueDatesInWindow carries phase from before the window', () => {
  const r = dueDatesInWindow(act('2026-11-01', 3, 'days'), '2026-11-03', '2026-11-09');
  assert.deepEqual(r.dates, ['2026-11-04', '2026-11-07']);
  assert.equal(r.next_due, '2026-11-10');
});

test('dueDatesInWindow beyond the window yields nothing and keeps next_due', () => {
  const r = dueDatesInWindow(act('2026-12-01', 1, 'weeks'), '2026-11-03', '2026-11-09');
  assert.deepEqual(r.dates, []);
  assert.equal(r.next_due, '2026-12-01');
});

test('isIsoDate rejects 2026-02-30 and 2026-13-01', () => {
  assert.equal(isIsoDate('2026-11-03'), true);
  assert.equal(isIsoDate('2024-02-29'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-13-01'), false);
  assert.equal(isIsoDate('2026-1-3'), false);
  assert.equal(isIsoDate(undefined), false);
});

test('addInterval months keeps the anchor day after a short month', () => {
  assert.equal(addInterval('2026-02-28', 1, 'months', 31), '2026-03-31');
  assert.equal(addInterval('2026-02-28', 1, 'months'), '2026-03-28');
  assert.equal(addInterval('2026-04-30', 1, 'months', 31), '2026-05-31');
});

test('dueDatesInWindow monthly on the 31st lands on month ends without drifting', () => {
  const activity = { next_due: '2026-01-31', anchor_day: 31, schedule: { interval_value: 1, interval_unit: 'months' } };
  const r = dueDatesInWindow(activity, '2026-01-01', '2026-05-31');
  assert.deepEqual(r.dates, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  assert.equal(r.next_due, '2026-06-30');
  const resumed = dueDatesInWindow({ ...activity, next_due: '2026-02-28' }, '2026-03-01', '2026-03-31');
  assert.deepEqual(resumed.dates, ['2026-03-31']);
});
