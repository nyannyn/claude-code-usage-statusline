#!/usr/bin/env node
// Consistency check: do the dashboard's cards match real usage?
//
// "Real usage" here is the freshest statusline snapshot per account — written
// from inside a live Claude Code session, so it is ground truth the dashboard
// merge cannot invent. For every account card in /api/usage:
//   - if a fresh snapshot (< --fresh-min, default 15) exists for that email,
//     the card must NOT be dead/stale, and its 5h / weekly percentages must
//     be within --tolerance (default 5 points) of the snapshot — unless the
//     two sit in different reset windows (resets_at differs), which is skipped;
//   - every fresh snapshot's email must have a card at all (a missing card =
//     the misattribution bug this check was born from, repo 1294965).
// Exit 0 = consistent, 1 = divergence found, 2 = usage/API unreadable.
//
//   node tests/verify-live.mjs --port 3782
//   node tests/verify-live.mjs --url http://localhost:3777
//   powershell.exe -NoProfile -Command \
//     "(Invoke-WebRequest -UseBasicParsing http://localhost:3777/api/usage).Content" \
//     | node tests/verify-live.mjs --stdin --snap-dirs "$HOME/.claude-usage;/mnt/c/Users/<you>/.claude-usage"
//
// --snap-dirs defaults to ~/.claude-usage plus CLAUDE_USAGE_DIRS (;-separated).
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const TOL = Number(opt("--tolerance", 5));
const FRESH_MS = Number(opt("--fresh-min", 15)) * 60_000;
const URL_ = opt("--url", null) || `http://localhost:${opt("--port", 3777)}`;

function snapDirs() {
  const dirs = (opt("--snap-dirs", "") || "").split(";").map((s) => s.trim()).filter(Boolean);
  if (dirs.length) return dirs;
  const d = [join(homedir(), ".claude-usage")];
  const extra = process.env.CLAUDE_USAGE_DIRS;
  if (extra) d.push(...extra.split(";").map((s) => s.trim()).filter(Boolean));
  return [...new Set(d)];
}

// freshest snapshot per email
function readSnapshots() {
  const byEmail = new Map();
  for (const dir of snapDirs()) {
    let files;
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      try {
        const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (!s?.email || !s?.rate_limits) continue;
        const prev = byEmail.get(s.email);
        if (!prev || (s.updatedAt || 0) > (prev.updatedAt || 0)) byEmail.set(s.email, s);
      } catch {}
    }
  }
  return byEmail;
}

async function readApi() {
  if (args.includes("--stdin")) return JSON.parse(readFileSync(0, "utf8"));
  const res = await fetch(`${URL_}/api/usage`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`GET /api/usage → HTTP ${res.status}`);
  return res.json();
}

const pct = (rl, k) => rl?.[k]?.used_percentage;
const rst = (rl, k) => rl?.[k]?.resets_at;
const failures = [];
const notes = [];

let api;
try { api = await readApi(); } catch (e) { console.error(`unreadable: ${e.message}`); process.exit(2); }
const cards = new Map((api.accounts || []).map((a) => [a.email || a.key, a]));
const snaps = readSnapshots();
const now = Date.now();

for (const [email, snap] of snaps) {
  const age = now - (snap.updatedAt || 0);
  if (age >= FRESH_MS) continue; // stale snapshot proves nothing
  const card = cards.get(email);
  if (!card) { failures.push(`${email}: fresh snapshot (${Math.round(age / 60000)}m) but NO card — misattributed or dropped`); continue; }
  if (card.dead) { failures.push(`${email}: card is dead/red while a ${Math.round(age / 60000)}m-old snapshot exists`); continue; }
  for (const k of ["five_hour", "seven_day"]) {
    const a = pct(card.rate_limits, k), b = pct(snap.rate_limits, k);
    if (a == null || b == null) continue;
    if (rst(card.rate_limits, k) !== rst(snap.rate_limits, k)) { notes.push(`${email} ${k}: different reset window, compare skipped`); continue; }
    // Both readings carry internal caches (statusline and dashboard each hold
    // usage results ~60s), so timestamps can't order the DATA, and an active
    // session can burn several 5h-points inside that skew. Give five_hour a
    // burn allowance of 3 points per minute of apparent skew (+2min for the
    // hidden caches); seven_day moves too slowly to need it. Misattribution —
    // the bug this check exists for — shows up as tens of points, dead cards,
    // or missing cards, all still far outside the allowance.
    const skewMin = Math.abs((card.updatedAt || 0) - (snap.updatedAt || 0)) / 60000;
    const allowed = k === "five_hour" ? TOL + 3 * (skewMin + 2) : TOL;
    if (Math.abs(a - b) > allowed)
      failures.push(`${email} ${k}: card ${a}% vs snapshot ${b}% (>±${Math.round(allowed)})`);
    else notes.push(`${email} ${k}: card ${a}% ~ snapshot ${b}%`);
  }
}

for (const n of notes) console.log("  ok  " + n);
for (const f of failures) console.log("  FAIL " + f);
const checked = [...snaps.values()].filter((s) => now - (s.updatedAt || 0) < FRESH_MS).length;
console.log(`----\ncards=${cards.size} fresh-snapshots=${checked} failures=${failures.length}`);
if (!checked) console.log("(no fresh snapshot to compare — open a Claude Code window first)");
process.exit(failures.length ? 1 : 0);
