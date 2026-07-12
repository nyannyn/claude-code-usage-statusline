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
// Quota belongs to the account, not the machine, so entries sharing an email
// (e.g. the same login on Windows and WSL) are merged into one card; the
// other machine's copy is listed under "others" on that card instead of
// getting a card of its own.
//
// Usage:
//   node dashboard.mjs               start on http://localhost:3777 and open it
//   node dashboard.mjs zh            Traditional Chinese UI
//   node dashboard.mjs --live        also poll the OAuth usage endpoint
//   node dashboard.mjs --port 8080   custom port
//   node dashboard.mjs --no-open     don't launch the browser
//   node dashboard.mjs demo          render three fake accounts (preview, reads nothing)
//   node dashboard.mjs --takeover    if the port is taken, ask that instance to
//                                    shut down (POST /api/shutdown) and take it over
//   node dashboard.mjs --daemon      run detached, so it survives closing the terminal
//   node dashboard.mjs --status      is a daemon serving this port?
//   node dashboard.mjs --stop        stop the daemon on this port
//
// A daemon outlives its shell but not the machine: `wsl --shutdown`, a logout or
// a reboot ends it, and you start it again the same way.
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
import {
  readFileSync, readdirSync, existsSync, statSync,
  writeFileSync, unlinkSync, mkdirSync, openSync,
} from "node:fs";
import { homedir, platform, hostname } from "node:os";
import { join, basename } from "node:path";
import { execFileSync, exec, spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const ZH = args.includes("zh") || process.env.CLAUDE_SL_LANG === "zh";
const DEMO = args.includes("demo");
const LIVE = !DEMO && args.includes("--live");
const OPEN = !args.includes("--no-open");
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) || 3777 : 3777;
const TAKEOVER = args.includes("--takeover");
const DAEMON = args.includes("--daemon");
const STOP = args.includes("--stop");
const STATUS = args.includes("--status");
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
// into different accounts, so the host is part of an entry's identity. The label
// must come out identical whether the dashboard runs on Windows (seeing the
// distro as a \\wsl$ UNC path) or inside the distro itself (seeing a plain
// /home path), or live entries won't merge with the snapshots that
// statusline-limits.mjs wrote under "<distro> (wsl)".
function hostOfDir(dir) {
  const m = /^\\\\wsl\$\\([^\\]+)/.exec(dir);
  if (m) return `${m[1]} (wsl)`;
  if (process.env.WSL_DISTRO_NAME) return `${process.env.WSL_DISTRO_NAME} (wsl)`;
  return `${hostname()} (${platform()})`;
}

// last successful live entry per dir, so a transient 429 / network blip falls
// back to the previous numbers instead of blanking the card.
const lastGood = new Map();

async function fetchLiveOne(dir) {
  const key = basename(dir);
  const host = hostOfDir(dir);
  // errors carry the email too, so mergeByEmail can file them under the right
  // account card instead of giving a dead token a card of its own
  const email = liveEmail(dir);
  try {
    const creds = JSON.parse(
      readFileSync(join(dir, ".credentials.json"), "utf8").replace(/^﻿/, "")
    );
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) return { key, host, email, configDir: dir, source: "live", error: "no token" };
    if (oauth.expiresAt && oauth.expiresAt < Date.now())
      return { key, host, email, configDir: dir, source: "live", error: "token expired (open Claude Code once to refresh)" };
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
        : { key, host, email, source: "live", error: "endpoint rate-limited (429), retry later", rateLimited: true, retryAfter };
    }
    if (!res.ok) {
      const prev = lastGood.get(dir);
      return prev
        ? { ...prev, liveError: `HTTP ${res.status} · showing last known` }
        : { key, host, email, source: "live", error: `HTTP ${res.status}` };
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
      email,
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
    return prev ? { ...prev, liveError: `${msg} · showing last known` } : { key, host, email, source: "live", error: msg };
  }
}

// The usage endpoint rate-limits hard, so be conservative: refresh at most every
// few minutes, fetch accounts one at a time instead of bursting them all at once,
// and after a 429 back off for longer. Quotas move slowly enough to stay fresh.
const LIVE_TTL = 5 * 60_000;      // normal minimum gap between endpoint sweeps
const BACKOFF_TTL = 15 * 60_000;  // longer gap once we've been rate-limited
let liveCache = { at: 0, data: [], nextAllowed: 0 };

