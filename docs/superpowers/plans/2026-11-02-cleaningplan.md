# Cleaning Plan Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Yuvomi third-party module that stores a room/activity cleaning plan in a sidecar service and generates each iteration's to-dos as native Yuvomi tasks.

**Architecture:** A zero-dependency Node 24 sidecar (`node:http` + `node:sqlite`) holds rooms, activities, iterations and todo records, authenticating every request by forwarding the Yuvomi session cookie to `GET /api/v1/auth/me`. The browser module page talks to the sidecar at `/api/extensions/cleaningplan/` and to Yuvomi's `/api/v1` through `/api.js` for tasks, members and completions. A reverse proxy (Caddy in dev) puts both on one origin.

**Tech Stack:** Node 24 (`node:http`, `node:sqlite`, `node:test`), vanilla ES modules + plain CSS in the browser, Docker Compose + Caddy 2 for the dev instance. Yuvomi 2.84.0.

**Spec:** `docs/superpowers/specs/2026-11-02-cleaningplan-design.md`

## Global Constraints

- No npm dependencies anywhere; no bundler, no transpiler. Browser code is ES modules served as-is.
- No `innerHTML`. Insert with `replaceChildren()`, `insertAdjacentHTML()` or DOM APIs; every untrusted string goes through `esc()` from `/utils/html.js`.
- No raw colors, radii or shadows in CSS: tokens from Yuvomi's `tokens.css` (`--color-*`, `--radius-*`, `--space-*`). Reuse global classes `btn btn--primary|--secondary|--ghost|--danger|--sm`, `form-row`, `form-label`, `input`, `select`, `list-group`, `list-row`, `list-row__main|__name|__meta|__end|__actions`.
- Layout only through `/utils/page-layout.js` (`renderPageHeader`, `renderPageTitle`, `renderPageActions`, `renderPageBody`, `renderPageSection`, `renderListSection`); never set page width or gutters.
- Every listener registered with `{ signal }` from `context.signal`; after every `await`, `if (signal.aborted) return;`.
- Sidecar API prefix is exactly `/api/extensions/cleaningplan`; responses are `{ data }` or `{ error, code, reason? }`.
- Validation limits: names 1–100 chars, `interval_value` integer 1–365, `interval_unit` ∈ `days|weeks|months`, `target_time` `HH:MM` or null, dates `YYYY-MM-DD`, iteration window ≤ 92 days, task titles ≤ 200 chars.
- Git: the user commits. No task commits.
- Tests run with `node --test <dir>` on Node ≥ 24 (local Node is 26; the images are `node:24-slim`).

## Review Focus

1. A session cookie for a user whose `ext:cleaningplan` permission is `read` must get 403 on every POST/PATCH/DELETE, including `POST /iterations` → Task 3 test `write routes refuse read access`.
2. Pressing "Generate" twice for the same window must not create a second batch of Yuvomi tasks → Task 4 test `second iteration over an overlapping window generates nothing new` (next_due has moved on) plus Task 8's "Create missing tasks" only touching rows with `yuvomi_task_id IS NULL`.
3. A monthly activity first due on the 31st must land on the last day of shorter months and not skip → Task 2 test `addInterval clamps month end`.
4. Yuvomi being down must not look like "not logged in": sidecar answers 502 `yuvomi_unavailable`, the page shows a retry error → Task 3 test `Yuvomi unreachable answers 502`, Task 9 manual check.
5. A room name or activity name containing `<b>` or quotes must render literally in the page and in the generated task title → Task 6 test `taskTitle keeps characters, trims to 200`, Task 7 renders through `esc()`.

---

## File structure

```
service/
  server.mjs               entry: reads env, opens db, starts http server
  app/db.mjs               openDb + every query (rooms, activities, iterations, todos, settings)
  app/schedule.mjs         pure date arithmetic and window generation
  app/auth.mjs             Yuvomi session resolution, access level, CSRF/Origin check, HttpError
  app/routes.mjs           createHandler({ db, auth }): routing, validation, JSON I/O
  test/schedule.test.mjs, db.test.mjs, auth.test.mjs, routes.test.mjs, helpers.mjs
  Dockerfile
modules/cleaningplan/
  module.json, index.js, style.css, locales/en.json, locales/de.json
  lib/client.js            fetch wrapper for the sidecar (credentials, CSRF header, ExtError)
  lib/format.js            pure helpers: groupByDay, todoState, scheduleLabel
  lib/yuvomi-tasks.js      category lookup, task creation per todo, task + completion fetch, open-task delete
  lib/plan-view.js         Plan section: render + bind
  lib/iterations-view.js   Iterations section: render + bind
  test/format.test.mjs
docker-compose.yml, Caddyfile.dev, README.md
```

