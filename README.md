# yuvomi-cleaningplan

A third-party module for [Yuvomi](https://yuvomi.cloud), the self-hosted family planner.
Define rooms, the cleaning activities in each room and how often they recur, then generate
an iteration (a week, say): every due activity becomes a normal Yuvomi task with its date,
time and default assignee, so it shows on the dashboard and in Tasks, anyone can tick it
off, and Yuvomi records who did it and when. The module shows each iteration's to-dos with
that state read back from Yuvomi.

Design: `docs/superpowers/specs/2026-11-02-cleaningplan-design.md`.

## Parts

| Part | Where | What |
|---|---|---|
| Module page | `modules/cleaningplan/` | Browser code Yuvomi serves at `/m/cleaningplan` (manifest, ES modules, CSS, locales) |
| Sidecar | `service/` | Node 24 service, no dependencies, own SQLite file; holds rooms, activities, iterations and which Yuvomi task each to-do became |
| Proxy rule | `Caddyfile.dev` | Routes `/api/extensions/cleaningplan/*` to the sidecar, everything else to Yuvomi |

Yuvomi modules are browser code only and must not touch Yuvomi's database, which is why
the plan lives in the sidecar. The browser creates and reads the generated tasks through
Yuvomi's own `/api/v1`; the sidecar never needs Yuvomi credentials, it only re-checks the
caller's session against `GET /api/v1/auth/me` on every request and honours the
`ext:cleaningplan` permission (`none` / `read` / `write`) from Settings -> Household ->
Roles and permissions.

## Dev instance

Requires Docker. Everything answers on http://localhost:3000.

```sh
docker compose up -d --build   # caddy + yuvomi 2.93.0 + sidecar
./scripts/dev-setup.sh         # seeds admin + members sam, kim (all: password cleaningplan-dev)
docker compose logs -f         # module validation errors show at Yuvomi startup and on rescan
docker compose down -v && rm -rf .dev && docker compose up -d   # wipe both databases
```

Yuvomi's database and backups live in `.dev/` (gitignored), the sidecar's in the named
volume `cleaningplan-data`. Module code is read live from `modules/cleaningplan/`; reload the
browser after edits. Sidecar edits need `docker compose up -d --build cleaningplan-api`.
There is no switch to turn the login screen off; a session lasts 90 days, so each browser
profile logs in once.

Tests (Node 24 or newer, no install step):

```sh
node --import ./test/module/register.mjs --test "service/test/*.test.mjs" "test/module/*.test.mjs"
```

## Using it

1. **Plan.** Add a room, then its activities: name, an optional note (e.g.
   `* newspapers away, glasses away`; shown under the activity and added to each generated
   task's description, which Yuvomi renders as markdown), "repeats every N days/weeks/months",
   who usually does it, a time of day, and the date it is first due. The next due date is
   shown on each activity and moves forward as iterations are generated.
2. **Generate iteration.** Pick a start date (defaults to the day after the last iteration),
   a length (7, 14 or 28 days) and, if you want, only some rooms (all are ticked by default;
   rooms left out keep their schedule for a later iteration). Every activity due inside that window becomes a task in
   Yuvomi's Tasks, in the category "Cleaning", tagged `cleaningplan` and
   `cleaningplan:<iteration id>`, with the activity's assignee and time. Tags typed into the
   form (comma-separated, e.g. `week-46`) go on every task of that iteration, so Tasks can
   filter one generation. Generating the same window twice adds nothing: each activity's
   schedule has already moved on.
3. **Tick things off in Tasks**, as usual. Open the iteration in the module to see each
   to-do's state and, for done ones, who did it and when, read back from Yuvomi.
4. **Delete iteration** (newest only) removes its open tasks from Tasks, keeps done ones as
   history, and rewinds the activities' next due dates.

Members with `ext:cleaningplan` = `read` see everything without the controls.

## Installing in a real Yuvomi

1. Run the sidecar beside Yuvomi. The image is published on every release as
   `ghcr.io/la3mmchen/yuvomi-cleaningplan-api:<version>` (`:latest` points at the newest
   stable one); it needs `YUVOMI_INTERNAL_URL` (how the sidecar reaches Yuvomi),
   `PUBLIC_ORIGIN` (the origin in your browser's address bar, scheme and host exactly) and a
   volume on `/data`, named or bind-mounted (the container fixes the ownership on start).
   Back that volume up with the rest of your instance: the plan lives only there.

   ```yaml
   services:
     cleaningplan-api:
       image: ghcr.io/la3mmchen/yuvomi-cleaningplan-api:0.2.1
       restart: unless-stopped
       environment:
         YUVOMI_INTERNAL_URL: http://yuvomi:3000
         PUBLIC_ORIGIN: https://home.example
       volumes:
         - cleaningplan-data:/data
   volumes:
     cleaningplan-data: {}
   ```
2. Add one rule to your reverse proxy: `/api/extensions/cleaningplan/*` -> the sidecar's
   port 3100, before the rule that sends everything else to Yuvomi (see `Caddyfile.dev` for
   the Caddy form). Yuvomi then runs behind one proxy hop: check its `.env` and change
   `TRUST_PROXY=loopback` (what the installers write for direct access) to `TRUST_PROXY=1`,
   and set `SESSION_SECURE=true` if the proxy terminates HTTPS.
3. Install the module page: Settings -> Modules -> Add custom module with
   `https://github.com/la3mmchen/yuvomi-cleaningplan` (installs the latest release; needs
   `MODULES_ALLOW_WEB_INSTALL=true`, and the module waits disabled until an admin approves it),
   or copy `modules/cleaningplan/` into Yuvomi's `modules/` folder by hand.
   Or let the sidecar image do the copy: it carries the module page of its own version at
   `/module`, and `/install-module.sh` puts it into a modules folder mounted at `/modules`
   (two renames, owner `1000:1000`). Run it as an init container (Kubernetes) or a one-off
   `docker run --rm --entrypoint /install-module.sh -v <yuvomi-modules>:/modules <image>`,
   and page and sidecar update together. Such a folder counts as copied by hand: Yuvomi
   serves it enabled without approval, and Settings can no longer replace or delete it.
4. Grant members `ext:cleaningplan` in Settings -> Household -> Roles and permissions
   (`write` to edit the plan and generate, `read` to view). Generating also needs the
   member's Yuvomi Tasks permission, since the tasks are created in their name.

**Upgrading.** The two halves are versioned together: change the image tag to the new
version and `docker compose up -d` first, then reinstall the module page from Settings
(Yuvomi never updates a module on its own) and approve it again. A newer page against an
older sidecar is refused on the fields it does not know; the other way round is harmless.

Releases: tag `vX.Y.Z` matching `version` in `module.json` (CI refuses a mismatch), and CI
runs the tests, pushes the sidecar image and creates the GitHub Release that Yuvomi's
installer resolves a bare repository address to. After the very first release, open the
package on GitHub and set its visibility to public once: packages start private, and the
pull would fail for everyone else. The repository carries the GitHub topic `yuvomi-module`.

## Not in scope (v1)

Automatic generation on a schedule, a dashboard widget, notifications, assignee rotation,
per-activity exceptions, editing generated tasks from the module. See the design for why.