// errors that mean "this profile has no usable token right now" (as opposed to
// endpoint trouble like a 429) — these drive the red-vs-grey reminder styling
const TOKEN_ERR = /^(no token|token expired)/;

function tokenLooksValid(dir) {
  try {
    const oauth = JSON.parse(
      readFileSync(join(dir, ".credentials.json"), "utf8").replace(/^﻿/, "")
    )?.claudeAiOauth;
    return !!oauth?.accessToken && !(oauth.expiresAt && oauth.expiresAt < Date.now());
  } catch {
    return false;
  }
}

async function fetchLive() {
  const now = Date.now();
  const fresh = now - liveCache.at < LIVE_TTL;
  const backingOff = now < liveCache.nextAllowed;
  if ((fresh || backingOff) && liveCache.data.length) {
    // A cached "token expired / no token" verdict goes stale the moment the
    // user opens Claude Code (or logs in) and the credentials file is
    // rewritten. Re-reading that file is free, so if any dead-token entry has
    // come back to life, redo the sweep now instead of keeping the reminder
    // up for the rest of the cache window.
    const revived = liveCache.data.some(
      (d) => d.configDir && TOKEN_ERR.test(d.error || "") && tokenLooksValid(d.configDir)
    );
    if (!revived) return liveCache.data;
  }
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
    // Same email, two machines — the live/fresh Windows copy becomes the merged
    // card (titled by its CLAUDE_SL_ACCOUNT label), and the WSL copy's expired
    // token shows as a calm grey reminder, not a red line: one working token
    // proves the account itself is fine.
    acct(".claude", "work@example.com", 13, 38, { host: "desktop (win32)", source: "live", label: "work" }),
    { key: ".claude", host: "ubuntu (wsl)", email: "work@example.com", source: "live",
      error: "token expired (open Claude Code once to refresh)",
      updatedAt: Date.now() - 2 * 3600 * 1000 },
    // This account has no working token anywhere (stale snapshot + expired
    // token), so here the reminder turns red and the whole card dims.
    acct(".claude-c", "play@example.com", 96, 88, { host: "desktop (win32)",
      updatedAt: Date.now() - 26 * 3600 * 1000 }),
    { key: ".claude-c", host: "ubuntu (wsl)", email: "play@example.com", source: "live",
      error: "token expired (open Claude Code once to refresh)",
      updatedAt: Date.now() - 3 * 3600 * 1000 },
  ];
}

// ---------- merge ----------

// A single value used everywhere to rank "how fresh is this entry": a live
// token's expiry if we have one (a later value means a more recently
// refreshed, fresher token), else the last update timestamp.
const recency = (e) => e.tokenExpiresAt || e.updatedAt || 0;

// Quota is per-account, not per-machine, so entries sharing an email collapse
// into one card. Pick the freshest rate_limits-bearing entry as the card
// (falling back to plain recency if the whole group is error-only), and file
// every other entry from that email under "others" so its host/error is still
// visible without spawning a second card. Entries with no email (shouldn't
// normally happen) never merge — each stays its own card.

// "This entry proves the account works right now": a live probe succeeded, or
// the statusline rendered recently — a fresh snapshot means Claude Code is
// open on that account, so an "open Claude Code" reminder would be nonsense
// even while our cached probe verdict still says expired.
const FRESH_MS = 15 * 60_000; // matches the client's staleOf() threshold
const entryOk = (e) =>
  !!e.rate_limits &&
  ((e.source === "live" && !e.error) ||
    (!!e.updatedAt && Date.now() - e.updatedAt < FRESH_MS));
const deadToken = (e) => TOKEN_ERR.test(e.liveError || e.error || "");

