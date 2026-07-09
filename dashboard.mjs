#!/usr/bin/env node
// Claude Code Usage Dashboard — see every account's 5h / weekly quota on one page.
//
// Zero dependencies. Two data sources, merged per account:
//   1. Snapshots (default) — statusline-limits.mjs drops each profile's latest
//      rate_limits into ~/.claude-usage/ whenever the status line renders.
//      No API calls, no tokens. Data is as fresh as your last prompt.
//   2. Live (--live)      — reads each profile's OAuth token from
//      <config-dir>/.credentials.json and asks Anthropic's usage endpoint
//      directly. Fresh even for idle accounts, but the endpoint rate-limits
//      hard, so results are cached for 60s and fetched at most once per load.
//
// Usage:
//   node dashboard.mjs               start on http://localhost:3777 and open it
//   node dashboard.mjs zh            Traditional Chinese UI
//   node dashboard.mjs --live        also poll the OAuth usage endpoint
//   node dashboard.mjs --port 8080   custom port
//   node dashboard.mjs --no-open     don't launch the browser
//   node dashboard.mjs demo          render three fake accounts (preview, reads nothing)
//
// Env vars:
//   CLAUDE_USAGE_DIRS   extra snapshot dirs, ";"-separated (default ~/.claude-usage,
//                       plus every WSL distro's ~/.claude-usage when on Windows)
//   CLAUDE_CONFIG_DIRS  config dirs to use for --live, ";"-separated (default:
//                       every ~/.claude* dir that contains .credentials.json)
//   CLAUDE_SL_IGNORE    profile keys to hide, ";"-separated; matches "key" or
//                       "key|host" (drop a retired account without deleting files)
//   CLAUDE_SL_MAX_AGE_DAYS  hide snapshot-only cards not updated in N days
//                       (default 0 = keep forever; live cards are never aged out)
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir, platform, hostname } from "node:os";
import { join, basename } from "node:path";
import { execFileSync, exec } from "node:child_process";

const args = process.argv.slice(2);
const ZH = args.includes("zh") || process.env.CLAUDE_SL_LANG === "zh";
const DEMO = args.includes("demo");
const LIVE = !DEMO && args.includes("--live");
const OPEN = !args.includes("--no-open");
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) || 3777 : 3777;
const WIN = platform() === "win32";

// ---------- snapshot source ----------

function wslHomes() {
  if (!WIN) return [];
  try {
    // `wsl -l -q` prints UTF-16LE distro names, one per line
    const out = execFileSync("wsl.exe", ["-l", "-q"], { timeout: 5000 })
      .toString("utf16le")
      .split(/\r?\n/)
      .map((s) => s.replace(/\0/g, "").trim())
      .filter(Boolean);
    const homes = [];
    for (const distro of out) {
      const base = `\\\\wsl$\\${distro}\\home`;
      try {
        for (const user of readdirSync(base)) homes.push(join(base, user));
      } catch {}
    }
    return homes;
  } catch {
    return [];
  }
}

function snapshotDirs() {
  const dirs = [join(homedir(), ".claude-usage")];
  for (const h of wslHomes()) dirs.push(join(h, ".claude-usage"));
  const extra = process.env.CLAUDE_USAGE_DIRS;
  if (extra) dirs.push(...extra.split(";").map((s) => s.trim()).filter(Boolean));
  return [...new Set(dirs)];
}

function readSnapshots() {
  const out = [];
  for (const dir of snapshotDirs()) {
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (s && s.rate_limits) out.push({ ...s, source: "snapshot" });
      } catch {}
    }
  }
  return out;
}

// ---------- live source (--live) ----------

function configDirs() {
  const env = process.env.CLAUDE_CONFIG_DIRS;
  if (env) return env.split(";").map((s) => s.trim()).filter(Boolean);
  const roots = [homedir(), ...wslHomes()];
  const dirs = [];
  for (const root of roots) {
    let names;
    try {
      names = readdirSync(root).filter((n) => /^\.claude[^.]*$/.test(n));
    } catch {
      continue;
    }
    for (const n of names) {
      const d = join(root, n);
      try {
        if (statSync(d).isDirectory() && existsSync(join(d, ".credentials.json")))
          dirs.push(d);
      } catch {}
    }
  }
  return dirs;
}

