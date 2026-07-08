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
    if (res.status === 429)
      return { key, host, source: "live", error: "endpoint rate-limited (429), retry later" };
    if (!res.ok) return { key, host, source: "live", error: `HTTP ${res.status}` };
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
    return {
      key,
      host,
      email: liveEmail(dir),
      configDir: dir,
      plan: oauth.subscriptionType,
      source: "live",
      rate_limits: { five_hour: win(u.five_hour), seven_day: win(u.seven_day) },
      scoped,
      updatedAt: Date.now(),
    };
  } catch (e) {
    return { key, host, source: "live", error: String(e.message).slice(0, 80) };
  }
}

let liveCache = { at: 0, data: [] };
async function fetchLive() {
  if (Date.now() - liveCache.at < 60_000) return liveCache.data; // be gentle: 60s cache
  const data = await Promise.all(configDirs().map(fetchLiveOne));
  liveCache = { at: Date.now(), data };
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
    acct(".claude", "work@example.com", 13, 38),
    acct(".claude-b", "side@example.com", 71, 52, { source: "live",
      scoped: [{ label: "Opus", used_percentage: 64, resets_at: now + 4 * 86400 }] }),
    acct(".claude-c", "play@example.com", 96, 88),
  ];
}

// ---------- merge ----------

async function collect() {
  if (DEMO) return demoAccounts();
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
  return [...byKey.values()]
    .filter((e) => !ignore.has(e.key) && !ignore.has(idOf(e)))
    .filter((e) => !(maxAgeMs > 0 && e.source !== "live" && e.updatedAt && now - e.updatedAt > maxAgeMs))
    .sort((a, b) => idOf(a).localeCompare(idOf(b)));
}

// ---------- web ----------

const T = ZH
  ? { title: "Claude 多帳號用量", h5: "5 小時", week: "週", updated: "更新於", live: "即時", cached: "快取", none: "尚無資料 — 開一個該帳號的 Claude Code 視窗並送出一則訊息", empty: "找不到任何快照。先在各帳號跑過 statusline，或用 --live 啟動。", soon: "即將重置", auto: "每 30 秒自動更新", acctWord: " 個帳號", left: "剩餘", resetPrefix: "重置於 ", agoTail: "前" }
  : { title: "Claude Multi-Account Usage", h5: "5-hour", week: "Weekly", updated: "updated ", live: "live", cached: "cached", none: "no data yet — open a Claude Code window on this account and send one message", empty: "No snapshots found. Run the statusline on each account first, or start with --live.", soon: "resetting", auto: "auto-refreshes every 30s", acctWord: " accounts", left: "left", resetPrefix: "resets ", agoTail: " ago" };

