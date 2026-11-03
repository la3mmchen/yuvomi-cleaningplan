// Calendar-date arithmetic for schedules. Dates are 'YYYY-MM-DD' strings; there are
// no time zones here, every calculation runs on Date.UTC so DST never moves a day.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date) {
  const m = ISO_RE.exec(date);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function format(utc) {
  return utc.toISOString().slice(0, 10);
}

export function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const p = parts(value);
  if (!p) return false;
  const [y, m, d] = p;
  const utc = new Date(Date.UTC(y, m - 1, d));
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d;
}

// `anchorDay` keeps a monthly schedule on its original day of month: Jan 31 -> Feb 28 ->
// Mar 31. Without it the step after a short month would stick to the 28th for good.
export function addInterval(date, value, unit, anchorDay) {
  const [y, m, d] = parts(date);
  if (unit === 'days') return format(new Date(Date.UTC(y, m - 1, d + value)));
  if (unit === 'weeks') return format(new Date(Date.UTC(y, m - 1, d + 7 * value)));
  if (unit === 'months') {
    const first = new Date(Date.UTC(y, m - 1 + value, 1));
    const daysInTarget = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return format(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(anchorDay ?? d, daysInTarget))));
  }
  throw new Error(`unknown interval unit: ${unit}`);
}

export function dueDatesInWindow(activity, start, end) {
  const { interval_value, interval_unit } = activity.schedule;
  const dates = [];
  const anchorDay = activity.anchor_day ?? parts(activity.next_due)[2];
  let d = activity.next_due;
  while (d <= end) {
    if (d >= start) dates.push(d);
    d = addInterval(d, interval_value, interval_unit, anchorDay);
  }
  return { dates, next_due: d };
}
