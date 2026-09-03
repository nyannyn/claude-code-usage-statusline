#!/usr/bin/env node
// Claude Code statusLine: model + reasoning effort + subscription 5h/weekly usage + account.
// rate_limits only appears on Pro/Max plans after the first request in a session; may be absent.
//
// Arguments (any order, space-separated):
//   zh          Traditional Chinese output (default: English)
//   demo        Render a sample line using fake data instead of reading stdin (for previews)
//   <segments>  Comma-separated list picking which parts to show, in order. Available:
//                 model    model display name (with ·effort appended when "effort" is on)
//                 effort   reasoning effort level (low/medium/high/xhigh/max); attaches to model
//                 5h       5-hour quota remaining + reset countdown
//                 week     weekly quota remaining + reset countdown
//                 account  account name (the part before @ in your Claude login email)
//                 email    full account email
//                 ctx      how full the context window is, in percent
//                 tokens   tokens this session has burned: output, and new input
//                          (input + cache creation, excluding cache reads).
//                          Counts subagent turns; needs the session transcript.
//                 cost     this session's cost in USD, as Claude Code reports it
//               Default when omitted: model,effort,5h,week
//               Use "all" for model,effort,5h,week,account,ctx,tokens,cost
//
// Env vars:
//   CLAUDE_SL_LANG=zh           same as the "zh" argument
//   CLAUDE_SL_SEGMENTS=...      same as the <segments> argument
//   CLAUDE_SL_ACCOUNT=you@x.com per-window account label for the account/email
//                               segment (set before launching claude). Needed when
//                               several windows are logged into different accounts,
//                               because ~/.claude.json only stores the last login.
//   CLAUDE_SL_SNAPSHOT=0        disable writing usage snapshots for the dashboard
//   CLAUDE_SL_USAGE_DIR=<dir>   where snapshots go (default ~/.claude-usage); the
//                               "tokens" segment keeps its per-session tally in
//                               <dir>/sessions/ so it only reads new transcript bytes
const args = process.argv.slice(2);
const ZH = args.includes("zh") || process.env.CLAUDE_SL_LANG === "zh";
const DEMO = args.includes("demo");
const segArg =
  args.find((a) => a !== "zh" && a !== "demo") || process.env.CLAUDE_SL_SEGMENTS || "";
const ALL = "model,effort,5h,week,account,ctx,tokens,cost";
const segs = (segArg === "all" ? ALL : segArg || "model,effort,5h,week")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const has = (s) => segs.includes(s);

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join, basename, dirname } from "node:path";

const T = ZH
  ? {
      wait: "額度資訊待首次請求後顯示",
      week: "週",
      none: (label) => `${label} —`,
      seg: (label, r, c) => `${label} 剩 ${r}%${c ? ` (重置 ${c})` : ""}`,
      soon: "即將重置",
      tokensLabel: "本次",
      tokens: (o, i) => `本次 out ${o} · in ${i}`,
    }
  : {
      wait: "usage shown after first request",
      week: "week",
      none: (label) => `${label} —`,
      seg: (label, r, c) => `${label} ${r}% left${c ? ` (resets ${c})` : ""}`,
      soon: "resetting",
      tokensLabel: "session",
      tokens: (o, i) => `session out ${o} · in ${i}`,
    };

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function countdown(resetsAt) {
  if (!resetsAt) return "";
  const secs = resetsAt - Math.floor(Date.now() / 1000);
  if (secs <= 0) return T.soon;
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

function seg(label, win) {
  if (!win || win.used_percentage == null) return T.none(label);
  const remain = Math.max(0, 100 - win.used_percentage).toFixed(0);
  return T.seg(label, remain, countdown(win.resets_at));
}

// Account email is NOT in the status line JSON, and ~/.claude.json holds only ONE
// account (the last login) — so with multiple windows on different accounts it
// can't tell them apart. Resolution order:
//   1. CLAUDE_SL_ACCOUNT env — explicit per-window label (set it before launching
//      claude in that window); always correct, always wins.
//   2. .claude.json under CLAUDE_CONFIG_DIR (when each account uses its own config
//      dir), else ~/.claude.json as a best-effort fallback.
function configEmail() {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || homedir();
    const j = JSON.parse(
      readFileSync(join(dir, ".claude.json"), "utf8").replace(/^﻿/, "")
    );
    return j?.oauthAccount?.emailAddress || "";
  } catch {
    return "";
  }
}

