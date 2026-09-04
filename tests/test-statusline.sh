#!/usr/bin/env bash
# Offline tests for the "tokens" / "ctx" / "cost" segments of statusline-limits.mjs.
# No jq (not installed here) — assertions read JSON with node.
set -u
export NO_COLOR=1   # assertions match plain text; A10 re-enables color on purpose

SL="$(cd "$(dirname "$0")/.." && pwd)/statusline-limits.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want $3, got $2)"; fi; }

# --- fixture -----------------------------------------------------------------
# Mirrors the real transcript shape: every assistant turn is written twice in a
# row with the same message.id and identical usage (streaming, then final).
node - "$TMP" <<'NODE'
const { writeFileSync, mkdirSync } = require("node:fs");
const dir = process.argv[2];
const turn = (id, o, i, cc, cr) => JSON.stringify({
  type: "assistant",
  message: { id, usage: { output_tokens: o, input_tokens: i, cache_creation_input_tokens: cc, cache_read_input_tokens: cr } },
});
const lines = [];
for (let n = 1; n <= 20; n++) {
  const l = turn("msg_" + n, n * 10, n, n * 100, n * 5000);
  lines.push(l, l); // the duplicate is always adjacent
}
lines.push(JSON.stringify({ type: "user", message: { content: "no usage here" } }));
writeFileSync(dir + "/main.jsonl", lines.join("\n") + "\n");
mkdirSync(dir + "/main/subagents", { recursive: true });
const sub = [];
for (let n = 1; n <= 5; n++) {
  const l = turn("agent_" + n, 7, 3, 11, 90000);
  sub.push(l, l);
}
writeFileSync(dir + "/main/subagents/agent-aaa.jsonl", sub.join("\n") + "\n");
// must be ignored: sidecar metadata sits in the same directory
writeFileSync(dir + "/main/subagents/agent-aaa.meta.json", "{}");
NODE

# --- oracle: independent full-file sum, deduped with a Set of every seen id ---
# Deliberately NOT the product's "same id as the previous line" shortcut, so
# agreement also proves duplicates really are adjacent.
cat > "$TMP/oracle.mjs" <<'NODE'
import { readFileSync } from "node:fs";
const mode = process.argv[2]; // "set" | "nodedup"
let out = 0, inp = 0;
const seen = new Set();
for (const file of process.argv.slice(3)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const u = j?.message?.usage;
    if (!u) continue;
    if (mode === "set") { if (seen.has(j.message.id)) continue; seen.add(j.message.id); }
    out += u.output_tokens || 0;
    inp += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
}
console.log(JSON.stringify({ out, inp }));
NODE
oracle() { node "$TMP/oracle.mjs" "$@"; }

# --- driver ------------------------------------------------------------------
# Prints the raw out/in the tokens segment computed, as JSON.
cat > "$TMP/run.mjs" <<'NODE'
import { spawnSync } from "node:child_process";
const [sl, transcript, sid, cacheDir] = process.argv.slice(2);
const stdin = JSON.stringify({
  session_id: sid,
  transcript_path: transcript,
  model: { display_name: "Test" },
  context_window: { used_percentage: 12 },
  cost: { total_cost_usd: 1.5 },
});
const r = spawnSync(process.execPath, [sl, "tokens"], {
  input: stdin,
  env: { ...process.env, CLAUDE_SL_USAGE_DIR: cacheDir, CLAUDE_SL_SNAPSHOT: "0" },
  encoding: "utf8",
});
process.stdout.write(r.stdout);
if (r.status !== 0) { console.error("exit " + r.status); process.exit(1); }
NODE
# renders the segment, e.g. "session out 2k · in 21k"
run() { node "$TMP/run.mjs" "$SL" "$1" "$2" "$3"; }
# same, but as exact numbers: re-read the cache the run just wrote
sum() {
  run "$1" "$2" "$3" > /dev/null
  node -e '
    const { readFileSync, readdirSync } = require("node:fs");
    const dir = process.argv[1] + "/sessions";
    const f = readdirSync(dir)[0];
    const c = JSON.parse(readFileSync(dir + "/" + f, "utf8"));
    let out = 0, inp = 0;
    for (const k of Object.keys(c.files)) { out += c.files[k].out; inp += c.files[k].inp; }
    console.log(JSON.stringify({ out, inp }));
  ' "$3"
}

echo "A1  totals match an independent Set-deduped oracle"
TRUTH=$(oracle set "$TMP/main.jsonl" "$TMP/main/subagents/agent-aaa.jsonl")
GOT=$(sum "$TMP/main.jsonl" s1 "$TMP/c1")
check "A1 out/in" "$GOT" "$TRUTH"
NODEDUP=$(oracle nodedup "$TMP/main.jsonl" "$TMP/main/subagents/agent-aaa.jsonl")
if [ "$NODEDUP" = "$TRUTH" ]; then bad "A1 negative control: fixture has no duplicates to dedup"
else ok "A1 negative control (no-dedup sum $NODEDUP differs)"; fi