---

### Task 1: Sidecar data layer

**Files:**
- Create: `service/app/db.mjs`, `service/test/db.test.mjs`

**Interfaces:**
- Produces (all synchronous, `db` is the object returned by `openDb`):
  - `openDb(path: string): Db` — opens `node:sqlite` `DatabaseSync`, enables `foreign_keys`, runs the schema (idempotent `CREATE TABLE IF NOT EXISTS`), writes `settings.schema_version = '1'`.
  - `listPlan(db): { rooms: Room[] }` where `Room = { id, name, sort_order, activities: Activity[] }` and `Activity = { id, room_id, name, default_assignee_id, target_time, next_due, active, sort_order, schedule: { interval_value, interval_unit } }` (`active` is boolean).
  - `createRoom(db, { name }): Room` (no activities key needed); `updateRoom(db, id, { name?, sort_order? }): Room | null`; `deleteRoom(db, id): boolean`.
  - `createActivity(db, roomId, { name, interval_value, interval_unit, default_assignee_id = null, target_time = null, first_due, active = true }): Activity | null` (null when the room is missing; `first_due` becomes `next_due`).
  - `updateActivity(db, id, patch): Activity | null` where `patch` may hold any of the create fields (`first_due` rewrites `next_due`).
  - `deleteActivity(db, id): boolean`.
  - `listIterations(db): IterationSummary[]` newest first, `IterationSummary = { id, start_date, end_date, created_at, created_by, todo_count, linked_count }`.
  - `getIteration(db, id): Iteration | null`, `Iteration = IterationSummary & { todos: Todo[] }`, `Todo = { id, iteration_id, activity_id, room_name, activity_name, title, due_date, due_time, assignee_id, yuvomi_task_id }` ordered by `due_date, due_time, id`.
  - `createIteration(db, { start_date, end_date, created_by, generate }): Iteration` — one transaction: snapshot `{ [activity_id]: next_due }` of active activities into `activity_state_before` (JSON), call `generate(activity, start_date, end_date)` (injected, Task 2 shape `{ dates, next_due }`) per active activity, insert one todo per date with `title = taskTitle(room.name, activity.name)`, `room_name`, `activity_name`, `due_time = activity.target_time`, `assignee_id = activity.default_assignee_id`, then set the activity's `next_due`.
  - `taskTitle(roomName, activityName): string` — `${room}: ${activity}` cut to 200 characters.
  - `linkTodoTask(db, iterationId, todoId, yuvomiTaskId): Todo | null`.
  - `deleteIteration(db, id): 'deleted' | 'not_found' | 'not_newest'` — restores `next_due` from the snapshot for activities that still exist.
  - `getSetting(db, key): string | null`, `setSetting(db, key, value): void`.

