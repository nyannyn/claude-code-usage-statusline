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
//               Default when omitted: model,effort,5h,week
//               Use "all" for model,effort,5h,week,account
//
// Env vars:
//   CLAUDE_SL_LANG=zh           same as the "zh" argument
//   CLAUDE_SL_SEGMENTS=...      same as the <segments> argument
//   CLAUDE_SL_ACCOUNT=you@x.com per-window account label for the account/email
//                               segment (set before launching claude). Needed when
//                               several windows are logged into different accounts,
//                               because ~/.claude.json only stores the last login.
//   CLAUDE_SL_SNAPSHOT=0        disable writing usage snapshots for the dashboard
//   CLAUDE_SL_USAGE_DIR=<dir>   where snapshots go (default ~/.claude-usage)
const args = process.argv.slice(2);
const ZH = args.includes("zh") || process.env.CLAUDE_SL_LANG === "zh";
const DEMO = args.includes("demo");
const segArg =
  args.find((a) => a !== "zh" && a !== "demo") || process.env.CLAUDE_SL_SEGMENTS || "";
const ALL = "model,effort,5h,week,account";
const segs = (segArg === "all" ? ALL : segArg || "model,effort,5h,week")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const has = (s) => segs.includes(s);

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join, basename } from "node:path";

const T = ZH
  ? {
      wait: "額度資訊待首次請求後顯示",
      week: "週",
      none: (label) => `${label} —`,
      seg: (label, r, c) => `${label} 剩 ${r}%${c ? ` (重置 ${c})` : ""}`,
      soon: "即將重置",
    }
  : {
      wait: "usage shown after first request",
      week: "week",
      none: (label) => `${label} —`,
      seg: (label, r, c) => `${label} ${r}% left${c ? ` (resets ${c})` : ""}`,
      soon: "resetting",
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

function writeSnapshot(input) {
  if (DEMO || process.env.CLAUDE_SL_SNAPSHOT === "0") return;
  if (!input?.rate_limits) return; // never clobber good data with an empty session
  try {
    const dir = process.env.CLAUDE_SL_USAGE_DIR || join(homedir(), ".claude-usage");
    mkdirSync(dir, { recursive: true });
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
      // must match dashboard.mjs hostOfDir(), which labels WSL dirs "<distro> (wsl)"
      host: process.env.WSL_DISTRO_NAME
        ? `${process.env.WSL_DISTRO_NAME} (wsl)`
        : `${hostname()} (${platform()})`,
      model: input?.model?.display_name || undefined,
      effort: input?.effort?.level || undefined,
      rate_limits: input.rate_limits,
      updatedAt: Date.now(),
    };
    const tmp = file + "." + process.pid + ".tmp";
    writeFileSync(tmp, JSON.stringify(snap));
    renameSync(tmp, file); // atomic-ish: readers never see a half-written file
  } catch {
    // snapshots are best-effort; the status line itself must never break
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
};

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

  process.stdout.write(parts.join(" | ") || model);
} catch (e) {
  process.stdout.write(`statusline err: ${String(e.message).slice(0, 40)}`);
}