echo "A2  incremental read of a mid-line truncation equals a single full pass"
SIZE=$(node -e 'console.log(require("node:fs").statSync(process.argv[1]).size)' "$TMP/main.jsonl")
CUT=$((SIZE / 2))
head -c "$CUT" "$TMP/main.jsonl" > "$TMP/part.jsonl"   # byte cut: lands mid-line
tail -c "+$((CUT+1))" "$TMP/main.jsonl" > "$TMP/rest"
node -e 'const f=require("node:fs");const l=f.readFileSync(process.argv[1],"utf8");console.log(l.endsWith("\n")?"line-aligned":"mid-line")' "$TMP/part.jsonl" | grep -q mid-line \
  && ok "A2 setup: truncation really is mid-line" || bad "A2 setup: cut landed on a line boundary"
mkdir -p "$TMP/inc"; cp "$TMP/part.jsonl" "$TMP/inc/main.jsonl"
mkdir -p "$TMP/inc/main/subagents"; cp "$TMP/main/subagents/agent-aaa.jsonl" "$TMP/inc/main/subagents/"
sum "$TMP/inc/main.jsonl" s2 "$TMP/c2" > /dev/null          # first pass: partial file
cat "$TMP/rest" >> "$TMP/inc/main.jsonl"                     # transcript grows
INCR=$(sum "$TMP/inc/main.jsonl" s2 "$TMP/c2")
check "A2 incremental == full" "$INCR" "$TRUTH"
FRESH=$(sum "$TMP/inc/main.jsonl" s2b "$TMP/c2b")
check "A2 negative control (cold cache, same numbers)" "$FRESH" "$TRUTH"

echo "A3  a shrunken transcript resets that file's tally"
head -c "$CUT" "$TMP/inc/main.jsonl" > "$TMP/inc/main.jsonl.tmp" && mv "$TMP/inc/main.jsonl.tmp" "$TMP/inc/main.jsonl"
SHRUNK=$(sum "$TMP/inc/main.jsonl" s2 "$TMP/c2")
node -e '
  const a = JSON.parse(process.argv[1]), b = JSON.parse(process.argv[2]);
  if (a.out < b.out && a.inp < b.inp && a.out >= 0 && a.inp >= 0) console.log("ok"); else console.log("no");
' "$SHRUNK" "$TRUTH" | grep -q ok && ok "A3 dropped, still non-negative ($SHRUNK)" || bad "A3 ($SHRUNK vs $TRUTH)"

echo "A4  subagent turns are counted"
MAIN_ONLY=$(oracle set "$TMP/main.jsonl")
mv "$TMP/main/subagents" "$TMP/subagents.away"
NOSUB=$(sum "$TMP/main.jsonl" s4 "$TMP/c4")
check "A4 without subagents" "$NOSUB" "$MAIN_ONLY"
mv "$TMP/subagents.away" "$TMP/main/subagents"
WITHSUB=$(sum "$TMP/main.jsonl" s4b "$TMP/c4b")
check "A4 with subagents" "$WITHSUB" "$TRUTH"

echo "A5  a broken transcript never breaks the line"
# "—" means unknown (nothing readable); a readable transcript with no assistant
# turns yet is a real zero, and says so.
printf 'not json\n{"message":{}}\n\n' > "$TMP/junk.jsonl"
a5() {
  OUT=$(printf '%s' "{\"session_id\":\"s5\",\"transcript_path\":\"$1\",\"model\":{\"display_name\":\"Test\"},\"context_window\":{\"used_percentage\":7},\"cost\":{\"total_cost_usd\":2}}" \
    | CLAUDE_SL_USAGE_DIR="$TMP/c5" CLAUDE_SL_SNAPSHOT=0 node "$SL" model,ctx,tokens,cost)
  RC=$?
  case "$OUT" in
    *"$2"*) [ $RC -eq 0 ] && ok "A5 $(basename "$1"): $OUT" || bad "A5 exit $RC" ;;
    *) bad "A5 $(basename "$1") wanted '$2', got: $OUT" ;;
  esac
}
a5 "$TMP/does-not-exist.jsonl" "session —"
a5 "$TMP/junk.jsonl" "session out 0 · in 0"

echo "A6  demo renders all three new segments"
a6() {
  OUT=$(node "$SL" $1 all demo)
  case "$OUT" in
    *"$2"*"out 42k · in 118k"*"\$3.42"*) ok "A6 ${1:-en}: $OUT" ;;
    *) bad "A6 ${1:-en} wanted '$2', got: $OUT" ;;
  esac
}
# the percentage that runs the other way says so, in both languages
a6 ""   "context 12% used"
a6 "zh" "context 用 12%"

