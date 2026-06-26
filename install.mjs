#!/usr/bin/env node
/*
 * Claude Code Usage Statusline — single-file installer (Windows / macOS / Linux / WSL)
 *
 * Usage:
 *   node install.mjs                        install (English, default segments)
 *   node install.mjs zh                     install (Traditional Chinese)
 *   node install.mjs zh model,effort,5h,week,account   pick which segments to show
 *   node install.mjs all                    enable every segment (incl. account)
 *   curl -fsSL <raw-url>/install.mjs | node - zh all    (works as a one-liner too)
 *
 * Language and segments can also come from env: CLAUDE_SL_LANG=zh, CLAUDE_SL_SEGMENTS=all
 * Available segments: model, effort, 5h, week, account, email (default: model,effort,5h,week).
 *
 * It auto-detects the running Node.js path and home directory, builds a
 * machine-specific command (absolute path, forward slashes, quoted — so it
 * survives Claude Code's bash-like shell on Windows), and merges a statusLine
 * entry into ~/.claude/settings.json without touching existing settings.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const ZH = args.includes("zh") || process.env.CLAUDE_SL_LANG === "zh";
const segArg =
  args.find((a) => a !== "zh") || process.env.CLAUDE_SL_SEGMENTS || "";
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
  "IyEvdXNyL2Jpbi9lbnYgbm9kZQovLyBDbGF1ZGUgQ29kZSBzdGF0dXNMaW5lOiBtb2RlbCArIHJlYXNvbmluZyBlZmZvcnQgKyBzdWJzY3JpcHRpb24gNWgvd2Vla2x5IHVzYWdlICsgYWNjb3VudC4KLy8gcmF0ZV9saW1pdHMgb25seSBhcHBlYXJzIG9uIFByby9NYXggcGxhbnMgYWZ0ZXIgdGhlIGZpcnN0IHJlcXVlc3QgaW4gYSBzZXNzaW9uOyBtYXkgYmUgYWJzZW50LgovLwovLyBBcmd1bWVudHMgKGFueSBvcmRlciwgc3BhY2Utc2VwYXJhdGVkKToKLy8gICB6aCAgICAgICAgICBUcmFkaXRpb25hbCBDaGluZXNlIG91dHB1dCAoZGVmYXVsdDogRW5nbGlzaCkKLy8gICBkZW1vICAgICAgICBSZW5kZXIgYSBzYW1wbGUgbGluZSB1c2luZyBmYWtlIGRhdGEgaW5zdGVhZCBvZiByZWFkaW5nIHN0ZGluIChmb3IgcHJldmlld3MpCi8vICAgPHNlZ21lbnRzPiAgQ29tbWEtc2VwYXJhdGVkIGxpc3QgcGlja2luZyB3aGljaCBwYXJ0cyB0byBzaG93LCBpbiBvcmRlci4gQXZhaWxhYmxlOgovLyAgICAgICAgICAgICAgICAgbW9kZWwgICAgbW9kZWwgZGlzcGxheSBuYW1lICh3aXRoIMK3ZWZmb3J0IGFwcGVuZGVkIHdoZW4gImVmZm9ydCIgaXMgb24pCi8vICAgICAgICAgICAgICAgICBlZmZvcnQgICByZWFzb25pbmcgZWZmb3J0IGxldmVsIChsb3cvbWVkaXVtL2hpZ2gveGhpZ2gvbWF4KTsgYXR0YWNoZXMgdG8gbW9kZWwKLy8gICAgICAgICAgICAgICAgIDVoICAgICAgIDUtaG91ciBxdW90YSByZW1haW5pbmcgKyByZXNldCBjb3VudGRvd24KLy8gICAgICAgICAgICAgICAgIHdlZWsgICAgIHdlZWtseSBxdW90YSByZW1haW5pbmcgKyByZXNldCBjb3VudGRvd24KLy8gICAgICAgICAgICAgICAgIGFjY291bnQgIGFjY291bnQgbmFtZSAodGhlIHBhcnQgYmVmb3JlIEAgaW4geW91ciBDbGF1ZGUgbG9naW4gZW1haWwpCi8vICAgICAgICAgICAgICAgICBlbWFpbCAgICBmdWxsIGFjY291bnQgZW1haWwKLy8gICAgICAgICAgICAgICBEZWZhdWx0IHdoZW4gb21pdHRlZDogbW9kZWwsZWZmb3J0LDVoLHdlZWsKLy8gICAgICAgICAgICAgICBVc2UgImFsbCIgZm9yIG1vZGVsLGVmZm9ydCw1aCx3ZWVrLGFjY291bnQKY29uc3QgYXJncyA9IHByb2Nlc3MuYXJndi5zbGljZSgyKTsKY29uc3QgWkggPSBhcmdzLmluY2x1ZGVzKCJ6aCIpIHx8IHByb2Nlc3MuZW52LkNMQVVERV9TTF9MQU5HID09PSAiemgiOwpjb25zdCBERU1PID0gYXJncy5pbmNsdWRlcygiZGVtbyIpOwpjb25zdCBzZWdBcmcgPQogIGFyZ3MuZmluZCgoYSkgPT4gYSAhPT0gInpoIiAmJiBhICE9PSAiZGVtbyIpIHx8IHByb2Nlc3MuZW52LkNMQVVERV9TTF9TRUdNRU5UUyB8fCAiIjsKY29uc3QgQUxMID0gIm1vZGVsLGVmZm9ydCw1aCx3ZWVrLGFjY291bnQiOwpjb25zdCBzZWdzID0gKHNlZ0FyZyA9PT0gImFsbCIgPyBBTEwgOiBzZWdBcmcgfHwgIm1vZGVsLGVmZm9ydCw1aCx3ZWVrIikKICAuc3BsaXQoIiwiKQogIC5tYXAoKHMpID0+IHMudHJpbSgpKQogIC5maWx0ZXIoQm9vbGVhbik7CmNvbnN0IGhhcyA9IChzKSA9PiBzZWdzLmluY2x1ZGVzKHMpOwoKaW1wb3J0IHsgcmVhZEZpbGVTeW5jIH0gZnJvbSAibm9kZTpmcyI7CmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tICJub2RlOm9zIjsKaW1wb3J0IHsgam9pbiB9IGZyb20gIm5vZGU6cGF0aCI7Cgpjb25zdCBUID0gWkgKICA/IHsKICAgICAgd2FpdDogIumhjeW6puizh+ioiuW+hemmluasoeiri+axguW+jOmhr+ekuiIsCiAgICAgIHdlZWs6ICLpgLEiLAogICAgICBub25lOiAobGFiZWwpID0+IGAke2xhYmVsfSDigJRgLAogICAgICBzZWc6IChsYWJlbCwgciwgYykgPT4gYCR7bGFiZWx9IOWJqSAke3J9JSR7YyA/IGAgKOmHjee9riAke2N9KWAgOiAiIn1gLAogICAgICBzb29uOiAi5Y2z5bCH6YeN572uIiwKICAgIH0KICA6IHsKICAgICAgd2FpdDogInVzYWdlIHNob3duIGFmdGVyIGZpcnN0IHJlcXVlc3QiLAogICAgICB3ZWVrOiAid2VlayIsCiAgICAgIG5vbmU6IChsYWJlbCkgPT4gYCR7bGFiZWx9IOKAlGAsCiAgICAgIHNlZzogKGxhYmVsLCByLCBjKSA9PiBgJHtsYWJlbH0gJHtyfSUgbGVmdCR7YyA/IGAgKHJlc2V0cyAke2N9KWAgOiAiIn1gLAogICAgICBzb29uOiAicmVzZXR0aW5nIiwKICAgIH07Cgphc3luYyBmdW5jdGlvbiByZWFkU3RkaW4oKSB7CiAgY29uc3QgY2h1bmtzID0gW107CiAgZm9yIGF3YWl0IChjb25zdCBjIG9mIHByb2Nlc3Muc3RkaW4pIGNodW5rcy5wdXNoKGMpOwogIHJldHVybiBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoInV0ZjgiKTsKfQoKZnVuY3Rpb24gY291bnRkb3duKHJlc2V0c0F0KSB7CiAgaWYgKCFyZXNldHNBdCkgcmV0dXJuICIiOwogIGNvbnN0IHNlY3MgPSByZXNldHNBdCAtIE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApOwogIGlmIChzZWNzIDw9IDApIHJldHVybiBULnNvb247CiAgY29uc3QgZCA9IE1hdGguZmxvb3Ioc2VjcyAvIDg2NDAwKTsKICBjb25zdCBoID0gTWF0aC5mbG9vcigoc2VjcyAlIDg2NDAwKSAvIDM2MDApOwogIGNvbnN0IG0gPSBNYXRoLmZsb29yKChzZWNzICUgMzYwMCkgLyA2MCk7CiAgaWYgKGQgPiAwKSByZXR1cm4gYCR7ZH1kJHtofWhgOwogIGlmIChoID4gMCkgcmV0dXJuIGAke2h9aCR7bX1tYDsKICByZXR1cm4gYCR7bX1tYDsKfQoKZnVuY3Rpb24gc2VnKGxhYmVsLCB3aW4pIHsKICBpZiAoIXdpbiB8fCB3aW4udXNlZF9wZXJjZW50YWdlID09IG51bGwpIHJldHVybiBULm5vbmUobGFiZWwpOwogIGNvbnN0IHJlbWFpbiA9IE1hdGgubWF4KDAsIDEwMCAtIHdpbi51c2VkX3BlcmNlbnRhZ2UpLnRvRml4ZWQoMCk7CiAgcmV0dXJuIFQuc2VnKGxhYmVsLCByZW1haW4sIGNvdW50ZG93bih3aW4ucmVzZXRzX2F0KSk7Cn0KCi8vIEFjY291bnQgZW1haWwgaXMgTk9UIGluIHRoZSBzdGF0dXMgbGluZSBKU09OOyByZWFkIGl0IGZyb20gfi8uY2xhdWRlLmpzb24uCmZ1bmN0aW9uIGFjY291bnQoZnVsbCkgewogIHRyeSB7CiAgICBjb25zdCBqID0gSlNPTi5wYXJzZSgKICAgICAgcmVhZEZpbGVTeW5jKGpvaW4oaG9tZWRpcigpLCAiLmNsYXVkZS5qc29uIiksICJ1dGY4IikucmVwbGFjZSgvXu+7vy8sICIiKQogICAgKTsKICAgIGNvbnN0IGVtYWlsID0gaj8ub2F1dGhBY2NvdW50Py5lbWFpbEFkZHJlc3M7CiAgICBpZiAoIWVtYWlsKSByZXR1cm4gIiI7CiAgICByZXR1cm4gZnVsbCA/IGVtYWlsIDogZW1haWwuc3BsaXQoIkAiKVswXTsKICB9IGNhdGNoIHsKICAgIHJldHVybiAiIjsKICB9Cn0KCmNvbnN0IERFTU9fREFUQSA9IHsKICBtb2RlbDogeyBkaXNwbGF5X25hbWU6ICJPcHVzIDQuOCIgfSwKICBlZmZvcnQ6IHsgbGV2ZWw6ICJoaWdoIiB9LAogIHJhdGVfbGltaXRzOiB7CiAgICBmaXZlX2hvdXI6IHsKICAgICAgdXNlZF9wZXJjZW50YWdlOiAxMywKICAgICAgcmVzZXRzX2F0OiBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIDMgKiAzNjAwICsgMTIgKiA2MCwKICAgIH0sCiAgICBzZXZlbl9kYXk6IHsKICAgICAgdXNlZF9wZXJjZW50YWdlOiAzOCwKICAgICAgcmVzZXRzX2F0OiBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIDQgKiA4NjQwMCArIDYgKiAzNjAwLAogICAgfSwKICB9LAp9OwoKdHJ5IHsKICBsZXQgaW5wdXQ7CiAgaWYgKERFTU8pIHsKICAgIGlucHV0ID0gREVNT19EQVRBOwogIH0gZWxzZSB7CiAgICBjb25zdCByYXcgPSAoKGF3YWl0IHJlYWRTdGRpbigpKSB8fCAie30iKS5yZXBsYWNlKC9e77u/LywgIiIpLnRyaW0oKSB8fCAie30iOwogICAgaW5wdXQgPSBKU09OLnBhcnNlKHJhdyk7CiAgfQoKICBjb25zdCBtb2RlbCA9IGlucHV0Py5tb2RlbD8uZGlzcGxheV9uYW1lIHx8ICJDbGF1ZGUiOwogIGNvbnN0IGVmZm9ydCA9IGlucHV0Py5lZmZvcnQ/LmxldmVsOwogIGNvbnN0IHBhcnRzID0gW107CgogIGlmIChoYXMoIm1vZGVsIikpIHsKICAgIHBhcnRzLnB1c2goaGFzKCJlZmZvcnQiKSAmJiBlZmZvcnQgPyBgJHttb2RlbH3CtyR7ZWZmb3J0fWAgOiBtb2RlbCk7CiAgfSBlbHNlIGlmIChoYXMoImVmZm9ydCIpICYmIGVmZm9ydCkgewogICAgcGFydHMucHVzaChlZmZvcnQpOwogIH0KCiAgY29uc3QgcmwgPSBpbnB1dC5yYXRlX2xpbWl0czsKICBpZiAoaGFzKCI1aCIpIHx8IGhhcygid2VlayIpKSB7CiAgICBpZiAoIXJsKSB7CiAgICAgIHBhcnRzLnB1c2goVC53YWl0KTsKICAgIH0gZWxzZSB7CiAgICAgIGlmIChoYXMoIjVoIikpIHBhcnRzLnB1c2goc2VnKCI1aCIsIHJsLmZpdmVfaG91cikpOwogICAgICBpZiAoaGFzKCJ3ZWVrIikpIHBhcnRzLnB1c2goc2VnKFQud2Vlaywgcmwuc2V2ZW5fZGF5KSk7CiAgICB9CiAgfQoKICBpZiAoaGFzKCJhY2NvdW50IikgfHwgaGFzKCJlbWFpbCIpKSB7CiAgICBsZXQgYSA9IGFjY291bnQoaGFzKCJlbWFpbCIpKTsKICAgIGlmICghYSAmJiBERU1PKSBhID0gaGFzKCJlbWFpbCIpID8gInlvdUBleGFtcGxlLmNvbSIgOiAieW91IjsKICAgIGlmIChhKSBwYXJ0cy5wdXNoKGEpOwogIH0KCiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUocGFydHMuam9pbigiIHwgIikgfHwgbW9kZWwpOwp9IGNhdGNoIChlKSB7CiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYHN0YXR1c2xpbmUgZXJyOiAke1N0cmluZyhlLm1lc3NhZ2UpLnNsaWNlKDAsIDQwKX1gKTsKfQo=";

const claudeDir = join(homedir(), ".claude");
mkdirSync(claudeDir, { recursive: true });

// 1. Write the status line script to ~/.claude/
const scriptDst = join(claudeDir, "statusline-limits.mjs");
writeFileSync(scriptDst, Buffer.from(SCRIPT_B64, "base64"));

// 2. Build a cross-shell-safe command (forward slashes, quoted, absolute node path)
const nodePath = process.execPath.replace(/\\/g, "/");
const script = scriptDst.replace(/\\/g, "/");
const tail = [ZH ? "zh" : "", segArg].filter(Boolean).join(" ");
const command = `"${nodePath}" "${script}"${tail ? " " + tail : ""}`;

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