function account(full) {
  const v = process.env.CLAUDE_SL_ACCOUNT || configEmail();
  if (!v) return "";
  return full ? v : v.split("@")[0];
}

// Each profile (config dir) drops its latest rate_limits into ~/.claude-usage/
// so dashboard.mjs can show every account side by side. The key must be stable
// per profile and match what dashboard --live derives from the dir name, so a
// dedicated config dir always wins; CLAUDE_SL_ACCOUNT keys the shared-dir case
// (several windows on one dir) and otherwise only labels the card.
function snapshotKey() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (dir) return basename(dir.replace(/[\\/]+$/, ""));
  return process.env.CLAUDE_SL_ACCOUNT || ".claude";
}

function usageDir() {
  return process.env.CLAUDE_SL_USAGE_DIR || join(homedir(), ".claude-usage");
}

// atomic-ish: readers never see a half-written file
function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

function writeSnapshot(input) {
  if (DEMO || process.env.CLAUDE_SL_SNAPSHOT === "0") return;
  if (!input?.rate_limits) return; // never clobber good data with an empty session
  try {
    const dir = usageDir();
    const key = snapshotKey();
    const file = join(dir, key.replace(/[^\w.@-]+/g, "_") + ".json");
    const override = process.env.CLAUDE_SL_ACCOUNT;
    const snap = {
      key,
      // display name for the dashboard card; the key stays dir-based for merging
      label: override || undefined,
      // the account's real identity — a non-email label must not shadow it,
      // or the dashboard can't group this profile with others per account
      email: (override?.includes("@") ? override : configEmail()) || undefined,
      configDir: process.env.CLAUDE_CONFIG_DIR || undefined,
      // must match dashboard.mjs hostOfDir(): a WSL profile is "<distro> (wsl)"
      // whether the dashboard reads it from inside the distro or from Windows
      host: process.env.WSL_DISTRO_NAME
        ? `${process.env.WSL_DISTRO_NAME} (wsl)`
        : `${hostname()} (${platform()})`,
      model: input?.model?.display_name || undefined,
      effort: input?.effort?.level || undefined,
      rate_limits: input.rate_limits,
      updatedAt: Date.now(),
    };
    writeJson(file, snap);
  } catch {
    // snapshots are best-effort; the status line itself must never break
  }
}

function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}

// Tokens burned by this session. Claude Code's stdin only carries context-window
// snapshots, so the running total has to come from the transcript — which grows to
// megabytes, hence a per-session cache that remembers how far each file was read.
//
// Two transcript quirks drive the counting rules:
//   - the same message.id is written twice in a row (streaming, then final); the
//     duplicate carries identical usage, so skipping "same id as the line before"
//     halves an otherwise ~2x overcount. Duplicates are always adjacent.
//   - subagent turns live in a sibling <transcript>/subagents/agent-*.jsonl, not in
//     the main file, and the user wants them counted.
// "in" deliberately excludes cache_read_input_tokens: re-reading the same cached
// prompt every turn is not new work, and including it makes the number meaningless.
function sessionTokens(input) {
  const path = input?.transcript_path;
  const sid = input?.session_id;
  if (!path || !sid) return null;
  try {
    const targets = [path];
    try {
      const dir = path.replace(/\.jsonl$/, "") + "/subagents";
      for (const f of readdirSync(dir))
        if (f.startsWith("agent-") && f.endsWith(".jsonl")) targets.push(join(dir, f));
    } catch {
      // no subagents ran in this session
    }

    const cacheFile = join(usageDir(), "sessions", sid.replace(/[^\w.-]+/g, "_") + ".json");
    let cache;
    try {
      cache = JSON.parse(readFileSync(cacheFile, "utf8"));
    } catch {
      // no cache yet, or it was corrupted — recount from scratch
    }
    if (cache?.v !== 1 || !cache.files) cache = { v: 1, files: {} };

    let out = 0;
    let inp = 0;
    let dirty = false;
    const kept = {};
    for (const file of targets) {
      let e = cache.files[file];
      if (!e || typeof e.offset !== "number") e = { offset: 0, lastId: null, out: 0, inp: 0 };
      kept[file] = e;
      try {
        const size = statSync(file).size;
        // shrunk = rotated or truncated; the per-file tally makes the reset a simple
        // rescan of that one file instead of subtracting from a global total
        if (size < e.offset) {
          e.offset = 0;
          e.lastId = null;
          e.out = 0;
          e.inp = 0;
          dirty = true;
        }
        if (size > e.offset) {
          const fd = openSync(file, "r");
          try {
            const buf = Buffer.allocUnsafe(size - e.offset);
            const n = readSync(fd, buf, 0, buf.length, e.offset);
            const text = buf.toString("utf8", 0, n);
            const end = text.lastIndexOf("\n"); // a trailing half-line waits for next time
            if (end >= 0) {
              for (const line of text.slice(0, end).split("\n")) {
                if (!line) continue;
                let j;
                try {
                  j = JSON.parse(line);
                } catch {
                  continue;
                }
                const u = j?.message?.usage;
                if (!u) continue;
                const id = j.message.id ?? null;
                if (id != null && id === e.lastId) continue;
                e.lastId = id;
                e.out += u.output_tokens || 0;
                e.inp += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
              }
              e.offset += Buffer.byteLength(text.slice(0, end + 1));
              dirty = true;
            }
          } finally {
            closeSync(fd);
          }
        }
      } catch (e) {
        // a subagent file listed a moment ago can be gone by now — keep what the
        // others counted; but if the session's own transcript is unreadable the
        // total is unknown, not zero
        if (file === path) throw e;
      }
      out += e.out;
      inp += e.inp;
    }
    // only the current targets count and get remembered — a transcript this session
    // no longer reads must not keep contributing to the total
    if (Object.keys(cache.files).length !== targets.length) dirty = true;
    cache.files = kept;
    // last writer wins: two renders of one session racing can leave the older,
    // smaller tally behind, and the next render reads it back and catches up
    if (dirty) writeJson(cacheFile, cache);
    return { out, inp };
  } catch {
    return null; // the status line must never break over a bookkeeping detail
  }
}

