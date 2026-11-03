#!/bin/sh
# Seeds a fresh dev instance: first admin, then two ordinary household members so
# assignees and permissions can be tested. Safe to re-run: existing accounts are skipped.
#
#   admin / cleaningplan-dev   (admin)
#   sam   / cleaningplan-dev   (member)
#   kim   / cleaningplan-dev   (member)
#
# There is no way to switch Yuvomi's login screen off; sessions last 90 days, so one
# login per browser profile is enough.
set -eu
BASE="${YUVOMI_URL:-http://localhost:3000}"
PASS="cleaningplan-dev"
JAR=$(mktemp); OUT=$(mktemp)
trap 'rm -f "$JAR" "$OUT"' EXIT

post() { # path json [extra curl args...]
  path=$1; body=$2; shift 2
  curl -s -b "$JAR" -c "$JAR" -o "$OUT" -w '%{http_code}' -X POST "$BASE$path" \
    -H 'Content-Type: application/json' "$@" -d "$body"
}

# 1. First-run admin (route answers 404 once any user exists).
code=$(post /api/v1/auth/setup "{\"username\":\"admin\",\"display_name\":\"Admin\",\"password\":\"$PASS\",\"language\":\"en\",\"timezone\":\"Europe/Berlin\"}")
case "$code" in
  200|201) echo "admin: created" ;;
  404|403) echo "admin: already exists" ;;
  *) echo "admin: unexpected HTTP $code"; cat "$OUT"; echo; exit 1 ;;
esac

# 2. Log in as admin; the jar now holds the session and the readable csrf-token cookie.
code=$(post /api/v1/auth/login "{\"username\":\"admin\",\"password\":\"$PASS\"}")
[ "$code" = "200" ] || { echo "login failed: HTTP $code"; cat "$OUT"; echo; exit 1; }
CSRF=$(awk '$6=="csrf-token"{print $7}' "$JAR")

# 3. Ordinary members via the admin-only route.
for u in sam:Sam kim:Kim; do
  name=${u%%:*}; display=${u#*:}
  code=$(post /api/v1/auth/users "{\"username\":\"$name\",\"display_name\":\"$display\",\"password\":\"$PASS\"}" -H "X-CSRF-Token: $CSRF")
  case "$code" in
    200|201) echo "$name: created" ;;
    409) echo "$name: already exists" ;;
    400) if grep -q -i "taken\|exists" "$OUT"; then echo "$name: already exists"; else echo "$name: HTTP 400"; cat "$OUT"; echo; exit 1; fi ;;
    *) echo "$name: unexpected HTTP $code"; cat "$OUT"; echo; exit 1 ;;
  esac
done

echo "login at $BASE - every account uses password '$PASS'"
