#!/usr/bin/env node
/*
 * Claude Code 額度狀態列 — 單檔安裝器(跨平台:Windows / macOS / Linux / WSL)
 *
 * 用法(擇一):
 *   1. 本機檔案:    node install.mjs
 *   2. 直接從網路:  curl -fsSL <raw-url>/install.mjs | node -
 *                   (PowerShell)  irm <raw-url>/install.mjs | node -
 *
 * 安裝後狀態列顯示:
 *   Opus 4.8 | 5h 剩 87% (重置 3h12m) | 週 剩 62% (重置 4d6h)
 *
 * 自動處理會因機器而異的東西,毋須手改:
 *   - node 完整路徑 → 用當前執行此檔的 node(process.execPath),保證正確
 *   - 使用者家目錄  → 用 os.homedir(),自動指向各人 ~/.claude
 *   - 命令格式      → 正斜線 + 雙引號,避開 Windows 類 bash shell 吃反斜線、
 *                     路徑含空白被切斷的坑
 *   - settings.json → 解析後僅合併 statusLine 鍵,保留既有設定
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

// === 內嵌的狀態列腳本(base64,避免引號/${} 跳脫問題) ===
const SCRIPT_B64 =
  "IyEvdXNyL2Jpbi9lbnYgbm9kZQovLyBDbGF1ZGUgQ29kZSBzdGF0dXNMaW5lOiDpoa/npLroqILplrHmlrnmoYjnmoQgNSDlsI/mmYIgLyA3IOWkqSh3ZWVrbHkp5Ymp6aSY6aGN5bqm6IiH6YeN572u5YCS5pW444CCCi8vIHJhdGVfbGltaXRzIOWDhSBQcm8vTWF4IOiogumWseOAgeS4lOacrCBzZXNzaW9uIOeZvOmBjuesrOS4gOasoeiri+axguW+jOaJjeacg+WHuuePvizlj6/og73nvLrmvI/jgIIKYXN5bmMgZnVuY3Rpb24gcmVhZFN0ZGluKCkgewogIGNvbnN0IGNodW5rcyA9IFtdOwogIGZvciBhd2FpdCAoY29uc3QgYyBvZiBwcm9jZXNzLnN0ZGluKSBjaHVua3MucHVzaChjKTsKICByZXR1cm4gQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKCJ1dGY4Iik7Cn0KCmZ1bmN0aW9uIGNvdW50ZG93bihyZXNldHNBdCkgewogIGlmICghcmVzZXRzQXQpIHJldHVybiAiIjsKICBjb25zdCBzZWNzID0gcmVzZXRzQXQgLSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKTsKICBpZiAoc2VjcyA8PSAwKSByZXR1cm4gIuWNs+Wwh+mHjee9riI7CiAgY29uc3QgZCA9IE1hdGguZmxvb3Ioc2VjcyAvIDg2NDAwKTsKICBjb25zdCBoID0gTWF0aC5mbG9vcigoc2VjcyAlIDg2NDAwKSAvIDM2MDApOwogIGNvbnN0IG0gPSBNYXRoLmZsb29yKChzZWNzICUgMzYwMCkgLyA2MCk7CiAgaWYgKGQgPiAwKSByZXR1cm4gYCR7ZH1kJHtofWhgOwogIGlmIChoID4gMCkgcmV0dXJuIGAke2h9aCR7bX1tYDsKICByZXR1cm4gYCR7bX1tYDsKfQoKZnVuY3Rpb24gc2VnKGxhYmVsLCB3aW4pIHsKICBpZiAoIXdpbiB8fCB3aW4udXNlZF9wZXJjZW50YWdlID09IG51bGwpIHJldHVybiBgJHtsYWJlbH0g4oCUYDsKICBjb25zdCByZW1haW4gPSBNYXRoLm1heCgwLCAxMDAgLSB3aW4udXNlZF9wZXJjZW50YWdlKS50b0ZpeGVkKDApOwogIGNvbnN0IHJlc2V0ID0gY291bnRkb3duKHdpbi5yZXNldHNfYXQpOwogIHJldHVybiBgJHtsYWJlbH0g5YmpICR7cmVtYWlufSUke3Jlc2V0ID8gYCAo6YeN572uICR7cmVzZXR9KWAgOiAiIn1gOwp9Cgp0cnkgewogIGNvbnN0IHJhdyA9ICgoYXdhaXQgcmVhZFN0ZGluKCkpIHx8ICJ7fSIpLnJlcGxhY2UoL17vu78vLCAiIikudHJpbSgpIHx8ICJ7fSI7CiAgY29uc3QgaW5wdXQgPSBKU09OLnBhcnNlKHJhdyk7CiAgY29uc3QgbW9kZWwgPSBpbnB1dD8ubW9kZWw/LmRpc3BsYXlfbmFtZSB8fCAiQ2xhdWRlIjsKICBjb25zdCBybCA9IGlucHV0LnJhdGVfbGltaXRzOwogIGlmICghcmwpIHsKICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke21vZGVsfSB8IOmhjeW6puizh+ioiuW+hemmluasoeiri+axguW+jOmhr+ekumApOwogIH0gZWxzZSB7CiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZSgKICAgICAgYCR7bW9kZWx9IHwgJHtzZWcoIjVoIiwgcmwuZml2ZV9ob3VyKX0gfCAke3NlZygi6YCxIiwgcmwuc2V2ZW5fZGF5KX1gCiAgICApOwogIH0KfSBjYXRjaCAoZSkgewogIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGBzdGF0dXNsaW5lIGVycjogJHtTdHJpbmcoZS5tZXNzYWdlKS5zbGljZSgwLCA0MCl9YCk7Cn0K";

const claudeDir = join(homedir(), ".claude");
mkdirSync(claudeDir, { recursive: true });

// 1. 寫出狀態列腳本到 ~/.claude/
const scriptDst = join(claudeDir, "statusline-limits.mjs");
writeFileSync(scriptDst, Buffer.from(SCRIPT_B64, "base64"));

// 2. 組跨 shell 安全的命令字串(正斜線 + 雙引號 + node 絕對路徑)
const nodePath = process.execPath.replace(/\\/g, "/");
const script = scriptDst.replace(/\\/g, "/");
const command = `"${nodePath}" "${script}"`;

// 3. 合併進 ~/.claude/settings.json(保留既有設定)
const settingsPath = join(claudeDir, "settings.json");
let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^﻿/, ""));
  } catch {
    console.error(
      `${settingsPath} 解析失敗(JSON 格式有誤),請先修正或刪除後重跑。`
    );
    process.exit(1);
  }
}
settings.statusLine = { type: "command", command };
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log("✅ 已安裝額度狀態列");
console.log("   腳本   :", scriptDst);
console.log("   命令   :", command);
console.log("   設定檔 :", settingsPath);
console.log("");
console.log("請完全重啟 Claude Code。送出第一則訊息、收到回應後即顯示即時額度。");
console.log("(額度欄位僅 Pro/Max 訂閱、且本 session 首次回應後才會出現)");
