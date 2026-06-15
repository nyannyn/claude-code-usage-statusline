#!/usr/bin/env node
// Claude Code statusLine: subscription 5-hour / weekly usage remaining + reset countdown.
// rate_limits only appears on Pro/Max plans after the first request in a session; may be absent.
// Pass "zh" as the first argument for Traditional Chinese; defaults to English.
const ZH = process.argv[2] === "zh";
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

try {
  const raw = ((await readStdin()) || "{}").replace(/^﻿/, "").trim() || "{}";
  const input = JSON.parse(raw);
  const model = input?.model?.display_name || "Claude";
  const rl = input.rate_limits;
  if (!rl) {
    process.stdout.write(`${model} | ${T.wait}`);
  } else {
    process.stdout.write(
      `${model} | ${seg("5h", rl.five_hour)} | ${seg(T.week, rl.seven_day)}`
    );
  }
} catch (e) {
  process.stdout.write(`statusline err: ${String(e.message).slice(0, 40)}`);
}
