# Cleaning plan module for Yuvomi: design

Date: 2026-11-02. Target: Yuvomi 2.84.0 (`manifestVersion` 1). Source spec: the user's
"System Specification: Yuvomi Cleaning Plan Module" (reproduced in intent below; the user's
decisions are marked *spec*, mine are marked *call*).

## 1. Intent

A household defines a cleaning plan: rooms, each with activities (vacuum, wipe surfaces, …),
each activity with one interval schedule (every 2 days, every week, every 3 months) and an
optional default person and time of day. From that plan the household generates an
**iteration** (typically one week): the concrete to-dos that fall into that window. Those
to-dos are ordinary Yuvomi tasks, so they show on the dashboard and in Tasks, anyone can tick
them off, and Yuvomi records who did it and when. The module's job is to hold the plan and to
generate accurately. (*spec*)

Why a module and not a feature request: core's Tasks already recur, but one occurrence at a
time, created on completion. A cleaning plan wants the whole week laid out in advance from a
plan that is organised by room, and that is a different object from a task. (*call*)

## 2. Goals, non-goals, anti-goals

Goals (*spec* unless noted):
- Define rooms, activities, interval schedules, default assignee, target time of day.
- Generate an iteration: for each activity, every due date inside the window becomes one
  Yuvomi task with the computed due date/time and the inherited assignee.
- See an iteration's to-dos with their state (pending/done), and for done ones who and when,
  read back from Yuvomi.
- Plain ES modules and plain CSS, no frameworks, no build step; design values from Yuvomi tokens;
  layout from Yuvomi's page-layout helpers; no `innerHTML`; `esc()` for every untrusted value.
- Never touch `yuvomi.db`.

Non-goals (v1):
- Automatic/scheduled generation (cron). Generation is a button a person presses. Consequence:
  the module never needs a Yuvomi API token. (*call*)
- Dashboard widget, settings sheet, notifications, points configuration, holiday skipping,
  rotation of assignees between people, per-activity exceptions ("skip this week").
- Editing a generated task from the module. That is what Tasks is for.

Anti-goals:
- Duplicating a to-do when someone presses Generate twice, or after a browser reload mid-way.
- Silently losing the plan on a Yuvomi update or database restore.
- Letting a module request act as a user it cannot prove it is.

## 3. Constraints that shaped the design

- A Yuvomi module is browser code served from `modules/<id>/`; there is no server-side hook.
  Core offers no key-value storage for modules through `/api/v1`. `MODULES.md` names the
  sanctioned pattern for stored state: a separate service on the same origin, reverse-proxied
  at exactly `/api/extensions/<module-id>/`, which re-verifies every request against
  `GET /api/v1/auth/me` and enforces `permissions.modules['ext:<id>']`.
- Yuvomi tasks carry `due_date` (YYYY-MM-DD) and `due_time` (`HH:MM`, no seconds),
  `assigned_to`, `category` (household-managed), free-form `tags`, and completion history via
  `GET /api/v1/tasks/completions` (`user_id`, `done_by_user_id`, timestamp).
- `/api/` is rate-limited at 300 requests per minute per IP.
- Yuvomi's service worker bypasses `/api/`; anything dynamic must live under it.

## 4. Architecture (*call*, the one decision that needs the user's yes)

Two deployable parts plus a proxy rule:

```
browser ──/m/cleaningplan──────────────▶ Yuvomi (serves modules/cleaningplan/* assets)
browser ──/api/v1/tasks…──────────────▶ Yuvomi (creates/reads the generated tasks)
browser ──/api/extensions/cleaningplan/▶ sidecar "cleaningplan-api" (plan + iteration records)
                                             └──GET /api/v1/auth/me (cookie forwarded)──▶ Yuvomi
```

- **Module page** (`modules/cleaningplan/`): the UI; talks to the sidecar for the plan and to
  Yuvomi's `/api/v1` through `/api.js` for tasks and members.
- **Sidecar** (`service/`): Node 24, zero npm dependencies (`node:http`, `node:sqlite`,
  `node:crypto`), its own SQLite file in its own volume. It stores the plan and the iteration
  records. It never writes to Yuvomi.