function isoToEpoch(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

function liveEmail(dir) {
  try {
    const j = JSON.parse(
      readFileSync(join(dir, ".claude.json"), "utf8").replace(/^﻿/, "")
    );
    return j?.oauthAccount?.emailAddress;
  } catch {
    return undefined;
  }
}

// Windows and WSL profiles can share a dir name (".claude-b") yet be logged
// into different accounts, so the host is part of an entry's identity.
function hostOfDir(dir) {
  const m = /^\\\\wsl\$\\([^\\]+)/.exec(dir);
  return m ? `${m[1]} (wsl)` : `${hostname()} (${platform()})`;
}

// last successful live entry per dir, so a transient 429 / network blip falls
// back to the previous numbers instead of blanking the card.
const lastGood = new Map();

async function fetchLiveOne(dir) {
  const key = basename(dir);
  const host = hostOfDir(dir);
  try {
    const creds = JSON.parse(
      readFileSync(join(dir, ".credentials.json"), "utf8").replace(/^﻿/, "")
    );
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) return { key, host, source: "live", error: "no token" };
    if (oauth.expiresAt && oauth.expiresAt < Date.now())
      return { key, host, source: "live", error: "token expired (open Claude Code once to refresh)" };
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) {
      // don't blank the panel on a transient limit — keep the last good numbers,
      // and signal fetchLive() to back off so we stop hammering the endpoint.
      const prev = lastGood.get(dir);
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      return prev
        ? { ...prev, liveError: "rate-limited (429) · showing last known", rateLimited: true, retryAfter }
        : { key, host, source: "live", error: "endpoint rate-limited (429), retry later", rateLimited: true, retryAfter };
    }
    if (!res.ok) {
      const prev = lastGood.get(dir);
      return prev
        ? { ...prev, liveError: `HTTP ${res.status} · showing last known` }
        : { key, host, source: "live", error: `HTTP ${res.status}` };
    }
    const u = await res.json();
    const win = (w) =>
      w && w.utilization != null
        ? { used_percentage: w.utilization, resets_at: isoToEpoch(w.resets_at) }
        : undefined;
    // per-model weekly caps live in the `limits` array as weekly_scoped entries
    const scoped = (u.limits || [])
      .filter((l) => l.kind === "weekly_scoped" && l.scope?.model?.display_name)
      .map((l) => ({
        label: l.scope.model.display_name,
        used_percentage: l.percent,
        resets_at: isoToEpoch(l.resets_at),
      }));
    const entry = {
      key,
      host,
      email: liveEmail(dir),
      configDir: dir,
      plan: oauth.subscriptionType,
      source: "live",
      // token expiry — a later value means a more recently refreshed (fresher)
      // token, which is how the dashboard ranks which machine to show first.
      tokenExpiresAt: oauth.expiresAt,
      rate_limits: { five_hour: win(u.five_hour), seven_day: win(u.seven_day) },
      scoped,
      updatedAt: Date.now(),
    };
    lastGood.set(dir, entry); // remember good data to fall back on during a 429
    return entry;
  } catch (e) {
    const prev = lastGood.get(dir);
    const msg = String(e.message).slice(0, 80);
    return prev ? { ...prev, liveError: `${msg} · showing last known` } : { key, host, source: "live", error: msg };
  }
}