const PAGE = `<!doctype html>
<html lang="${ZH ? "zh-Hant" : "en"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${T.title}</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, "Segoe UI", sans-serif; background:#111418; color:#e6e6e6; margin:0; padding:24px; }
  h1 { font-size:18px; font-weight:600; margin:0 0 4px; }
  #sub { color:#8a919c; font-size:12px; margin-bottom:20px; }
  #cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:16px; max-width:1100px; }
  .card { background:#1a1f26; border:1px solid #2a313b; border-radius:12px; padding:16px 18px; }
  .card h2 { font-size:15px; margin:0; font-weight:600; }
  .meta { color:#8a919c; font-size:11.5px; margin:2px 0 12px; }
  .row { margin:10px 0; }
  .lbl { display:flex; justify-content:space-between; font-size:12.5px; margin-bottom:4px; color:#c8cdd4; }
  .bar { height:8px; border-radius:4px; background:#2a313b; overflow:hidden; }
  .fill { height:100%; border-radius:4px; transition:width .4s; }
  .ok { background:#3fb960; } .warn { background:#e0a93e; } .crit { background:#e05d5d; }
  .tag { font-size:10px; padding:1px 7px; border-radius:9px; border:1px solid #3a424d; color:#9aa3ae; margin-left:8px; vertical-align:1px; }
  .stale { color:#e0a93e; border-color:#e0a93e; }
  .err { color:#e05d5d; font-size:12px; margin-top:8px; }
  .none { color:#8a919c; font-size:12.5px; }
  #empty { color:#8a919c; max-width:520px; line-height:1.6; }
  .stale-card { opacity:.5; filter:grayscale(1); }
  #summary { max-width:1100px; margin:0 0 20px; border:1px solid #2a313b; border-radius:12px; background:#1a1f26; padding:2px 16px; }
  #summary:empty { display:none; }
  #summary .shdr { color:#8a919c; font-size:11px; padding:10px 2px 2px; }
  .srow { display:grid; grid-template-columns:minmax(84px,150px) 1fr 1fr auto; align-items:center; gap:16px; padding:9px 2px; border-top:1px solid #222831; font-size:12.5px; }
  .shdr + .srow { border-top:0; }
  .skey { font-weight:600; color:#e6e6e6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sseg { display:flex; align-items:center; gap:8px; color:#c8cdd4; min-width:0; }
  .sseg .slbl { color:#8a919c; white-space:nowrap; }
  .smini { flex:1; min-width:36px; height:6px; border-radius:3px; background:#2a313b; overflow:hidden; }
  .smini > i { display:block; height:100%; border-radius:3px; }
  .sval { white-space:nowrap; }
  .sage { color:#8a919c; font-size:11px; white-space:nowrap; text-align:right; }
</style></head><body>
<h1>${T.title}</h1><div id="sub"></div><div id="summary"></div><div id="cards"></div><div id="empty" hidden>${T.empty}</div>
<script>
const T = ${JSON.stringify(T)};
function cd(resetsAt){ if(!resetsAt) return ""; let s=resetsAt-Math.floor(Date.now()/1000);
  if(s<=0) return T.soon; const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  return d>0? d+"d"+h+"h" : h>0? h+"h"+m+"m" : m+"m"; }
function ago(ms){ const s=Math.floor((Date.now()-ms)/1000);
  return s<60? s+"s" : s<3600? Math.floor(s/60)+"m" : s<86400? Math.floor(s/3600)+"h" : Math.floor(s/86400)+"d"; }
function esc(x){ return String(x==null?"":x).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function bar(label, w){
  if(!w || w.used_percentage==null) return "";
  const used=Math.min(100,Math.max(0,w.used_percentage)), left=(100-used).toFixed(0);
  const cls = used>=90?"crit":used>=70?"warn":"ok";
  return '<div class="row"><div class="lbl"><span>'+esc(label)+'</span><span>'+left+'% '+(T.week==="週"?"剩餘":"left")+
    (w.resets_at?' · '+T.reset+' '+cd(w.resets_at):'')+'</span></div>'+
    '<div class="bar"><div class="fill '+cls+'" style="width:'+used+'%"></div></div></div>';
}
// A snapshot is stale after 15 min without a fresh prompt in that account's window.
function staleOf(a){ return !!(a.updatedAt && Date.now()-a.updatedAt > 15*60*1000); }
// Compact bar for the per-account summary strip (fill = used%, text = remaining).
function miniBar(w){
  if(!w || w.used_percentage==null) return '<span class="smini"></span><span class="sval">—</span>';
  const used=Math.min(100,Math.max(0,w.used_percentage)), left=(100-used).toFixed(0);
  const cls = used>=90?"crit":used>=70?"warn":"ok";
  return '<span class="smini"><i class="'+cls+'" style="width:'+used+'%"></i></span>'+
    '<span class="sval">'+left+'%'+(w.resets_at?' · '+cd(w.resets_at):'')+'</span>';
}
// One row per account, keyed by login email (the real identity — the same
// profile-dir name can be a different account on another host, so keying by dir
// name alone could hide one). Machines merge: freshest wins, since 5h/weekly
// quota is per-account, not per-machine. Fixed order by profile key.
function summaryData(accounts){
  const byAcct=new Map();
  for(const a of accounts){ const id=a.email||a.key||"?"; const p=byAcct.get(id);
    if(!p || (a.updatedAt||0)>(p.updatedAt||0)) byAcct.set(id,a); }
  return [...byAcct.values()].sort((x,y)=>
    String(x.key||"").localeCompare(String(y.key||"")) || String(x.email||"").localeCompare(String(y.email||"")));
}
async function refresh(){
  const r = await fetch("/api/usage"); const j = await r.json();
  const zh = T.week==="週";
  document.getElementById("sub").textContent =
    (zh?"每 30 秒自動更新":"auto-refreshes every 30s") + (j.live?" · --live":"") + (j.demo?" · demo":"");
  const summary = document.getElementById("summary");
  const srows = summaryData(j.accounts);
  summary.innerHTML = srows.length ? '<div class="shdr">'+(zh?"每帳號最新用量":"latest per account")+'</div>'+
    srows.map(a=>{ const rl=a.rate_limits||{};
      return '<div class="srow'+(staleOf(a)?" stale-card":"")+'">'+
        '<span class="skey">'+esc(a.key)+'</span>'+
        '<span class="sseg"><span class="slbl">'+T.h5+'</span>'+miniBar(rl.five_hour)+'</span>'+
        '<span class="sseg"><span class="slbl">'+T.week+'</span>'+miniBar(rl.seven_day)+'</span>'+
        '<span class="sage">'+(a.updatedAt?T.updated+' '+ago(a.updatedAt)+(zh?"前":" ago"):'')+'</span>'+
      '</div>'; }).join("") : "";
  const cards = document.getElementById("cards");
  document.getElementById("empty").hidden = j.accounts.length>0;
  // Stale cards sink to the bottom; filter keeps each group's collect() order (stable).
  const ordered = [...j.accounts.filter(a=>!staleOf(a)), ...j.accounts.filter(staleOf)];
  cards.innerHTML = ordered.map(a=>{
    const stale = staleOf(a);
    let h = '<div class="card'+(stale?" stale-card":"")+'"><h2>'+esc(a.key)+
      (a.source?'<span class="tag'+(stale?" stale":"")+'">'+(a.source==="live"?T.live:T.snap)+
        (a.updatedAt?' · '+T.updated+' '+ago(a.updatedAt)+(zh?"前":" ago"):'')+
        (stale?' · '+T.stale:'')+'</span>':'')+'</h2>';
    h += '<div class="meta">'+esc([a.email, a.plan && (T.plan+": "+a.plan), a.model, a.host].filter(Boolean).join(" · "))+'</div>';
    const rl = a.rate_limits||{};
    const bars = bar(T.h5, rl.five_hour) + bar(T.week, rl.seven_day) +
      (a.scoped||[]).map(s=>bar(T.week+" · "+s.label, s)).join("");
    h += bars || '<div class="none">'+T.none+'</div>';
    if(a.liveError||a.error) h += '<div class="err">live: '+esc(a.liveError||a.error)+'</div>';
    return h+'</div>';
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