const DEMO_DATA = {
  model: { display_name: "Opus 4.8" },
  effort: { level: "high" },
  rate_limits: {
    five_hour: {
      used_percentage: 13,
      resets_at: Math.floor(Date.now() / 1000) + 3 * 3600 + 12 * 60,
    },
    seven_day: {
      used_percentage: 38,
      resets_at: Math.floor(Date.now() / 1000) + 4 * 86400 + 6 * 3600,
    },
  },
  context_window: { used_percentage: 12 },
  cost: { total_cost_usd: 3.42 },
};
const DEMO_TOKENS = { out: 42000, inp: 118000 };

try {
  let input;
  if (DEMO) {
    input = DEMO_DATA;
  } else {
    const raw = ((await readStdin()) || "{}").replace(/^﻿/, "").trim() || "{}";
    input = JSON.parse(raw);
  }

  writeSnapshot(input);

  const model = input?.model?.display_name || "Claude";
  const effort = input?.effort?.level;
  const parts = [];

  if (has("model")) {
    parts.push(has("effort") && effort ? `${model}·${effort}` : model);
  } else if (has("effort") && effort) {
    parts.push(effort);
  }

  const rl = input.rate_limits;
  if (has("5h") || has("week")) {
    if (!rl) {
      parts.push(T.wait);
    } else {
      if (has("5h")) parts.push(seg("5h", rl.five_hour));
      if (has("week")) parts.push(seg(T.week, rl.seven_day));
    }
  }

  if (has("account") || has("email")) {
    let a = account(has("email"));
    if (!a && DEMO) a = has("email") ? "you@example.com" : "you";
    if (a) parts.push(a);
  }

  if (has("ctx")) {
    const pct = input?.context_window?.used_percentage;
    parts.push(pct == null ? T.none("context") : `context ${pct}%`);
  }

  if (has("tokens")) {
    const t = DEMO ? DEMO_TOKENS : sessionTokens(input);
    parts.push(t ? T.tokens(fmtNum(t.out), fmtNum(t.inp)) : T.none(T.tokensLabel));
  }

  if (has("cost")) {
    const usd = input?.cost?.total_cost_usd;
    parts.push(typeof usd === "number" ? `$${usd.toFixed(2)}` : T.none("$"));
  }

  process.stdout.write(parts.join(" | ") || model);
} catch (e) {
  process.stdout.write(`statusline err: ${String(e.message).slice(0, 40)}`);
}