// The usage endpoint rate-limits hard, so be conservative: refresh at most every
// few minutes, fetch accounts one at a time instead of bursting them all at once,
// and after a 429 back off for longer. Quotas move slowly enough to stay fresh.
const LIVE_TTL = 5 * 60_000;      // normal minimum gap between endpoint sweeps
const BACKOFF_TTL = 15 * 60_000;  // longer gap once we've been rate-limited
let liveCache = { at: 0, data: [], nextAllowed: 0 };
async function fetchLive() {
  const now = Date.now();
  const fresh = now - liveCache.at < LIVE_TTL;
  const backingOff = now < liveCache.nextAllowed;
  if ((fresh || backingOff) && liveCache.data.length) return liveCache.data;
  // sequential with a small gap, so we never fire every account simultaneously
  const data = [];
  for (const dir of configDirs()) {
    data.push(await fetchLiveOne(dir));
    await new Promise((r) => setTimeout(r, 300));
  }
  const hitLimit = data.some((d) => d.rateLimited);
  const retryAfterMs = Math.max(0, ...data.map((d) => (d.retryAfter || 0) * 1000));
  liveCache = { at: now, data, nextAllowed: hitLimit ? now + Math.max(BACKOFF_TTL, retryAfterMs) : 0 };
  return data;
}

// ---------- demo (preview with fake data, reads nothing) ----------

function demoAccounts() {
  const now = Math.floor(Date.now() / 1000);
  const acct = (key, email, h5, wk, extra) => ({
    key,
    email,
    host: "demo",
    plan: "max",
    model: "Opus 4.8",
    source: "snapshot",
    updatedAt: Date.now() - 42_000,
    rate_limits: {
      five_hour: { used_percentage: h5, resets_at: now + 3 * 3600 + 12 * 60 },
      seven_day: { used_percentage: wk, resets_at: now + 4 * 86400 + 6 * 3600 },
    },
    ...extra,
  });
  return [
    acct(".claude", "work@example.com", 13, 38, { host: "ubuntu (wsl)" }),
    acct(".claude-b", "side@example.com", 71, 52, { host: "ubuntu (wsl)", source: "live",
      scoped: [{ label: "Opus", used_percentage: 64, resets_at: now + 4 * 86400 }] }),
    acct(".claude-c", "play@example.com", 96, 88, { host: "desktop (win32)",
      updatedAt: Date.now() - 26 * 3600 * 1000 }),
  ];
}

// ---------- merge ----------

// Rank machines by the freshest token/snapshot they hold, so the box you most
// recently used floats to the top, and keep every account grouped under its own
// machine (accounts of one host stay contiguous for the section dividers).
function sortByFreshHost(arr) {
  const recency = (e) => e.tokenExpiresAt || e.updatedAt || 0;
  const hostScore = new Map();
  for (const e of arr) {
    const h = e.host || "?";
    hostScore.set(h, Math.max(hostScore.get(h) || 0, recency(e)));
  }
  return arr.sort((a, b) => {
    const ha = a.host || "?", hb = b.host || "?";
    if (ha !== hb)
      return (hostScore.get(hb) || 0) - (hostScore.get(ha) || 0) || ha.localeCompare(hb);
    return recency(b) - recency(a) || (a.key || "").localeCompare(b.key || "");
  });
}

async function collect() {
  if (DEMO) return sortByFreshHost(demoAccounts());
  const snaps = readSnapshots();
  const live = LIVE ? await fetchLive() : [];
  // One card per profile. Dir names repeat across Windows/WSL with different
  // logins, so identity is key+host; live (fresh, authoritative) wins over a
  // snapshot of the same profile, newest snapshot wins over older ones.
  const byKey = new Map();
  const idOf = (e) => `${e.key || "?"}|${e.host || "?"}`;
  for (const s of snaps) {
    const prev = byKey.get(idOf(s));
    if (!prev || (s.updatedAt || 0) > (prev.updatedAt || 0)) byKey.set(idOf(s), s);
  }
  for (const l of live) {
    const id = idOf(l);
    if (l.error) {
      const prev = byKey.get(id);
      if (prev) prev.liveError = l.error;
      else byKey.set(id, l);
    } else byKey.set(id, { ...byKey.get(id), ...l });
  }
  // Accounts come and go; snapshots linger. CLAUDE_SL_IGNORE hides a profile by
  // key (".claude-c") or key|host, and CLAUDE_SL_MAX_AGE_DAYS drops snapshot-only
  // cards not seen in N days (0 = keep forever, the default). Live cards are never
  // aged out — a fresh API answer proves the account is alive.
  const ignore = new Set(
    (process.env.CLAUDE_SL_IGNORE || "").split(";").map((s) => s.trim()).filter(Boolean)
  );
  const maxAgeMs = (Number(process.env.CLAUDE_SL_MAX_AGE_DAYS) || 0) * 86400 * 1000;
  const now = Date.now();
  const kept = [...byKey.values()]
    .filter((e) => !ignore.has(e.key) && !ignore.has(idOf(e)))
    .filter((e) => !(maxAgeMs > 0 && e.source !== "live" && e.updatedAt && now - e.updatedAt > maxAgeMs));
  return sortByFreshHost(kept);
}