- **Reverse proxy**: routes `/api/extensions/cleaningplan/*` to the sidecar and everything else
  to Yuvomi. Dev uses Caddy in Compose; production uses whatever proxy the operator already has
  (a two-line rule, documented in the README). Yuvomi runs with `TRUST_PROXY=1` behind it.

Why the browser, not the sidecar, creates the tasks: it already holds a session, a CSRF token
and `/api.js`; the sidecar then needs no credentials for Yuvomi, no CSRF replay, no
X-Forwarded-For plumbing, and Yuvomi's per-IP rate limit is spent by the right IP. The cost is
that generation is two phases with a reconciliation step (see 6.2), which the data model
absorbs.

Trade-off stated plainly: an operator installs one extra container and one proxy rule. The
alternatives were a browser-only module keeping the plan in `localStorage` (one device, not a
household) or hiding JSON in a Note or an archived task (fragile, user-editable, outside the
promised API surface). Both fail the goals.

## 5. Data model (sidecar SQLite, one household per instance)

```
rooms        id, name, sort_order, created_at
activities   id, room_id → rooms (cascade), name, default_assignee_id (nullable, Yuvomi user id),
             target_time (nullable "HH:MM"), interval_value (int ≥ 1), interval_unit
             ('days'|'weeks'|'months'), next_due (YYYY-MM-DD), active (bool), sort_order, created_at
iterations   id, start_date, end_date, created_at, created_by (Yuvomi user id),
             activity_state_before (JSON {activity_id: next_due}) -- for undo
todos        id, iteration_id → iterations (cascade), activity_id → activities (set null),
             title, due_date, due_time (nullable), assignee_id (nullable),
             yuvomi_task_id (nullable until created), created_at
settings     key, value   -- category_key (the Yuvomi task category used), schema_version
```

- *call*: the spec's `Schedule` entity is 1:1 with `Activity` ("each activity has one
  schedule"), so its two fields live on the activity row. The API still exposes them as a
  `schedule: { interval_value, interval_unit }` object so the shape matches the spec.
- *call*: `next_due` is the phase anchor. Without it, "every 2 weeks" in weekly iterations
  would fire every week. The person sets it as **"first due on"** when creating or editing an
  activity (optional, default today); generation advances it past the end of the generated
  window, and `GET /plan` returns it so the form can show "next due". `activity_state_before`
  on the iteration lets delete-iteration roll it back.

## 6. Behaviour

### 6.1 Permissions (*call*)

Every sidecar request forwards the incoming `Cookie` header to `GET <YUVOMI_INTERNAL_URL>/api/v1/auth/me`
(answer cached 5 s keyed by cookie). The user id, role and `permissions.modules['ext:cleaningplan']`
come only from that answer:
- `none` → 403 for everything.
- `read` → GET only.
- `write` (and role `admin`) → everything.
Mutating requests additionally require `Origin` equal to `PUBLIC_ORIGIN` and an `X-CSRF-Token`
header equal to Yuvomi's `csrf-token` cookie (double-submit; the cookie is readable by same-origin
script, which is how `/api.js` already uses it, and unreadable cross-origin).

### 6.2 Generation (spec Workflow A, with the two-phase shape)

