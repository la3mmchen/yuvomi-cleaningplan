# Pre-commit review, 2026-11-03 (workflow run stopped early; 44 findings, first 9 with refuter votes)

**Status 2026-11-03:** everything under "Fix before committing" and "Worth doing, small" is fixed test-first (suite 98/98 on Node 24 and 26; browser flows clean). The "Deferred" items remain open by choice.

Status legend: verified = refuters agreed; confirmed = checked by hand; unverified = single finder, read and found plausible.

## Fix before committing
1. Guest accounts (access_scope != family, e.g. split-expense guests, displays) get write on the sidecar — auth.mjs accessFrom(). VERIFIED critical. Fix: deny non-family scope.
2. CI/README test command fails on Node 24: `node --test` rejects directory args (ERR_UNSUPPORTED_DIR_IMPORT). CONFIRMED in the yuvomi image. Fix: globs "service/test/*.test.mjs" "test/module/*.test.mjs" in ci.yml and README.
3. Missing ext:cleaningplan key in permissions.modules maps to write (module disabled/unapproved lifts read/none). VERIFIED important. Fix: fail closed.
4. /auth/me forward carries no X-Forwarded-For → one 300/min budget for the whole household; 401s not cached. VERIFIED important.
5. Editing any activity field re-sends first_due = next_due → anchor_day reset → monthly drift returns (db.mjs updateActivity + plan-view.js prefill). VERIFIED important. Fix: treat first_due as change only when it differs from stored next_due; browser sends it only when changed.
6. No GitHub Release is created by CI; Yuvomi's installer then installs the default branch. Unverified important. Fix: release job (`gh release create "$GITHUB_REF_NAME" --verify-tag --generate-notes`, permissions contents: write).
7. Bind-mounted /data is root-owned → sidecar crashes (image runs as node). Unverified important. Fix: entrypoint chown + setpriv drop like Yuvomi, or document.
8. default_assignee_id of a removed member → POST /tasks 400 per task on every generation. Unverified important. Fix: omit assigned_to when id not in current members.
9. fetchCompletions reads one page (200) → "done by" degrades to "done" for older iterations. Unverified important. Fix: follow next_cursor until the iteration's done task ids resolve or page older than start_date.
10. Stale-state paths: reloadPlan failure after a successful write hides error + stale list (index.js mutatePlan); failure after POST /iterations leaves list stale → next Generate makes empty duplicate (withIterations error path should best-effort reload); "tick at least one room" redraws form, re-ticking rooms and erasing tags (validate without redraw).
11. README: TRUST_PROXY advice wrong for installs written with loopback; snippet pins :latest without upgrade guidance (pin version, add Upgrading); GHCR package starts private (note it).

## Worth doing, small
- vTags/parseTags: refuse tags in own namespace (cleaningplan, cleaningplan:<id>). VERIFIED minor.
- TAGS_MAX 32 → 30 (two automatic tags; Yuvomi truncates silently).
- ci.yml: drop `type=raw,value=latest` (metadata-action adds latest for stable semver only); add top-level `permissions: contents: read`; comment says :<tag> but image tag is without v; add a version==tag check against module.json.
- `.select` class does not exist in Yuvomi → use class="input" on the three selects. CONFIRMED.
- check-ring span needs carrier sizing (display:grid; width/height var(--space-5)) and class check-ring--static (exists). CONFIRMED class exists.
- Dockerfile HEALTHCHECK hardcodes 3100; read PORT.
- docker-compose.yml comment has personal absolute path; "Add custom module" comment misleading (hand-copied folder → 409 not_web_installed); gitignore modules/*/.yuvomi-install.json, modules/.backup-*, modules/.install-*.
- Read-only hint sits outside a page section (not measured).
- 'done by ,' when completion has no person (CalDAV) → fall back to plain "done".
- client.js: on 403 csrf_invalid, GET /api/v1/auth/me (body has csrfToken) and retry once (iOS PWA stale document.cookie; mirrors api.js).
- Generate submit while busy is silently dropped (disable submit when busy); openIteration failure on page load swallowed (set iterationsError, clear query); drawPlan steals focus after generate/delete (focus only from onEdit).
- Missing tests: migrate() adding iterations.tags/room_ids on an old DB; generate-form request building (extract buildGenerateRequest to format.js); room/activity deletion leaves todos (activity_id NULL) and deleteIteration restore with deleted activities; auth test for absent permission key (becomes "→ none").

## Deferred (design questions / hygiene)
- deleteIteration restores next_due unconditionally, discarding a manual first-due edit made after generating.
- Newest-only delete rule counts iterations of unrelated rooms (Kitchen-only cannot be deleted after a Bath-only one).
- routes.test.mjs shares one DB across tests (order-dependent).

Raw finder output (all 44 with scenarios/fixes): docs/reviews/2026-11-03-pre-commit-review-raw.txt