// ---------- web ----------

const T = ZH
  ? { title: "Claude 多帳號用量", h5: "5 小時", week: "週", updated: "更新於", live: "即時", cached: "快取", none: "尚無資料 — 開一個該帳號的 Claude Code 視窗並送出一則訊息", empty: "找不到任何快照。先在各帳號跑過 statusline，或用 --live 啟動。", soon: "即將重置", auto: "每 30 秒自動更新", acctWord: " 個帳號", left: "已用", resetPrefix: "重置於 ", agoTail: "前" }
  : { title: "Claude Multi-Account Usage", h5: "5-hour", week: "Weekly", updated: "updated ", live: "live", cached: "cached", none: "no data yet — open a Claude Code window on this account and send one message", empty: "No snapshots found. Run the statusline on each account first, or start with --live.", soon: "resetting", auto: "auto-refreshes every 30s", acctWord: " accounts", left: "used", resetPrefix: "resets ", agoTail: " ago" };

const PAGE = `<!doctype html>
<html lang="${ZH ? "zh-Hant" : "en"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${T.title}</title>
<style>
  :root { color-scheme: dark;
    --bg:oklch(20% 0.012 260); --panel:oklch(25% 0.012 260); --pill:oklch(28% 0.012 260);
    --track:oklch(35% 0.012 260); --line:oklch(100% 0 0 / .06); --rowline:oklch(100% 0 0 / .05);
    --t0:oklch(97% 0.01 260); --t1:oklch(90% 0.01 260); --t2:oklch(65% 0.02 260);
    --t3:oklch(60% 0.02 260); --t4:oklch(58% 0.02 260); --t5:oklch(52% 0.02 260);
    --red:oklch(70% 0.17 25); --yel:oklch(78% 0.14 85); --grn:oklch(75% 0.15 150);
    --pulse:oklch(72% 0.17 150); --amber:oklch(70% 0.13 85);
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
  body { margin:0; min-height:100vh; background:var(--bg); color:var(--t0);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    padding:clamp(16px,4vw,40px) clamp(12px,4vw,32px) 80px; display:flex; justify-content:center; box-sizing:border-box; }
  #wrap { width:100%; max-width:1180px; }
  h1 { margin:0 0 6px; font-size:clamp(20px,4vw,26px); font-weight:700; letter-spacing:-.01em; }
  #sub { display:flex; align-items:center; gap:6px; color:var(--t2); font-size:13px; margin-bottom:28px; }
  #sub svg { opacity:.8; }
  .dot { width:5px; height:5px; border-radius:50%; background:var(--pulse); display:inline-block; animation:pulse 2s ease-in-out infinite; }
  .livetxt { color:var(--pulse); font-weight:600; }
  .grp { margin-bottom:36px; }
  .ghdr { display:flex; align-items:center; gap:10px; margin-bottom:14px; color:var(--t2); }
  .gname { font-size:15px; font-weight:600; color:var(--t1); }
  .gcount { font-size:12px; color:var(--t3); background:var(--pill); padding:2px 9px; border-radius:20px; }
  .gtable { background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .rrow { display:flex; flex-wrap:wrap; align-items:center; gap:16px 24px; padding:16px 20px; border-bottom:1px solid var(--rowline); }
  .rrow:last-child { border-bottom:0; }
  .acell { min-width:200px; flex:1 1 240px; max-width:320px; display:flex; gap:10px; }
  .avatar { flex:none; width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center;
    font-size:12.5px; font-weight:700; color:oklch(98% 0.005 260); letter-spacing:.01em; }
  .ainfo { min-width:0; flex:1 1 auto; }
  .aline { display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-bottom:4px; }
  .aname { font-size:14px; font-weight:600; color:oklch(95% 0.01 260); font-family:ui-monospace,Menlo,monospace; }
  .badge { font-size:10.5px; font-weight:600; padding:2px 8px; border-radius:20px; }
  .bplan { background:oklch(45% 0.09 275 / .22); color:oklch(78% 0.09 275); }
  .bmodel { background:oklch(50% 0.02 260 / .3); color:oklch(75% 0.02 260); }
  .aemail { font-size:12px; color:var(--t3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:5px; }
  .astatus { display:flex; align-items:center; gap:5px; font-size:11.5px; color:var(--t3); }
  .astatus.stale { color:var(--amber); }
  .aerr { display:flex; align-items:center; gap:5px; font-size:11px; color:var(--red); margin-top:4px; }
  .mcell { flex:1 1 130px; min-width:120px; }
  .mtop { display:flex; justify-content:space-between; align-items:baseline; gap:8px; margin-bottom:6px; }
  .mlbl { font-size:11.5px; color:var(--t4); white-space:nowrap; }
  .mval { font-size:13px; font-weight:700; white-space:nowrap; }
  .mbar { height:6px; border-radius:4px; background:var(--track); overflow:hidden; margin-bottom:6px; }
  .mbar i { display:block; height:100%; border-radius:4px; }
  .msub { font-size:11px; color:var(--t5); }
  .none { flex:1 1 260px; color:var(--t3); font-size:12.5px; }
  #empty { color:var(--t3); max-width:520px; line-height:1.6; }
</style></head><body>
<div id="wrap"><h1>${T.title}</h1><div id="sub"></div><div id="groups"></div><div id="empty" hidden>${T.empty}</div></div>
<script>
const T = ${JSON.stringify(T)};
const I = {
  spin:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 5V3M12 21v-2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 7a5 5 0 1 0 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  mon:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M9 20h6M12 16v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  clock:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3.2 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  warn:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 3 22 20H2Z" fill="currentColor" opacity=".18" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 9v5M12 17.5v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};
function cd(resetsAt){ if(!resetsAt) return ""; let s=resetsAt-Math.floor(Date.now()/1000);
  if(s<=0) return T.soon; const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  return d>0? d+"d"+h+"h" : h>0? h+"h"+m+"m" : m+"m"; }
function ago(ms){ const s=Math.floor((Date.now()-ms)/1000);
  return s<60? s+"s" : s<3600? Math.floor(s/60)+"m" : s<86400? Math.floor(s/3600)+"h" : Math.floor(s/86400)+"d"; }
function esc(x){ return String(x==null?"":x).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
// A snapshot is stale after 15 min without a fresh prompt in that account's window.
function staleOf(a){ return !!(a.updatedAt && Date.now()-a.updatedAt > 15*60*1000); }
// Deterministic avatar hue from the account identity, so colors are stable across reloads.
function hueOf(s){ let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return h%360; }
// One metric cell: used% (bold, traffic-light color — more used = redder),
// bar filled to used, reset countdown.
function metricCell(label, w){
  if(!w || w.used_percentage==null) return "";
  const used=Math.round(Math.min(100,Math.max(0,w.used_percentage)));
  const c = used>=80?"var(--red)":used>=50?"var(--yel)":"var(--grn)";
  const t = w.resets_at?cd(w.resets_at):"";
  return '<div class="mcell"><div class="mtop"><span class="mlbl">'+esc(label)+'</span>'+
    '<span class="mval" style="color:'+c+'">'+used+'%</span></div>'+
    '<div class="mbar"><i style="width:'+used+'%;background:'+c+'"></i></div>'+
    '<div class="msub">'+T.left+(t?' · '+(t===T.soon?t:T.resetPrefix+t):'')+'</div></div>';
}
function row(a){
  const stale = staleOf(a);
  const id = a.email||a.key||"?";
  const init = esc(String(a.email||String(a.key||"?").replace(/^\\./,"")).slice(0,2).toUpperCase());
  let h = '<div class="rrow"><div class="acell">'+
    '<div class="avatar" style="background:oklch(58% 0.14 '+hueOf(id)+')">'+init+'</div><div class="ainfo">'+
    '<div class="aline"><span class="aname">'+esc(a.key)+'</span>'+
    (a.plan?'<span class="badge bplan">'+esc(a.plan)+'</span>':'')+
    (a.model?'<span class="badge bmodel">'+esc(a.model)+'</span>':'')+'</div>'+
    (a.email?'<div class="aemail">'+esc(a.email)+'</div>':'')+
    '<div class="astatus'+(stale?' stale':'')+'">'+(stale?I.warn:I.clock)+'<span>'+
      (stale?T.cached:T.live)+(a.updatedAt?' · '+T.updated+ago(a.updatedAt)+T.agoTail:'')+'</span></div>'+
    ((a.liveError||a.error)?'<div class="aerr">'+I.warn+'<span>'+esc(a.liveError||a.error)+'</span></div>':'')+
    '</div></div>';
  const rl = a.rate_limits||{};
  const cells = metricCell(T.h5, rl.five_hour) + metricCell(T.week, rl.seven_day) +
    (a.scoped||[]).map(s=>metricCell(s.label, s)).join("");
  h += cells || '<div class="none">'+T.none+'</div>';
  return h+'</div>';
}
async function refresh(){
  const r = await fetch("/api/usage"); const j = await r.json();
  document.getElementById("sub").innerHTML = I.spin+'<span>'+T.auto+'</span>'+
    (j.live?'<span class="dot"></span><span class="livetxt">live</span>':'')+
    (j.demo?'<span>· demo</span>':'');
  document.getElementById("empty").hidden = j.accounts.length>0;
  // One table per machine. collect() already orders accounts freshest-host-first
  // and keeps each host's rows contiguous, so Map insertion order is the order we
  // render — the box you most recently used floats to the top.
  const groups = new Map();
  for(const a of j.accounts){ const g=a.host||"?"; if(!groups.has(g)) groups.set(g,[]); groups.get(g).push(a); }
  document.getElementById("groups").innerHTML = [...groups.keys()].map(n=>{
    const rows = groups.get(n);
    return '<div class="grp"><div class="ghdr">'+I.mon+'<span class="gname">'+esc(n)+'</span>'+
      '<span class="gcount">'+rows.length+T.acctWord+'</span></div>'+
      '<div class="gtable">'+rows.map(row).join("")+'</div></div>';
  }).join("");
}
refresh(); setInterval(refresh, 30000);
</script></body></html>`;

const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/usage")) {
      const accounts = await collect();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ live: LIVE, demo: DEMO, accounts }));
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    }
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e.stack || e));
  }
});

const url = `http://localhost:${PORT}`;

function openBrowser() {
  const cmd = WIN ? `start "" "${url}"` : platform() === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    // A dashboard is already serving this port (e.g. the desktop shortcut was
    // double-clicked twice, or claude-trio started one) — just show that one.
    console.log(ZH ? `儀表板已在 ${url} 執行中,直接開啟。` : `Dashboard already running at ${url}, opening it.`);
    if (OPEN) openBrowser();
    setTimeout(() => process.exit(0), 1500); // let the console window be read, not flash
    return;
  }
  console.error(String(e.stack || e));
  setTimeout(() => process.exit(1), 15000); // keep the window up long enough to read the error
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`${T.title}: ${url}${LIVE ? "  (--live)" : ""}${DEMO ? "  (demo)" : ""}`);
  if (OPEN) openBrowser();
});
