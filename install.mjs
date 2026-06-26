#!/usr/bin/env node
/*
 * Claude Code Usage Statusline — single-file installer (Windows / macOS / Linux / WSL)
 *
 * Usage:
 *   node install.mjs            install (English status line)
 *   node install.mjs zh         install (Traditional Chinese status line)
 *   curl -fsSL <raw-url>/install.mjs | node -        (append "zh" for Chinese)
 *
 * It auto-detects the running Node.js path and home directory, builds a
 * machine-specific command (absolute path, forward slashes, quoted — so it
 * survives Claude Code's bash-like shell on Windows), and merges a statusLine
 * entry into ~/.claude/settings.json without touching existing settings.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const ZH = process.argv[2] === "zh";
const log = ZH
  ? {
      ok: "✅ 已安裝額度狀態列",
      script: "   腳本   :",
      command: "   命令   :",
      settings: "   設定檔 :",
      restart:
        "請完全重啟 Claude Code。送出第一則訊息、收到回應後即顯示即時額度。",
      cond: "(額度欄位僅 Pro/Max 訂閱、且本 session 首次回應後才會出現)",
      parseFail: (p) => `${p} 解析失敗(JSON 格式有誤),請先修正或刪除後重跑。`,
    }
  : {
      ok: "✅ Usage status line installed",
      script: "   Script   :",
      command: "   Command  :",
      settings: "   Settings :",
      restart:
        "Fully restart Claude Code. Usage appears after the first response in a session.",
      cond: "(Usage fields require a Pro/Max plan and only appear after the first response.)",
      parseFail: (p) => `${p} is not valid JSON. Fix or remove it, then retry.`,
    };

// === Embedded status line script (base64, to avoid quote/${} escaping) ===
const SCRIPT_B64 =
  "IyEvdXNyL2Jpbi9lbnYgbm9kZQ0KLy8gQ2xhdWRlIENvZGUgc3RhdHVzTGluZTogc3Vic2NyaXB0aW9uIDUtaG91ciAvIHdlZWtseSB1c2FnZSByZW1haW5pbmcgKyByZXNldCBjb3VudGRvd24uDQovLyByYXRlX2xpbWl0cyBvbmx5IGFwcGVhcnMgb24gUHJvL01heCBwbGFucyBhZnRlciB0aGUgZmlyc3QgcmVxdWVzdCBpbiBhIHNlc3Npb247IG1heSBiZSBhYnNlbnQuDQovLyBQYXNzICJ6aCIgYXMgdGhlIGZpcnN0IGFyZ3VtZW50IGZvciBUcmFkaXRpb25hbCBDaGluZXNlOyBkZWZhdWx0cyB0byBFbmdsaXNoLg0KY29uc3QgWkggPSBwcm9jZXNzLmFyZ3ZbMl0gPT09ICJ6aCI7DQpjb25zdCBUID0gWkgNCiAgPyB7DQogICAgICB3YWl0OiAi6aGN5bqm6LOH6KiK5b6F6aaW5qyh6KuL5rGC5b6M6aGv56S6IiwNCiAgICAgIHdlZWs6ICLpgLEiLA0KICAgICAgbm9uZTogKGxhYmVsKSA9PiBgJHtsYWJlbH0g4oCUYCwNCiAgICAgIHNlZzogKGxhYmVsLCByLCBjKSA9PiBgJHtsYWJlbH0g5YmpICR7cn0lJHtjID8gYCAo6YeN572uICR7Y30pYCA6ICIifWAsDQogICAgICBzb29uOiAi5Y2z5bCH6YeN572uIiwNCiAgICB9DQogIDogew0KICAgICAgd2FpdDogInVzYWdlIHNob3duIGFmdGVyIGZpcnN0IHJlcXVlc3QiLA0KICAgICAgd2VlazogIndlZWsiLA0KICAgICAgbm9uZTogKGxhYmVsKSA9PiBgJHtsYWJlbH0g4oCUYCwNCiAgICAgIHNlZzogKGxhYmVsLCByLCBjKSA9PiBgJHtsYWJlbH0gJHtyfSUgbGVmdCR7YyA/IGAgKHJlc2V0cyAke2N9KWAgOiAiIn1gLA0KICAgICAgc29vbjogInJlc2V0dGluZyIsDQogICAgfTsNCg0KYXN5bmMgZnVuY3Rpb24gcmVhZFN0ZGluKCkgew0KICBjb25zdCBjaHVua3MgPSBbXTsNCiAgZm9yIGF3YWl0IChjb25zdCBjIG9mIHByb2Nlc3Muc3RkaW4pIGNodW5rcy5wdXNoKGMpOw0KICByZXR1cm4gQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKCJ1dGY4Iik7DQp9DQoNCmZ1bmN0aW9uIGNvdW50ZG93bihyZXNldHNBdCkgew0KICBpZiAoIXJlc2V0c0F0KSByZXR1cm4gIiI7DQogIGNvbnN0IHNlY3MgPSByZXNldHNBdCAtIE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApOw0KICBpZiAoc2VjcyA8PSAwKSByZXR1cm4gVC5zb29uOw0KICBjb25zdCBkID0gTWF0aC5mbG9vcihzZWNzIC8gODY0MDApOw0KICBjb25zdCBoID0gTWF0aC5mbG9vcigoc2VjcyAlIDg2NDAwKSAvIDM2MDApOw0KICBjb25zdCBtID0gTWF0aC5mbG9vcigoc2VjcyAlIDM2MDApIC8gNjApOw0KICBpZiAoZCA+IDApIHJldHVybiBgJHtkfWQke2h9aGA7DQogIGlmIChoID4gMCkgcmV0dXJuIGAke2h9aCR7bX1tYDsNCiAgcmV0dXJuIGAke219bWA7DQp9DQoNCmZ1bmN0aW9uIHNlZyhsYWJlbCwgd2luKSB7DQogIGlmICghd2luIHx8IHdpbi51c2VkX3BlcmNlbnRhZ2UgPT0gbnVsbCkgcmV0dXJuIFQubm9uZShsYWJlbCk7DQogIGNvbnN0IHJlbWFpbiA9IE1hdGgubWF4KDAsIDEwMCAtIHdpbi51c2VkX3BlcmNlbnRhZ2UpLnRvRml4ZWQoMCk7DQogIHJldHVybiBULnNlZyhsYWJlbCwgcmVtYWluLCBjb3VudGRvd24od2luLnJlc2V0c19hdCkpOw0KfQ0KDQp0cnkgew0KICBjb25zdCByYXcgPSAoKGF3YWl0IHJlYWRTdGRpbigpKSB8fCAie30iKS5yZXBsYWNlKC9e77u/LywgIiIpLnRyaW0oKSB8fCAie30iOw0KICBjb25zdCBpbnB1dCA9IEpTT04ucGFyc2UocmF3KTsNCiAgY29uc3QgbW9kZWwgPSBpbnB1dD8ubW9kZWw/LmRpc3BsYXlfbmFtZSB8fCAiQ2xhdWRlIjsNCiAgY29uc3QgZWZmb3J0ID0gaW5wdXQ/LmVmZm9ydD8ubGV2ZWw7DQogIGNvbnN0IGhlYWQgPSBlZmZvcnQgPyBgJHttb2RlbH3CtyR7ZWZmb3J0fWAgOiBtb2RlbDsNCiAgY29uc3QgcmwgPSBpbnB1dC5yYXRlX2xpbWl0czsNCiAgaWYgKCFybCkgew0KICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2hlYWR9IHwgJHtULndhaXR9YCk7DQogIH0gZWxzZSB7DQogICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoDQogICAgICBgJHtoZWFkfSB8ICR7c2VnKCI1aCIsIHJsLmZpdmVfaG91cil9IHwgJHtzZWcoVC53ZWVrLCBybC5zZXZlbl9kYXkpfWANCiAgICApOw0KICB9DQp9IGNhdGNoIChlKSB7DQogIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGBzdGF0dXNsaW5lIGVycjogJHtTdHJpbmcoZS5tZXNzYWdlKS5zbGljZSgwLCA0MCl9YCk7DQp9DQo=";

const claudeDir = join(homedir(), ".claude");
mkdirSync(claudeDir, { recursive: true });

// 1. Write the status line script to ~/.claude/
const scriptDst = join(claudeDir, "statusline-limits.mjs");
writeFileSync(scriptDst, Buffer.from(SCRIPT_B64, "base64"));

// 2. Build a cross-shell-safe command (forward slashes, quoted, absolute node path)
const nodePath = process.execPath.replace(/\\/g, "/");
const script = scriptDst.replace(/\\/g, "/");
const command = `"${nodePath}" "${script}"${ZH ? " zh" : ""}`;

// 3. Merge into ~/.claude/settings.json (preserving existing settings)
const settingsPath = join(claudeDir, "settings.json");
let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^﻿/, ""));
  } catch {
    console.error(log.parseFail(settingsPath));
    process.exit(1);
  }
}
settings.statusLine = { type: "command", command };
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log(log.ok);
console.log(log.script, scriptDst);
console.log(log.command, command);
console.log(log.settings, settingsPath);
console.log("");
console.log(log.restart);
console.log(log.cond);
