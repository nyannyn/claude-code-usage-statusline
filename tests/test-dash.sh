#!/bin/bash
# Offline behavior tests for dashboard.mjs — token-reminder tri-state
# (grey while any token works / red + dimmed card when none do) and the
# cached-expired-verdict revalidation.
#
#   bash tests/test-dash.sh
#
# Uses ports 3782-3784 (3777 is left alone for a real instance). Everything is
# driven by fake snapshot/config dirs in a temp folder, so no real profile is
# read and expired tokens never reach the network. The one exception is the
# final "revive" scenario, which flips the fake token to valid and therefore
# sends a single request (a dummy Bearer, answered with HTTP 401) to the usage
# endpoint — that failed request IS the proof that the cached expired verdict
# was re-swept. Assertions use node (not jq) so there are no extra dependencies.
set -u
DASH="$(cd "$(dirname "$0")/.." && pwd)/dashboard.mjs"
WORK=$(mktemp -d)
PIDS=()
cleanup(){ kill "${PIDS[@]}" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
check(){ # check <desc> <js-expr over `a` (the account)> <json> <email>
  if echo "$3" | node -e '
    const j=JSON.parse(require("fs").readFileSync(0,"utf8"));
    const a=j.accounts.find(x=>x.email===process.argv[2]);
    process.exit(a && eval(process.argv[1]) ? 0 : 1);
  ' "$2" "$4" 2>/dev/null; then ok "$1"; else bad "$1  [expr: $2]"; fi
}

# ---------- S1: demo mode ----------
node "$DASH" demo --port 3782 --no-open >/dev/null 2>&1 &
PIDS+=($!); sleep 1
J=$(curl -s http://localhost:3782/api/usage)
check "demo work: tokenOk true"      'a.tokenOk===true' "$J" work@example.com
check "demo work: not dead"          'a.dead===false' "$J" work@example.com
check "demo work: other error kept"  'a.others[0].error!=null' "$J" work@example.com
check "demo play: tokenOk false"     'a.tokenOk===false' "$J" play@example.com
check "demo play: dead true"         'a.dead===true' "$J" play@example.com
HTML=$(curl -s http://localhost:3782/)
echo "$HTML" | grep -q '.rrow.dead' && ok "page has .rrow.dead css" || bad "page has .rrow.dead css"
echo "$HTML" | grep -q '.aerr.soft' && ok "page has .aerr.soft css" || bad "page has .aerr.soft css"
echo "$HTML" | grep -q "errCls" && ok "page uses errCls" || bad "page uses errCls"

# ---------- fake profile: expired token ----------
CFG="$WORK/cfg/.claude-x"; USAGE="$WORK/usage"
mkdir -p "$CFG" "$USAGE"
echo '{"oauthAccount":{"emailAddress":"a@x.com"}}' > "$CFG/.claude.json"
echo '{"claudeAiOauth":{"accessToken":"dummy","expiresAt":1000}}' > "$CFG/.credentials.json"
# host label must match what hostOfDir() derives on this machine, or the live
# error entry won't collide with the snapshot in collect()'s key|host map
HOSTLBL="${WSL_DISTRO_NAME:+$WSL_DISTRO_NAME (wsl)}"
[ -z "$HOSTLBL" ] && HOSTLBL="$(hostname) ($(node -e 'console.log(require("os").platform())'))"

# ---------- S2a: expired token + FRESH snapshot (same key+host) => grey, not dead ----------
NOW=$(date +%s%3N)
cat > "$USAGE/.claude-x.json" <<EOF
{"key":".claude-x","email":"a@x.com","host":"$HOSTLBL","rate_limits":{"five_hour":{"used_percentage":10,"resets_at":$(( $(date +%s)+7200 ))}},"updatedAt":$NOW}
EOF
CLAUDE_USAGE_DIRS="$USAGE" CLAUDE_CONFIG_DIRS="$CFG" node "$DASH" --live --port 3783 --no-open >/dev/null 2>&1 &
PIDS+=($!); sleep 2
J=$(curl -s http://localhost:3783/api/usage)
check "fresh snap + expired token: tokenOk true"   'a.tokenOk===true' "$J" a@x.com
check "fresh snap + expired token: not dead"       'a.dead===false' "$J" a@x.com
check "fresh snap + expired token: liveError kept" 'a.liveError!=null' "$J" a@x.com

# ---------- S2b: expired token + STALE snapshot => dead ----------
OLD=$(( NOW - 26*3600*1000 ))
sed -i "s/\"updatedAt\":$NOW/\"updatedAt\":$OLD/" "$USAGE/.claude-x.json"
CLAUDE_USAGE_DIRS="$USAGE" CLAUDE_CONFIG_DIRS="$CFG" node "$DASH" --live --port 3784 --no-open >/dev/null 2>&1 &
PIDS+=($!); sleep 2
J=$(curl -s http://localhost:3784/api/usage)
check "stale snap + expired token: tokenOk false" 'a.tokenOk===false' "$J" a@x.com
check "stale snap + expired token: dead true"     'a.dead===true' "$J" a@x.com
check "stale snap + expired token: liveError set" 'a.liveError!=null' "$J" a@x.com

# ---------- S3: token revived => cached expired verdict re-swept ----------
# (same server as S2b: its live cache holds the expired verdict)
echo "{\"claudeAiOauth\":{\"accessToken\":\"dummy\",\"expiresAt\":$(( ($(date +%s)+7200) *1000 ))}}" > "$CFG/.credentials.json"
J=$(curl -s http://localhost:3784/api/usage)
check "revive: expired verdict dropped on next poll" '!String(a.liveError||"").startsWith("token expired")' "$J" a@x.com

echo "----"; echo "PASS=$PASS FAIL=$FAIL"; [ $FAIL -eq 0 ]