echo "A7  the default line renders exactly as documented"
# Frozen strings, not a diff against main: once this file is on main, comparing
# with main compares new against new and can never fail again.
check "A7 zh default" "$(node "$SL" zh model,effort,5h,week demo)" \
  "Opus 4.8·high | 5h 剩 87% (3h12m) | 週 剩 62% (4d6h)"
check "A7 en default" "$(node "$SL" model,effort,5h,week demo)" \
  "Opus 4.8·high | 5h 87% left (resets 3h12m) | week 62% left (resets 4d6h)"

echo "A8  the line wraps to two rows only when it doesn't fit COLUMNS"
rows() { COLUMNS="$1" node "$SL" ${3:-} $2 demo | wc -l | tr -d ' '; }   # wc -l counts the \n
row2() { COLUMNS="$1" node "$SL" ${3:-} $2 demo | sed -n '2p'; }
check "A8 wide terminal, one row"        "$(rows 200 all zh)" "0"
check "A8 narrow terminal, two rows"     "$(rows 60 all zh)"  "1"
case "$(row2 60 all zh)" in
  context*) ok "A8 row 2 starts at context: $(row2 60 all zh)" ;;
  *) bad "A8 row 2 got: $(row2 60 all zh)" ;;
esac
# no ctx segment = nothing to move down, however narrow the terminal
check "A8 negative control (no ctx, 20 cols)" "$(rows 20 model,effort,5h,week zh)" "0"
# CJK labels are two cells wide: at 112 cols the zh line is 108 chars but 114
# cells, so a String.length measurement would wrongly keep it on one row
check "A8 CJK width counted in cells"     "$(rows 112 all zh)" "1"
check "A8 ...and stays on one row at 117" "$(rows 117 all zh)" "0"

echo "A9  duplicates in real transcripts really are adjacent (skips if none present)"
REAL=$(ls -S "$HOME"/.claude*/projects/*/*.jsonl 2>/dev/null | head -1)
if [ -z "$REAL" ]; then echo "  SKIP  no local transcripts"
else
  node -e '
    const { readFileSync } = require("node:fs");
    let last = null, gap = 0, dups = 0;
    const seen = new Map();
    let n = 0;
    for (const line of readFileSync(process.argv[1], "utf8").split("\n")) {
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (!j?.message?.usage) continue;
      const id = j.message.id; n++;
      if (seen.has(id)) { dups++; gap = Math.max(gap, n - seen.get(id)); }
      seen.set(id, n);
    }
    console.log(JSON.stringify({ rows: n, dups, maxGap: gap }));
  ' "$REAL" > "$TMP/adj.json"
  node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    console.log(r.dups === 0 || r.maxGap <= 1 ? "ok " + JSON.stringify(r) : "no " + JSON.stringify(r));
  ' "$TMP/adj.json" | grep -q '^ok' && ok "A9 $(cat "$TMP/adj.json") in $(basename "$REAL")" \
    || bad "A9 non-adjacent duplicate found: $(cat "$TMP/adj.json") — switch the product to a Set"
fi

echo "A10 color paints the gauges but never costs a column"
raw() { NO_COLOR="" COLUMNS="$1" node "$SL" zh all demo; }
esc=$(printf '\033')
case "$(raw 999)" in
  *"$esc[32m87%$esc[0m"*) ok "A10 quota at 87% left is green" ;;
  *) bad "A10 no green 87% in colored output" ;;
esac
LOW=$(NO_COLOR="" COLUMNS=999 node -e '
  const { spawnSync } = require("node:child_process");
  // 4% of the 5h quota left: the gauge must go red, the other one stays green
  const d = { model:{display_name:"M"}, rate_limits:{ five_hour:{used_percentage:96}, seven_day:{used_percentage:38} } };
  process.stdout.write(spawnSync(process.execPath, [process.argv[1], "zh", "5h,week"], { input: JSON.stringify(d), encoding: "utf8", env: { ...process.env, CLAUDE_SL_SNAPSHOT: "0" } }).stdout);
' "$SL")
case "$LOW" in
  *"$esc[31m4%$esc[0m"*"$esc[32m62%$esc[0m"*) ok "A10 4% left is red while 62% stays green" ;;
  *) bad "A10 gauge colors: $(printf '%s' "$LOW" | cat -v)" ;;
esac
case "$(NO_COLOR=1 COLUMNS=999 node "$SL" zh all demo)" in
  *"$esc"*) bad "A10 NO_COLOR=1 still emitted escapes" ;;
  *) ok "A10 NO_COLOR=1 is plain text" ;;
esac
# 114 cells of text carrying ~160 characters of escape codes: measuring the raw
# string instead of the painted-out one would wrap this at any width
check "A10 escapes excluded from the width" "$(raw 120 | wc -l | tr -d ' ')" "0"
check "A10 ...and the real text still wraps at 110" "$(raw 110 | wc -l | tr -d ' ')" "1"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