- [ ] **Step 1: Write the failing tests** in `service/test/db.test.mjs` using `openDb(':memory:')`:
  - `createRoom returns the room and listPlan nests activities under it`
  - `createActivity on unknown room returns null`
  - `updateActivity with first_due rewrites next_due and keeps the rest`
  - `deleteRoom cascades its activities` (listPlan shows none)
  - `createIteration stores one todo per generated date and advances next_due` (inject `generate` returning `{ dates: ['2026-11-03','2026-11-05'], next_due: '2026-11-07' }`; assert todos have `title 'Kitchen: Vacuum'`, `due_time '18:00'`, `assignee_id 2`, and the activity's `next_due === '2026-11-07'`)
  - `createIteration skips inactive activities`
  - `deleteIteration restores next_due and refuses a non-newest one` (two iterations: deleting the first → `'not_newest'`; deleting the second → `'deleted'` and `next_due` back to the snapshot value)
  - `linkTodoTask sets yuvomi_task_id and returns null for a foreign iteration`
  - `taskTitle cuts to 200 characters` (room of 150 chars + activity of 100 chars → length 200)
  - `settings round-trip`
- [ ] **Step 2: Run** `node --test service/test/db.test.mjs` → FAIL: cannot find module `db.mjs`.
- [ ] **Step 3: Implement `service/app/db.mjs`** with the schema from the spec (section 5; `todos.activity_id` has `ON DELETE SET NULL`, `rooms`/`iterations` cascade). Booleans are stored as 0/1 and mapped on read. Use `db.exec('BEGIN')`/`COMMIT`/`ROLLBACK` around `createIteration` and `deleteIteration`.
- [ ] **Step 4: Run** `node --test service/test/db.test.mjs` → all PASS.

---

### Task 2: Schedule arithmetic

**Files:**
- Create: `service/app/schedule.mjs`, `service/test/schedule.test.mjs`

**Interfaces:**
- Produces:
  - `addInterval(date: 'YYYY-MM-DD', value: number, unit: 'days'|'weeks'|'months'): 'YYYY-MM-DD'` — calendar arithmetic in UTC, no time zones; months add calendar months and clamp the day to the target month's length.
  - `dueDatesInWindow(activity: { next_due, schedule: { interval_value, interval_unit } }, start: string, end: string): { dates: string[], next_due: string }` — `d = next_due`; while `d <= end`: push `d` if `d >= start`; `d = addInterval(d, …)`. Returns the first `d > end` as the new `next_due` (unchanged when `next_due > end`).
  - `isIsoDate(s): boolean` — `YYYY-MM-DD` and a real calendar date.

- [ ] **Step 1: Write the failing tests**:
  - `addInterval adds days, weeks, months` (`2026-11-03 +2 days → 2026-11-05`, `+1 weeks → 2026-11-10`, `+1 months → 2026-12-03`)
  - `addInterval clamps month end` (`2026-01-31 +1 months → 2026-02-28`; `2024-01-31 +1 months → 2024-02-29`)
  - `addInterval crosses a year` (`2026-12-30 +5 days → 2027-01-04`)
  - `dueDatesInWindow daily in a week yields 7 dates and next_due after the window` (`next_due 2026-11-03`, every 1 day, window `2026-11-03`..`2026-11-09` → 7 dates, `next_due 2026-11-10`)
  - `dueDatesInWindow every 2 days yields 4 dates` (same window → `03,05,07,09`, next `11`)
  - `dueDatesInWindow carries phase from before the window` (`next_due 2026-11-01`, every 3 days, window `03..09` → `04, 07`, next `10`)
  - `dueDatesInWindow beyond the window yields nothing and keeps next_due` (`next_due 2026-12-01` → `[]`, `next_due 2026-12-01`)
  - `isIsoDate rejects 2026-02-30 and 2026-13-01`
- [ ] **Step 2: Run** `node --test service/test/schedule.test.mjs` → FAIL.
- [ ] **Step 3: Implement `service/app/schedule.mjs`** with `Date.UTC`-based arithmetic.
- [ ] **Step 4: Run** → PASS.

---

### Task 3: Session resolution and CSRF gate

**Files:**
- Create: `service/app/auth.mjs`, `service/test/auth.test.mjs`, `service/test/helpers.mjs`

**Interfaces:**
- Produces:
  - `class HttpError extends Error { constructor(status: number, reason: string, message?: string) }`.
  - `createAuth({ yuvomiUrl, publicOrigin, fetch = globalThis.fetch, cacheMs = 5000, now = Date.now }): Auth`.
  - `Auth.resolve(req): Promise<{ userId: number, role: string, access: 'none'|'read'|'write' }>` — forwards `req.headers.cookie` to `GET ${yuvomiUrl}/api/v1/auth/me`; no cookie or Yuvomi 401 → `HttpError(401, 'not_authenticated')`; network error or non-200 → `HttpError(502, 'yuvomi_unavailable')`; `access` from `permissions.modules['ext:cleaningplan']` (`'none'`→none, `'read'`→read, anything else or missing→write; `user.role === 'admin'` is always write). Cached per cookie string for `cacheMs`.
  - `Auth.assertCsrf(req): void` — for `POST|PATCH|PUT|DELETE`: `Origin` header must equal `publicOrigin` exactly, and `X-CSRF-Token` must be non-empty and equal the `csrf-token` cookie, else `HttpError(403, 'csrf_invalid')`.
  - `parseCookies(header: string | undefined): Record<string, string>`.
- `service/test/helpers.mjs`: `startFakeYuvomi(handler): Promise<{ url, close }>` (a `node:http` server) and `meResponse({ id = 1, role = 'member', access = 'write' })` building the `/auth/me` body shape `{ user: { id, role, display_name }, permissions: { modules: { 'ext:cleaningplan': access } } }`.

- [ ] **Step 1: Write the failing tests** (fake Yuvomi via helpers; `req` can be a plain `{ method, headers }` object):
  - `resolve maps write/read/none and admin` (four cookies, four answers; admin with `'read'` still → write)
  - `resolve without cookie throws 401 not_authenticated`
  - `resolve when Yuvomi answers 401 throws 401`
  - `Yuvomi unreachable answers 502` (yuvomiUrl pointing at a closed port)
  - `resolve caches per cookie for cacheMs` (fake counts calls; second call within 5 s → 1 call; after `now` advances 6 s → 2)
  - `assertCsrf accepts matching origin and token, refuses mismatch` (wrong Origin → 403; token ≠ cookie → 403; GET never checks)
- [ ] **Step 2: Run** `node --test service/test/auth.test.mjs` → FAIL.
- [ ] **Step 3: Implement `service/app/auth.mjs`.**
- [ ] **Step 4: Run** → PASS.

---

### Task 4: HTTP routes and server entry

**Files:**
- Create: `service/app/routes.mjs`, `service/server.mjs`, `service/test/routes.test.mjs`

**Interfaces:**
- Consumes: Task 1 `db.mjs` functions, Task 2 `dueDatesInWindow`, `isIsoDate`, Task 3 `createAuth`, `HttpError`.
- Produces:
  - `createHandler({ db, auth, prefix = '/api/extensions/cleaningplan' }): (req, res) => void` implementing spec section 7 exactly (paths relative to `prefix`; unknown path → 404 `not_found`; body limit 64 KiB → 413; invalid JSON → 400 `bad_json`). `GET /health` needs no auth. Every other route calls `auth.resolve`; `access 'none'` → 403 `forbidden`; mutating routes require `access 'write'` → else 403 `read_only`, and call `auth.assertCsrf` first.
  - Validation per Global Constraints; failures → 400 with `reason` ∈ `bad_name | bad_interval | bad_time | bad_date | bad_window | bad_assignee | bad_sort_order`. `start_date > end_date` or span > 92 days → `bad_window`. `POST /iterations` passes `created_by = userId` and `generate = (activity, start, end) => dueDatesInWindow(activity, start, end)`. Activity bodies carry `schedule: { interval_value, interval_unit }`; the route flattens that into the `createActivity`/`updateActivity` input and validates `default_assignee_id` as a positive integer or null.
  - `DELETE /iterations/:id` → 200 `{ data: { id, deleted: true } }`, 404, or 409 `not_newest`.
  - `GET /me` → `{ data: { user_id, access } }`.
  - `server.mjs`: env `PORT` (default 3100), `DB_PATH` (default `/data/cleaningplan.db`), `YUVOMI_INTERNAL_URL` (required), `PUBLIC_ORIGIN` (required); logs one JSON line per request `{ ts, method, path, status, ms }`; `SIGTERM` closes the server.

- [ ] **Step 1: Write the failing tests** in `service/test/routes.test.mjs`: start the handler on port 0 with `openDb(':memory:')` and a fake Yuvomi; a small `call(method, path, { body, access = 'write', csrf = true })` helper that sets `Cookie: sid=<access>; csrf-token=t1`, `Origin`, `X-CSRF-Token`.
  - `health needs no auth` (200 without cookie)
  - `rooms and activities round trip` (POST room → 201; POST activity with `schedule: { interval_value: 2, interval_unit: 'days' }`, `first_due: '2026-11-03'` → 201 and GET /plan shows `next_due '2026-11-03'`; PATCH name; DELETE → 200; GET /plan empty)
  - `activity validation` (interval 0 → 400 `bad_interval`; `target_time '25:00'` → `bad_time`; name 101 chars → `bad_name`; `interval_unit 'years'` → `bad_interval`)
  - `write routes refuse read access` (POST /rooms, POST /iterations, DELETE /rooms/1 with `access: 'read'` → 403 `read_only`; GET /plan still 200)
  - `none access is refused everywhere` (GET /plan → 403 `forbidden`)
  - `mutations without csrf are refused` (`csrf: false` → 403 `csrf_invalid`)
  - `iteration generation end to end` (daily + every-2-days activities, `POST /iterations { start_date: '2026-11-03', end_date: '2026-11-09' }` → 201 with 11 todos; `GET /iterations` shows `todo_count 11, linked_count 0`; `PATCH /iterations/:id/todos/:tid { yuvomi_task_id: 41 }` → `linked_count 1`)
  - `second iteration over an overlapping window generates nothing new` (same window again → 201 with 0 todos)
  - `window validation` (`end < start` → 400 `bad_window`; 93-day span → `bad_window`)
  - `delete iteration` (non-newest → 409 `not_newest`; newest → 200 and `GET /plan` shows `next_due` restored)
  - `unknown path is 404 and bad json is 400`
- [ ] **Step 2: Run** `node --test service/test/routes.test.mjs` → FAIL.
- [ ] **Step 3: Implement `service/app/routes.mjs` and `service/server.mjs`.** Route matching: split the path after the prefix, match on `[segment, id]` tuples; keep the handler table flat (one function per route) so the file reads like section 7 of the spec.
- [ ] **Step 4: Run** `node --test service/test` → all PASS (Tasks 1–4).

---

### Task 5: Sidecar container, proxy and dev compose

**Files:**
- Create: `service/Dockerfile`, `Caddyfile.dev`
- Modify: `docker-compose.yml`, `README.md`, `modules/cleaningplan/module.json`

**Interfaces:**
- Consumes: Task 4 `server.mjs` env contract.
- Produces: the dev origin `http://localhost:3000` serving Yuvomi and, under `/api/extensions/cleaningplan/`, the sidecar.

- [ ] **Step 1: `service/Dockerfile`**: `FROM node:24-slim`, `WORKDIR /app`, `COPY server.mjs app/ ./` (no tests), `RUN mkdir -p /data && chown node:node /data`, `USER node`, `ENV PORT=3100 DB_PATH=/data/cleaningplan.db`, `EXPOSE 3100`, `HEALTHCHECK` with `node -e` GET `/api/extensions/cleaningplan/health`, `CMD ["node","server.mjs"]`.
- [ ] **Step 2: `Caddyfile.dev`**:
  ```
  :3000 {
    handle /api/extensions/cleaningplan/* { reverse_proxy cleaningplan-api:3100 }
    handle { reverse_proxy yuvomi:3000 }
  }
  ```
- [ ] **Step 3: `docker-compose.yml`**: add `caddy` (`caddy:2-alpine`, ports `127.0.0.1:3000:3000`, mounts `./Caddyfile.dev:/etc/caddy/Caddyfile:ro`), add `cleaningplan-api` (`build: ./service`, env `YUVOMI_INTERNAL_URL=http://yuvomi:3000`, `PUBLIC_ORIGIN=http://localhost:3000`, named volume `cleaningplan-data:/data`), remove the host port from `yuvomi` and set `TRUST_PROXY: "1"`; keep everything else. Add `volumes: cleaningplan-data: {}`.
- [ ] **Step 4: `module.json`**: `page.composition: "data"`, `page.width: "content"`, add `capabilities.api.prefix: "/api/extensions/cleaningplan"`, description "Rooms, activities and schedules; generates each iteration's to-dos as Yuvomi tasks.", version `0.1.0`.
- [ ] **Step 5: Verify**: `docker compose up -d --build`, then
  - `curl -s http://localhost:3000/health` → 200 (Yuvomi through Caddy)
  - `curl -s http://localhost:3000/api/extensions/cleaningplan/health` → `{"data":{"ok":true}}`
  - `curl -s http://localhost:3000/api/extensions/cleaningplan/plan` without cookie → 401
  - with the admin cookie jar from `scripts/dev-setup.sh` flow: `GET /me` → `{ data: { user_id: 1, access: 'write' } }`
  - `GET /api/v1/modules?admin=1` still lists `cleaningplan` with `error: null`.
- [ ] **Step 6: README**: replace the dev-instance section with the three-container layout, the reset command `docker compose down -v && rm -rf .dev`, and a "Production" note: run the `service` image beside Yuvomi and add the one proxy rule from `Caddyfile.dev` to your proxy.

---

### Task 6: Browser client and pure helpers

**Files:**
- Create: `modules/cleaningplan/lib/client.js`, `modules/cleaningplan/lib/format.js`, `modules/cleaningplan/test/format.test.mjs`

**Interfaces:**
- Produces:
  - `client.js`: `export const ext = { get(path, { signal }), post(path, body, { signal }), patch(path, body, { signal }), delete(path, { signal }) }` — base `/api/extensions/cleaningplan`, `credentials: 'same-origin'`, JSON body, header `X-CSRF-Token` read from the `csrf-token` cookie on mutations, returns `json.data`; non-2xx throws `ExtError` with `{ status, reason, message }` (`export class ExtError extends Error`). Aborted requests throw the `AbortError` fetch produces; callers check `signal.aborted`.
  - `format.js` (pure, importable from Node): `groupByDay(todos): Array<{ date: string, todos: Todo[] }>` sorted by date then `due_time` (nulls last) then id; `todoState(todo, taskById: Map<number, Task>): 'missing' | 'removed' | 'open' | 'done'` (`missing` when `yuvomi_task_id == null`, `removed` when the id is not in the map, `done` when `task.status === 'done'`, else `open`); `scheduleLabel({ interval_value, interval_unit }, t): string` using keys `extensions.cleaningplan.every.<unit>` with `{ n }`; `memberName(id, members): string` (`display_name` or `''`).

- [ ] **Step 1: Write the failing tests** in `modules/cleaningplan/test/format.test.mjs`:
  - `groupByDay sorts by date, time then id, nulls last`
  - `todoState covers missing, removed, open, done`
  - `scheduleLabel calls t with the unit key and n` (pass a fake `t` that returns `${key}|${JSON.stringify(params)}`)
- [ ] **Step 2: Run** `node --test modules/cleaningplan/test` → FAIL.
- [ ] **Step 3: Implement `format.js` and `client.js`.**
- [ ] **Step 4: Run** → PASS.

---

### Task 7: Plan section (rooms and activities)

**Files:**
- Create: `modules/cleaningplan/lib/plan-view.js`
- Modify: `modules/cleaningplan/index.js`, `modules/cleaningplan/style.css`, `modules/cleaningplan/locales/en.json`, `modules/cleaningplan/locales/de.json`

**Interfaces:**
- Consumes: Task 6 `ext`, `scheduleLabel`, `memberName`; Yuvomi `api.get('/family/members')` → `{ data: Member[] }` with `{ id, display_name }`.
- Produces:
  - `renderPlanSection({ plan, members, canWrite, editing }): string` — HTML for the Plan section: one `list-group` per room (title = room name, `list-row` per activity: name, meta line "`scheduleLabel` · member · HH:MM · next due <date>", and when `canWrite` an edit button), an "Add activity" row per room, an "Add room" control at the end; `editing` is `null | { kind: 'room'|'activity', id?: number, roomId?: number }` and renders an inline form (`form-row`s: name; for activities also interval value `input type=number`, unit `select`, assignee `select` with "nobody" first, time `input type=time`, first due `input type=date`, active `form-check`) with Save/Cancel/Delete buttons. Empty plan → `emptyStateHTML({ icon: 'sparkles', title, description })` from `/utils/empty-state.js`.
  - `bindPlanSection(root: Element, handlers: { onEdit(editing), onCancel(), onSaveRoom(id|null, { name }), onDeleteRoom(id), onSaveActivity(id|null, roomId, input), onDeleteActivity(id) }, signal)` — one delegated `click` and one `submit` listener on `root`, reading `data-action` / `data-id` / `data-room-id` attributes.
  - `index.js`: `render(container, { user, page, signal })` loads `ext.get('/me')`, `ext.get('/plan')`, `api.get('/family/members')` in parallel, keeps `state = { access, plan, members, editing, iterations, open, tasksById, completions }`, and exposes `refresh()` that re-renders both sections into stable mounts (`#cleaningplan-plan`, `#cleaningplan-iterations`) inside `renderPageBody`. Header: `renderPageHeader({ title: renderPageTitle(t('extensions.cleaningplan.title')), actions: renderPageActions(<generate button, only when canWrite>) })`. Errors from `ext` → `loadErrorHTML({ title, description, retryLabel })` with a retry button that calls `refresh()`.

- [ ] **Step 1: Locale keys** (en and de, flat): `title`, `menu`, `module`, `plan.title`, `plan.empty.title`, `plan.empty.description`, `room.add`, `room.name`, `activity.add`, `activity.name`, `activity.interval`, `activity.assignee`, `activity.nobody`, `activity.time`, `activity.firstDue`, `activity.nextDue`, `activity.active`, `every.days`, `every.weeks`, `every.months` (en: "every {{n}} days" …), `action.save`, `action.cancel`, `action.delete`, `action.edit`, `confirm.deleteRoom`, `confirm.deleteActivity`, `error.load`, `error.retry`, `readOnly` ("You can view this plan but not change it.").
- [ ] **Step 2: Implement `plan-view.js`** per the interface; all text through `t()`, all values through `esc()`.
- [ ] **Step 3: Wire `index.js`**: handlers call `ext.post('/rooms', …)` etc., then `refresh()`; `onDelete*` uses `window.confirm(t(...))`. `canWrite = state.access === 'write'`; read access shows the `readOnly` hint under the header.
- [ ] **Step 4: `style.css`**: only `.cleaningplan-` prefixed rules, token values only (`--space-*`, `--color-text-secondary`, `--radius-*`); the inline edit form stacks fields on narrow widths with a plain `grid` + `gap: var(--space-2)`.
- [ ] **Step 5: Verify in the browser** at `http://localhost:3000/m/cleaningplan` as admin: add room "Kitchen", add activities "Vacuum" (every 2 days, Sam, 18:00, first due tomorrow) and "Wipe counters" (daily, nobody, no time); edit one; refresh the page and see the same state; log in as `kim` in a private window, set `ext:cleaningplan` to `read` for Kim in Settings → Household → Roles and permissions, and see the page without controls plus the read-only hint.

---

### Task 8: Iterations section (generate, state, create missing, delete)

**Files:**
- Create: `modules/cleaningplan/lib/iterations-view.js`, `modules/cleaningplan/lib/yuvomi-tasks.js`
- Modify: `modules/cleaningplan/index.js`, `modules/cleaningplan/style.css`, locales

**Interfaces:**
- Consumes: Task 6 `ext`, `groupByDay`, `todoState`, `memberName`; Task 4 iteration routes; Yuvomi: `api.get('/tasks/categories')` → `{ data: [{ key, name }] }`, `api.post('/tasks/categories', { name })` → 201 `{ data: { key } }` or 409, `api.post('/tasks', body)` → `{ data: { id } }`, `api.get('/tasks?tag=cleaningplan:<id>')` → `{ data: Task[] }` (`id, status, assigned_to, assigned_users, tags`), `api.get('/tasks/completions?limit=200')` → `{ data: [{ task_id, completed_at, person_user_id, person_name }] }`, `api.delete('/tasks/<id>')`.
- Produces:
  - `yuvomi-tasks.js`: `ensureCategoryKey({ signal }): Promise<string>` (setting `category_key` from `ext.get('/settings')`; otherwise find a category named "Cleaning" in `GET /tasks/categories`, else create it, then `ext.patch('/settings', { category_key })`); `createTaskForTodo(todo, { iterationId, categoryKey, signal }): Promise<number>` posting `{ title, due_date, due_time?, assigned_to?, category, tags: ['cleaningplan', 'cleaningplan:<iterationId>'], description: 'Cleaning plan: <room> / <activity>' }` and returning the task id; `createMissingTasks(iteration, { categoryKey, signal, onProgress }): Promise<{ created: number, failed: number }>` — sequential over todos with `yuvomi_task_id == null`, linking each via `ext.patch('/iterations/:id/todos/:tid', { yuvomi_task_id })`; `fetchIterationTasks(iterationId, { signal }): Promise<Map<number, Task>>`; `fetchCompletions({ signal }): Promise<Map<number, Completion>>` keyed by `task_id` (first = newest wins); `deleteOpenTasks(tasksById, { signal }): Promise<void>` deleting every task whose status is not `done`.
  - `iterations-view.js`: `renderIterationsSection({ iterations, open, tasksById, completions, members, canWrite, generating }): string` — list rows "<start> – <end> · <todo_count> to-dos · <done> done" (done counted from `tasksById` only for the open one; others show `linked_count`/`todo_count`), the open iteration expanded under its row: days from `groupByDay`, each todo as a `list-row` with a state mark (`check-ring` + `check-ring--done` for done), title, assignee name, and for done "done by <person_name>, <local date time>"; a "Create missing tasks (<n>)" button when any todo is `missing` and `canWrite`; a "Delete iteration" button on the newest when `canWrite`; the generate form (start date default = day after the newest iteration's end, else tomorrow; length `select` 7/14/28 days) shown when `generating`. Empty → `emptyStateHTML`.
  - `bindIterationsSection(root, { onOpen(id), onGenerateStart(), onGenerateSubmit({ start_date, end_date }), onGenerateCancel(), onCreateMissing(id), onDelete(id) }, signal)`.

- [ ] **Step 1: Locale keys**: `iterations.title`, `iterations.empty.title`, `iterations.empty.description`, `iterations.generate`, `iterations.start`, `iterations.length`, `iterations.days` ("{{n}} days"), `iterations.todos` ("{{n}} to-dos"), `iterations.done` ("{{n}} done"), `iterations.createMissing` ("Create missing tasks ({{n}})"), `iterations.delete`, `iterations.deleteConfirm`, `todo.missing` ("not created yet"), `todo.removed` ("removed in Tasks"), `todo.doneBy` ("done by {{name}}, {{when}}"), `todo.unassigned`, `category.name` ("Cleaning").
- [ ] **Step 2: Implement `yuvomi-tasks.js`**, then `iterations-view.js`.
- [ ] **Step 3: Wire `index.js`**: on generate submit → `ensureCategoryKey` → `ext.post('/iterations', …)` → `createMissingTasks` → `refresh()` and open the new iteration; on open → load tasks + completions for that id, mirror `?iteration=<id>` with `history.replaceState`, and read it back on first render; on delete → `window.confirm` → `deleteOpenTasks` → `ext.delete('/iterations/:id')` → `refresh()`. During generation disable the button and show progress "<created>/<total>".
- [ ] **Step 4: Verify in the browser**: with the Task 7 plan, generate a 7-day iteration starting tomorrow → the row shows 11 to-dos (7 + 4); open Yuvomi → Tasks: 11 tasks in category "Cleaning", the vacuum ones assigned to Sam at 18:00 every second day, the counters daily; tick one off in Tasks naming Kim; back in the module the row reads "done by Kim, <time>"; press Generate again for the same week → 0 new to-dos; delete the iteration → open tasks gone from Tasks, the done one stays, the activities' next due dates are back to tomorrow.

---

### Task 9: Acceptance walk-through and hardening

**Files:**
- Modify: `README.md` (usage section), `service/test/routes.test.mjs` (if gaps found), `modules/cleaningplan/index.js`

- [ ] **Step 1: Full test run**: `node --test service/test modules/cleaningplan/test` → all PASS.
- [ ] **Step 2: Review Focus checks**: stop the sidecar (`docker compose stop cleaningplan-api`), reload the page → load error with retry, not a login prompt; start it again, retry works. Stop Yuvomi only (`docker compose stop yuvomi`) → sidecar `GET /me` answers 502 `yuvomi_unavailable`.
- [ ] **Step 3: Escaping check**: rename a room to `<b>Bad</b> "kitchen"` → renders literally in the module, the generated task title shows the same characters in Tasks.
- [ ] **Step 4: README usage**: how to install the module in a real instance (copy `modules/cleaningplan` or install from GitHub, run the `service` image, proxy rule, grant `ext:cleaningplan`), and what the module does and does not do (non-goals from the spec).
- [ ] **Step 5: Report** to the user: what was built, test output, the manual checks done, anything skipped.
