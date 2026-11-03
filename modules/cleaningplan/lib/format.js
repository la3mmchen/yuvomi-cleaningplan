// Pure helpers for the page: no DOM, no fetch, so Node can test them.

export function groupByDay(todos) {
  const byDate = new Map();
  for (const todo of todos) {
    if (!byDate.has(todo.due_date)) byDate.set(todo.due_date, []);
    byDate.get(todo.due_date).push(todo);
  }
  return [...byDate.keys()].sort().map((date) => ({
    date,
    todos: byDate.get(date).sort((a, b) => {
      if (a.due_time !== b.due_time) {
        if (a.due_time === null) return 1;
        if (b.due_time === null) return -1;
        return a.due_time < b.due_time ? -1 : 1;
      }
      return a.id - b.id;
    }),
  }));
}

export function todoState(todo, taskById) {
  if (todo.yuvomi_task_id === null || todo.yuvomi_task_id === undefined) return 'missing';
  const task = taskById.get(todo.yuvomi_task_id);
  if (!task) return 'removed';
  return task.status === 'done' ? 'done' : 'open';
}

export function scheduleLabel({ interval_value, interval_unit }, t) {
  return t(`extensions.cleaningplan.every.${interval_unit}`, { n: interval_value });
}

// "week-46, Deep Clean" -> ['week-46', 'Deep Clean']; empties dropped, case-duplicates collapsed.
const RESERVED_TAG_RE = /^cleaningplan(?::|$)/i;

export function parseTags(text) {
  const seen = new Set();
  const tags = [];
  for (const raw of String(text ?? '').split(',')) {
    const tag = raw.trim();
    if (!tag || seen.has(tag.toLowerCase()) || RESERVED_TAG_RE.test(tag)) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags;
}

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// What the generate form submits -> what POST /iterations receives.
export function buildGenerateRequest({ start_date, length, tags, roomIds, roomCount }) {
  const days = Number(length) || 7;
  return {
    start_date,
    end_date: addDays(start_date, days - 1),
    tags: parseTags(tags),
    room_ids: roomIds.length === roomCount ? [] : roomIds, // every room ticked means no limit
    no_rooms: roomCount > 0 && roomIds.length === 0,
  };
}

export function roomNames(ids, rooms) {
  return ids.map((id) => rooms.find((room) => room.id === id)?.name).filter(Boolean);
}

export function memberName(id, members) {
  if (id === null || id === undefined) return '';
  return members.find((m) => m.id === id)?.display_name ?? '';
}
