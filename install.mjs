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
  "IyEvdXNyL2Jpbi9lbnYgbm9kZQovLyBDbGF1ZGUgQ29kZSBzdGF0dXNMaW5lOiBzdWJzY3JpcHRpb24gNS1ob3VyIC8gd2Vla2x5IHVzYWdlIHJlbWFpbmluZyArIHJlc2V0IGNvdW50ZG93bi4KLy8gcmF0ZV9saW1pdHMgb25seSBhcHBlYXJzIG9uIFByby9NYXggcGxhbnMgYWZ0ZXIgdGhlIGZpcnN0IHJlcXVlc3QgaW4gYSBzZXNzaW9uOyBtYXkgYmUgYWJzZW50LgovLyBQYXNzICJ6aCIgYXMgdGhlIGZpcnN0IGFyZ3VtZW50IGZvciBUcmFkaXRpb25hbCBDaGluZXNlOyBkZWZhdWx0cyB0byBFbmdsaXNoLgpjb25zdCBaSCA9IHByb2Nlc3MuYXJndlsyXSA9PT0gInpoIjsKY29uc3QgVCA9IFpICiAgPyB7CiAgICAgIHdhaXQ6ICLpoY3luqbos4foqIrlvoXpppbmrKHoq4vmsYLlvozpoa/npLoiLAogICAgICB3ZWVrOiAi6YCxIiwKICAgICAgbm9uZTogKGxhYmVsKSA9PiBgJHtsYWJlbH0g4oCUYCwKICAgICAgc2VnOiAobGFiZWwsIHIsIGMpID0+IGAke2xhYmVsfSDliakgJHtyfSUke2MgPyBgICjph43nva4gJHtjfSlgIDogIiJ9YCwKICAgICAgc29vbjogIuWNs+Wwh+mHjee9riIsCiAgICB9CiAgOiB7CiAgICAgIHdhaXQ6ICJ1c2FnZSBzaG93biBhZnRlciBmaXJzdCByZXF1ZXN0IiwKICAgICAgd2VlazogIndlZWsiLAogICAgICBub25lOiAobGFiZWwpID0+IGAke2xhYmVsfSDigJRgLAogICAgICBzZWc6IChsYWJlbCwgciwgYykgPT4gYCR7bGFiZWx9ICR7cn0lIGxlZnQke2MgPyBgIChyZXNldHMgJHtjfSlgIDogIiJ9YCwKICAgICAgc29vbjogInJlc2V0dGluZyIsCiAgICB9OwoKYXN5bmMgZnVuY3Rpb24gcmVhZFN0ZGluKCkgewogIGNvbnN0IGNodW5rcyA9IFtdOwogIGZvciBhd2FpdCAoY29uc3QgYyBvZiBwcm9jZXNzLnN0ZGluKSBjaHVua3MucHVzaChjKTsKICByZXR1cm4gQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKCJ1dGY4Iik7Cn0KCmZ1bmN0aW9uIGNvdW50ZG93bihyZXNldHNBdCkgewogIGlmICghcmVzZXRzQXQpIHJldHVybiAiIjsKICBjb25zdCBzZWNzID0gcmVzZXRzQXQgLSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKTsKICBpZiAoc2VjcyA8PSAwKSByZXR1cm4gVC5zb29uOwogIGNvbnN0IGQgPSBNYXRoLmZsb29yKHNlY3MgLyA4NjQwMCk7CiAgY29uc3QgaCA9IE1hdGguZmxvb3IoKHNlY3MgJSA4NjQwMCkgLyAzNjAwKTsKICBjb25zdCBtID0gTWF0aC5mbG9vcigoc2VjcyAlIDM2MDApIC8gNjApOwogIGlmIChkID4gMCkgcmV0dXJuIGAke2R9ZCR7aH1oYDsKICBpZiAoaCA+IDApIHJldHVybiBgJHtofWgke219bWA7CiAgcmV0dXJuIGAke219bWA7Cn0KCmZ1bmN0aW9uIHNlZyhsYWJlbCwgd2luKSB7CiAgaWYgKCF3aW4gfHwgd2luLnVzZWRfcGVyY2VudGFnZSA9PSBudWxsKSByZXR1cm4gVC5ub25lKGxhYmVsKTsKICBjb25zdCByZW1haW4gPSBNYXRoLm1heCgwLCAxMDAgLSB3aW4udXNlZF9wZXJjZW50YWdlKS50b0ZpeGVkKDApOwogIHJldHVybiBULnNlZyhsYWJlbCwgcmVtYWluLCBjb3VudGRvd24od2luLnJlc2V0c19hdCkpOwp9Cgp0cnkgewogIGNvbnN0IHJhdyA9ICgoYXdhaXQgcmVhZFN0ZGluKCkpIHx8ICJ7fSIpLnJlcGxhY2UoL17vu78vLCAiIikudHJpbSgpIHx8ICJ7fSI7CiAgY29uc3QgaW5wdXQgPSBKU09OLnBhcnNlKHJhdyk7CiAgY29uc3QgbW9kZWwgPSBpbnB1dD8ubW9kZWw/LmRpc3BsYXlfbmFtZSB8fCAiQ2xhdWRlIjsKICBjb25zdCBybCA9IGlucHV0LnJhdGVfbGltaXRzOwogIGlmICghcmwpIHsKICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke21vZGVsfSB8ICR7VC53YWl0fWApOwogIH0gZWxzZSB7CiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZSgKICAgICAgYCR7bW9kZWx9IHwgJHtzZWcoIjVoIiwgcmwuZml2ZV9ob3VyKX0gfCAke3NlZyhULndlZWssIHJsLnNldmVuX2RheSl9YAogICAgKTsKICB9Cn0gY2F0Y2ggKGUpIHsKICBwcm9jZXNzLnN0ZG91dC53cml0ZShgc3RhdHVzbGluZSBlcnI6ICR7U3RyaW5nKGUubWVzc2FnZSkuc2xpY2UoMCwgNDApfWApOwp9Cg==";

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