function mergeByEmail(arr) {
  const byEmail = new Map();
  const solo = [];
  for (const e of arr) {
    if (!e.email) { solo.push(e); continue; }
    if (!byEmail.has(e.email)) byEmail.set(e.email, []);
    byEmail.get(e.email).push(e);
  }
  const merged = solo.map((e) => ({
    ...e, tokenOk: entryOk(e), dead: !entryOk(e) && deadToken(e),
  }));
  for (const group of byEmail.values()) {
    const withLimits = group.filter((e) => e.rate_limits);
    const pickFrom = withLimits.length ? withLimits : group;
    const main = pickFrom.reduce((best, e) => (recency(e) > recency(best) ? e : best));
    // One working token anywhere proves the account itself is fine — a dead
    // token on another machine is then routine (it refreshes the next time
    // that machine is used), so the client renders its reminder as plain grey
    // text. Only when NO token works (dead) does the reminder turn red and
    // the whole card dim.
    const tokenOk = group.some(entryOk);
    const dead = !tokenOk && group.some(deadToken);
    const others = group
      .filter((e) => e !== main)
      .map((e) => ({ host: e.host, key: e.key, error: e.liveError || e.error, updatedAt: e.updatedAt }))
      .filter((o) => o.error || o.updatedAt) // no error + no data = nothing to say
      .sort((a, b) => recency(b) - recency(a));
    const card = { ...main, tokenOk, dead, ...(others.length ? { others } : {}) };
    // a display label (CLAUDE_SL_ACCOUNT) may live on a snapshot that lost the
    // freshness race — carry it over so the card keeps its chosen name
    const labeled = group.filter((e) => e.label).sort((a, b) => recency(b) - recency(a))[0];
    merged.push(labeled && labeled !== main ? { ...card, label: labeled.label } : card);
  }
  return merged.sort((a, b) => recency(b) - recency(a));
}

async function collect() {
  if (DEMO) return mergeByEmail(demoAccounts());
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
  return mergeByEmail(kept);
}

// ---------- web ----------

const T = ZH
  ? { title: "Claude 多帳號用量", h5: "5 小時", week: "週", updated: "更新於", live: "即時", cached: "快取", none: "尚無資料 — 開一個該帳號的 Claude Code 視窗並送出一則訊息", empty: "找不到任何快照。先在各帳號跑過 statusline，或用 --live 啟動。", soon: "即將重置", expired: "已重置，等待新資料", auto: "每 30 秒自動更新", acctWord: " 個帳號", left: "已用", resetPrefix: "重置於 ", agoTail: "前" }
  : { title: "Claude Multi-Account Usage", h5: "5-hour", week: "Weekly", updated: "updated ", live: "live", cached: "cached", none: "no data yet — open a Claude Code window on this account and send one message", empty: "No snapshots found. Run the statusline on each account first, or start with --live.", soon: "resetting", expired: "reset — awaiting fresh data", auto: "auto-refreshes every 30s", acctWord: " accounts", left: "used", resetPrefix: "resets ", agoTail: " ago" };