1. User picks a start date (default: tomorrow, or the day after the last iteration's end) and
   a length (default 7 days). `POST /iterations { start_date, end_date }`.
2. Sidecar, in one transaction: snapshots every active activity's `next_due`; for each active
   activity computes due dates `d = next_due, next_due + interval, …` while `d ≤ end_date`
   (dates before `start_date` are skipped but still advance; months add calendar months and
   clamp the day); inserts one `todos` row per date with title `"<Room>: <Activity>"`,
   `due_time = target_time`, `assignee_id = default_assignee_id`; sets `next_due` to the first
   date after `end_date`. Returns the iteration with its todos (no Yuvomi tasks yet).
3. Browser, for each todo without `yuvomi_task_id`: `api.post('/tasks', { title, due_date,
   due_time, assigned_to, category: <category_key>, tags: ['cleaningplan', 'cleaningplan:<iteration_id>'],
   description: 'Cleaning plan, <room> / <activity>' })`, then
   `PATCH /iterations/:id/todos/:todoId { yuvomi_task_id }`. Sequential, so a 429 is unlikely.
4. A todo left without a task (reload, network) shows as "not created yet"; the iteration view
   offers "Create missing tasks", which repeats step 3 for those rows only. Nothing is ever
   created twice because the row is the unit of truth.

- *call*: null target time → the task gets **no** `due_time`, which in Yuvomi means "that day".
  The spec's 23:59:59 cannot be expressed (minutes only) and would render as a 23:59 deadline.
- *call*: tasks use a household task category named "Cleaning" that the module ensures exists
  on first generation (`POST /tasks/categories`; on 409 it looks the key up from
  `GET /tasks/categories`) and remembers under `settings.category_key`.
- *call*: an activity created after an iteration was generated is not back-filled into it.
- *call*: the task body omits `points`, so Yuvomi's household default applies and ticking a
  cleaning task off books the usual points, which matches the spec's "bounty board" reading of
  completion. Suppressing points (`points: 0`) is a one-line change if a household wants that.
- *call*: titles are cut to Yuvomi's 200-character limit (room first, then activity).

### 6.3 Reading state (spec Workflow B)

The iteration view fetches `GET /api/v1/tasks?tag=cleaningplan:<iteration_id>` (statuses open,
in_progress, done; archived included) and joins by `yuvomi_task_id`. For done tasks it reads
who/when from `GET /api/v1/tasks/completions` filtered client-side by task id. A task deleted in
Yuvomi shows as "removed in Tasks". The module never changes task state itself.

### 6.4 Deleting an iteration (*call*)

Only the **newest** iteration can be deleted (older ones answer 409 `not_newest`): deleting a
middle one would rewind `next_due` past newer iterations and the next generation would repeat
their to-dos. `DELETE /iterations/:id` removes the records and restores `next_due` from
`activity_state_before` for activities that still exist. Before calling it, the browser deletes
the still-open Yuvomi tasks of that iteration (`DELETE /api/v1/tasks/:id`) and leaves done ones
alone (history stays). Deleting a room or an activity never touches generated tasks.

## 7. Sidecar API (`/api/extensions/cleaningplan`, JSON, `{ data }` / `{ error, code }` like core)

```
GET    /me                          -> { data: { user_id, access: 'read'|'write' } }
GET    /plan                        -> { data: { rooms: [ { …room, activities: [ …activity, next_due, schedule:{…} ] } ] } }
POST   /rooms                       { name }
PATCH  /rooms/:id                   { name?, sort_order? }
DELETE /rooms/:id
POST   /rooms/:id/activities        { name, schedule:{interval_value, interval_unit}, default_assignee_id?, target_time?, first_due? }
PATCH  /activities/:id              any of the above + active (first_due rewrites next_due)
DELETE /activities/:id
GET    /iterations                  -> list, newest first, with todo counts
POST   /iterations                  { start_date, end_date }        -> 201 iteration + todos
GET    /iterations/:id              -> iteration + todos
PATCH  /iterations/:id/todos/:tid   { yuvomi_task_id }
DELETE /iterations/:id              newest only, 409 otherwise
GET    /settings  /  PATCH /settings  { category_key }
GET    /health                      (unauthenticated, for the container healthcheck)
```
Validation mirrors Yuvomi's style: 400 with a message for bad input, 404 for unknown ids,
`start_date ≤ end_date`, window at most 92 days, `interval_value` 1–365, names 1–100 chars.

## 8. Module page (`modules/cleaningplan/`)

Manifest: `id: cleaningplan`, `page.composition: data`, `page.width: content`, menu icon
`sparkles`, accent `#0EA5E9`, `capabilities.permissions.module` (gives `ext:cleaningplan`),
`capabilities.api.prefix: /api/extensions/cleaningplan`, `i18n.defaultLocale: en`, locales
`en` and `de`.

One page, two sections under one header (title "Cleaning plan", header action "Generate
iteration"):
1. **Plan**: rooms as cards; each lists its activities as rows "name · every 2 days ·
   Alex · 18:00" with an edit control; "Add activity" per room; "Add room" at the end. Editing
   uses an inline form row (not a modal) with: name, interval value + unit select, assignee
   select (members from `GET /api/v1/family/members`, "nobody" first), time input, and
   "first due on" date input.
2. **Iterations**: list "3 – 9 Nov · 23 to-dos · 10 done"; opening one (page state, mirrored in
   the query string `?iteration=<id>` because module routes match the path exactly, so there
   are no sub-routes) shows its to-dos grouped
   by day with a state mark, assignee, and for done ones "done by Sam, Tue 14:02"; "Create
   missing tasks" appears only when some rows lack a task; "Delete iteration" with a confirm.
Read-only members see the same page without the controls. Empty states: no rooms yet; no
iterations yet. All strings via `t('extensions.cleaningplan.*')`. Every listener takes
`context.signal`; every `await` is followed by a `signal.aborted` check.

Left to the builder: exact markup inside the sections (use `renderPageSection`,
`renderListSection`; class names prefixed `cleaningplan-`), the date-input widget (native
`<input type="date">` is fine), and how the sidecar client wraps `fetch` (one small
`lib/client.js` that adds `credentials: 'same-origin'` and the CSRF header).

## 9. Repository and dev environment

```
modules/cleaningplan/   module.json index.js style.css lib/*.js locales/{en,de}.json
service/                Dockerfile server.mjs app/*.mjs (auth, db, schedule, routes) test/*.test.mjs
docker-compose.yml      caddy (:3000) + yuvomi (+ TRUST_PROXY=1) + cleaningplan-api
Caddyfile.dev
scripts/dev-setup.sh
```
Tests: `node --test service/test` covers date generation (days/weeks/months, phase carry-over,
window skipping, month clamping), the permission gate (none/read/write, missing cookie,
Yuvomi down → 502), CSRF/Origin refusal, two-phase idempotency. The module's browser code keeps
its pure parts (grouping by day, label formatting) in `lib/` so `node --test` can cover them with
no DOM.
Acceptance walk-through on the dev instance: add a room with a daily and a 2-day activity,
generate a 7-day iteration, see 7 + 4 (or 3) tasks in Yuvomi's Tasks under "Cleaning" with the
right dates and assignee, tick one off in Tasks, see it done with name and time in the module.

## 10. Open question for the user

1. The sidecar (section 4): acceptable that running this module means one more container and a
   proxy rule? If not, the only browser-only option is per-device `localStorage`, and the
   household-sharing goal goes.

## 11. Calls made after the builder check (2026-11-02)

- Activities take an optional "first due on" date (`first_due`), default today (section 5, 7, 8).
- Generated tasks take the household's default points, not zero (section 6.2).
- Only the newest iteration can be deleted (section 6.4).
- Members come from `GET /api/v1/family/members`; the opened iteration lives in `?iteration=`;
  titles are trimmed to 200 characters.

## 12. Calls made during the build (2026-11-02)

- The "Generate iteration" button sits in the Iterations section head rather than the page
  toolbar (section 8 said toolbar): one render path for the section. With many rooms it is
  one screen lower than planned; revisit if that bites.
- Monthly schedules keep the day of month they were first due on (`anchor_day`), so Jan 31
  → Feb 28 → Mar 31 rather than drifting to the 28th.
- A todo is linked to a Yuvomi task once (`409 already_linked` for a second writer), the
  page runs one iteration action at a time, and "Create missing tasks" adopts an unlinked
  task of the iteration with the same title and date before creating one.
- Deleting an iteration re-reads its tasks from Yuvomi first, so a task completed after the
  page was opened is kept with its history.
- The stored task category key is re-checked against Yuvomi on every generation.
- An iteration carries optional free-form tags (`POST /iterations { tags: [...] }`, entered
  comma-separated in the generate form), added to every task it creates after the two
  automatic ones, so a household can group a generation's tasks in Tasks by, say, `week-46`.
  Requested 2026-11-02; Yuvomi's limits (32 tags, 64 characters, case-insensitive) apply.
- An iteration can be limited to some rooms (`room_ids`, a checkbox per room in the form, all
  ticked by default). Only those rooms' activities are generated and have their `next_due`
  advanced; the others keep their phase, so a later iteration for them over the same window
  does not duplicate anything. The row names the rooms it covered. Requested 2026-11-02.
