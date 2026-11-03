# Headless browser checks

Drives a local Google Chrome (macOS path in `cdp.mjs`) over the DevTools protocol against
the dev instance, signed in with a curl cookie jar. Not part of the test suite; used to
prove the page end to end.

```sh
# a cookie jar with an admin session:
curl -s -c /tmp/jar -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"cleaningplan-dev"}'

node scripts/browser/plan-flow.mjs      /tmp/jar /tmp               # rooms + activities, edit, reload
node scripts/browser/read-only.mjs      /tmp/kim-jar /tmp           # a member with ext:cleaningplan = read
node scripts/browser/iteration-flow.mjs /tmp/jar /tmp               # generate, tick off, regenerate, delete
node scripts/browser/resilience.mjs     /tmp/jar /tmp "$(pwd)"      # stops/starts containers, escaping check
```

Each script prints what it saw, writes screenshots into the second argument, and lists
console errors at the end. `iteration-flow.mjs` names Kim (user id 3) as the doer of one
task; `resilience.mjs` runs `docker compose stop/start` on the sidecar.