// acctWord doubles as the header's "N accounts" label above the single flat list.

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
  .rrow.dead { opacity:.55; }
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
  .aerr.soft { color:var(--t5); }
  .aother { display:flex; align-items:center; gap:5px; font-size:11px; color:var(--t5); margin-top:4px; }
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
  // A snapshot outlives the window it measured. Once resets_at has passed the
  // quota rolled over, so the stored used% describes a window that no longer
  // exists — and we can't know what's been spent since. Say so instead of
  // guessing (0% would read as "quota free", the old number as "quota gone").
  if(w.resets_at && w.resets_at <= Math.floor(Date.now()/1000))
    return '<div class="mcell"><div class="mtop"><span class="mlbl">'+esc(label)+'</span>'+
      '<span class="mval" style="color:var(--t4)">—</span></div>'+
      '<div class="mbar"></div><div class="msub">'+T.expired+'</div></div>';
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
  // tokenOk = some token on this account still works, so a dead token elsewhere
  // is a routine grey note; dead = no token works anywhere → red + dimmed card.
  const errCls = a.tokenOk ? 'aerr soft' : 'aerr';
  let h = '<div class="rrow'+(a.dead?' dead':'')+'"><div class="acell">'+
    '<div class="avatar" style="background:oklch(58% 0.14 '+hueOf(id)+')">'+init+'</div><div class="ainfo">'+
    '<div class="aline"><span class="aname">'+esc(a.label||a.key)+'</span>'+
    (a.plan?'<span class="badge bplan">'+esc(a.plan)+'</span>':'')+
    (a.model?'<span class="badge bmodel">'+esc(a.model)+'</span>':'')+'</div>'+
    (a.email?'<div class="aemail">'+esc(a.email)+'</div>':'')+
    '<div class="astatus'+(stale?' stale':'')+'">'+(stale?I.warn:I.clock)+'<span>'+
      (stale?T.cached:T.live)+(a.updatedAt?' · '+T.updated+ago(a.updatedAt)+T.agoTail:'')+
      (a.host?' · '+esc(a.host):'')+'</span></div>'+
    ((a.liveError||a.error)?'<div class="'+errCls+'">'+I.warn+'<span>'+esc(a.liveError||a.error)+'</span></div>':'')+
    (a.others||[]).map(o=>
      o.error
        ? '<div class="'+errCls+'">'+I.warn+'<span>'+esc(o.host)+' · '+esc(o.key)+': '+esc(o.error)+'</span></div>'
        : '<div class="aother">'+I.clock+'<span>'+esc(o.host)+' · '+esc(o.key)+': '+T.cached+
          (o.updatedAt?' · '+ago(o.updatedAt)+T.agoTail:'')+'</span></div>'
    ).join("")+
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
  // One card per account (collect() already merged same-email entries across
  // machines), ordered freshest-first — the account you most recently used
  // floats to the top.
  document.getElementById("groups").innerHTML =
    '<div class="grp"><div class="ghdr">'+I.mon+'<span class="gname">'+esc(T.title)+'</span>'+
    '<span class="gcount">'+j.accounts.length+T.acctWord+'</span></div>'+
    '<div class="gtable">'+j.accounts.map(row).join("")+'</div></div>';
}
refresh(); setInterval(refresh, 30000);
</script></body></html>`;

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url.startsWith("/api/shutdown")) {
      // Lets a --takeover instance ask us to step aside instead of both
      // fighting over the port. Bound to 127.0.0.1 already, so no extra origin check.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => process.exit(0), 100);
    } else if (req.url.startsWith("/api/usage")) {
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

async function tryTakeover() {
  // Ask the running instance to shut down, then retry binding a few times —
  // it needs a moment to actually exit after acking the request. We can't use
  // the HTTP response to judge success (old instances 200 every path), so
  // success is defined purely as "we managed to listen()".
  try {
    await fetch(`http://localhost:${PORT}/api/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
  for (let attempt = 1; attempt <= 3; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const ok = await new Promise((resolve) => {
      // Swap out the main error handler for the duration of this attempt so a
      // failed retry doesn't re-enter (and recurse through) the outer handler.
      server.removeListener("error", onServerError);
      server.once("error", () => {
        server.on("error", onServerError);
        resolve(false);
      });
      server.listen(PORT, "127.0.0.1", () => {
        server.on("error", onServerError);
        resolve(true);
      });
    });
    if (ok) return true;
  }
  return false;
}

// ---------- daemon (--daemon / --status / --stop) ----------
//
// Detached background process, so the dashboard outlives the shell that started
// it. Survives closing the terminal; does not survive `wsl --shutdown`, logout
// or reboot. The pid file is per-port, so a scratch instance on another port
// never clobbers the real one's bookkeeping.

const STATE_DIR = join(homedir(), ".claude-usage");
const PID_FILE = join(STATE_DIR, `dashboard-${PORT}.pid`);
const LOG_FILE = join(STATE_DIR, "dashboard.log");

function readPid() {
  try {
    const s = JSON.parse(readFileSync(PID_FILE, "utf8"));
    return typeof s?.pid === "number" ? s : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0); // signal 0 only checks for existence
    return true;
  } catch {
    return false;
  }
}

