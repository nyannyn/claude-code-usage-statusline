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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

// Account email is NOT in the status line JSON; read it from ~/.claude.json.
function account(full) {
  try {
    const j = JSON.parse(
      readFileSync(join(homedir(), ".claude.json"), "utf8").replace(/^﻿/, "")
    );
    const email = j?.oauthAccount?.emailAddress;
    if (!email) return "";
    return full ? email : email.split("@")[0];
  } catch {
    return "";
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