// Is anything accepting connections on the port? Distinguishes "pid file points
// at a live server" from "pid file is stale, or the pid got recycled".
function probe(port) {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port, timeout: 700 });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
    sock.on("timeout", () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clearOwnPid() {
  const s = readPid();
  if (s && s.pid === process.pid) {
    try { unlinkSync(PID_FILE); } catch {}
  }
}

async function running() {
  const s = readPid();
  if (s && alive(s.pid) && (await probe(s.port || PORT))) return s;
  return null;
}

async function cmdStatus() {
  const s = await running();
  if (!s) {
    console.log(ZH ? `儀表板未在 port ${PORT} 執行。` : `No dashboard running on port ${PORT}.`);
    process.exit(1);
  }
  const mins = Math.round((Date.now() - (s.startedAt || Date.now())) / 60000);
  console.log(
    ZH
      ? `儀表板執行中: ${url} (pid ${s.pid}, 已執行 ${mins} 分鐘)\n記錄檔: ${LOG_FILE}`
      : `Dashboard running: ${url} (pid ${s.pid}, up ${mins}m)\nLog: ${LOG_FILE}`
  );
}

async function cmdStop() {
  const s = readPid();
  if (!s || !alive(s.pid)) {
    try { unlinkSync(PID_FILE); } catch {}
    console.log(ZH ? `儀表板未在 port ${PORT} 執行。` : `No dashboard running on port ${PORT}.`);
    return;
  }
  try { process.kill(s.pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 30 && alive(s.pid); i++) await sleep(100);
  try { unlinkSync(PID_FILE); } catch {}
  console.log(ZH ? `已停止儀表板 (pid ${s.pid})。` : `Stopped dashboard (pid ${s.pid}).`);
}

async function cmdDaemon() {
  const existing = await running();
  // With --takeover the point is to replace whatever is running, so fall
  // through and let the child do the takeover dance.
  if (existing && !TAKEOVER) {
    console.log(
      ZH ? `儀表板已在 ${url} 執行中 (pid ${existing.pid})。` : `Dashboard already running at ${url} (pid ${existing.pid}).`
    );
    if (OPEN) openBrowser();
    return;
  }
  mkdirSync(STATE_DIR, { recursive: true });
  const log = openSync(LOG_FILE, "a");
  // Drop --daemon or the child would fork forever; --no-open because a detached
  // process has no business opening a browser — the parent does that below.
  const childArgs = [
    fileURLToPath(import.meta.url),
    ...args.filter((a) => a !== "--daemon" && a !== "--no-open"),
    "--no-open",
  ];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  // Success = the child owns the port: its pid is in the pid file (written on
  // "listening") and the port answers. Probing alone isn't enough — under
  // --takeover the old instance still answers while the child waits its turn.
  for (let i = 0; i < 80; i++) {
    const s = readPid();
    if (s && s.pid === child.pid && (await probe(PORT))) {
      console.log(
        `${T.title}: ${url}${LIVE ? "  (--live)" : ""}  ${ZH ? `(背景執行, pid ${child.pid})` : `(daemon, pid ${child.pid})`}`
      );
      console.log(
        ZH
          ? `停止: node ${basename(fileURLToPath(import.meta.url))} --stop${portIdx >= 0 ? ` --port ${PORT}` : ""}`
          : `Stop with: node ${basename(fileURLToPath(import.meta.url))} --stop${portIdx >= 0 ? ` --port ${PORT}` : ""}`
      );
      if (OPEN) openBrowser();
      return;
    }
    await sleep(100);
  }
  console.error(
    ZH ? `背景啟動失敗，詳見 ${LOG_FILE}` : `Failed to start in the background — see ${LOG_FILE}`
  );
  process.exit(1);
}

// ---------- start ----------

function onServerError(e) {
  if (e.code === "EADDRINUSE") {
    if (TAKEOVER) {
      tryTakeover().then((ok) => {
        if (ok) {
          console.log(`${T.title}: ${url}${LIVE ? "  (--live)" : ""}${DEMO ? "  (demo)" : ""}  (takeover)`);
          if (OPEN) openBrowser();
        } else {
          console.log(
            ZH
              ? `接手失敗：舊實例不支援 takeover，請手動結束該 node 程序。`
              : `Takeover failed: the running instance doesn't support takeover — please end that node process manually.`
          );
          setTimeout(() => process.exit(1), 15000);
        }
      });
      return;
    }
    // A dashboard is already serving this port (e.g. the desktop shortcut was
    // double-clicked twice, or claude-trio started one) — just show that one.
    console.log(ZH ? `儀表板已在 ${url} 執行中,直接開啟。` : `Dashboard already running at ${url}, opening it.`);
    if (OPEN) openBrowser();
    setTimeout(() => process.exit(0), 1500); // let the console window be read, not flash
    return;
  }
  console.error(String(e.stack || e));
  setTimeout(() => process.exit(1), 15000); // keep the window up long enough to read the error
}
server.on("error", onServerError);

function serve() {
  // The pid file is written on "listening" (not in the listen callback) so the
  // takeover path — which listens again from inside tryTakeover() — records
  // its pid too, and --status / --stop work on it.
  server.on("listening", () => {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: PORT, startedAt: Date.now() }));
    } catch {} // bookkeeping only; never keep the dashboard from serving
  });
  process.on("exit", clearOwnPid);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => process.exit(0));
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`${T.title}: ${url}${LIVE ? "  (--live)" : ""}${DEMO ? "  (demo)" : ""}`);
    if (OPEN) openBrowser();
  });
}

if (STOP) await cmdStop();
else if (STATUS) await cmdStatus();
else if (DAEMON) await cmdDaemon();
else serve();
