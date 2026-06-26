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
  "IyEvdXNyL2Jpbi9lbnYgbm9kZQovLyBDbGF1ZGUgQ29kZSBzdGF0dXNMaW5lOiBtb2RlbCArIHJlYXNvbmluZyBlZmZvcnQgKyBzdWJzY3JpcHRpb24gNWgvd2Vla2x5IHVzYWdlICsgYWNjb3VudC4KLy8gcmF0ZV9saW1pdHMgb25seSBhcHBlYXJzIG9uIFByby9NYXggcGxhbnMgYWZ0ZXIgdGhlIGZpcnN0IHJlcXVlc3QgaW4gYSBzZXNzaW9uOyBtYXkgYmUgYWJzZW50LgovLwovLyBBcmd1bWVudHMgKGFueSBvcmRlciwgc3BhY2Utc2VwYXJhdGVkKToKLy8gICB6aCAgICAgICAgICBUcmFkaXRpb25hbCBDaGluZXNlIG91dHB1dCAoZGVmYXVsdDogRW5nbGlzaCkKLy8gICBkZW1vICAgICAgICBSZW5kZXIgYSBzYW1wbGUgbGluZSB1c2luZyBmYWtlIGRhdGEgaW5zdGVhZCBvZiByZWFkaW5nIHN0ZGluIChmb3IgcHJldmlld3MpCi8vICAgPHNlZ21lbnRzPiAgQ29tbWEtc2VwYXJhdGVkIGxpc3QgcGlja2luZyB3aGljaCBwYXJ0cyB0byBzaG93LCBpbiBvcmRlci4gQXZhaWxhYmxlOgovLyAgICAgICAgICAgICAgICAgbW9kZWwgICAgbW9kZWwgZGlzcGxheSBuYW1lICh3aXRoIMK3ZWZmb3J0IGFwcGVuZGVkIHdoZW4gImVmZm9ydCIgaXMgb24pCi8vICAgICAgICAgICAgICAgICBlZmZvcnQgICByZWFzb25pbmcgZWZmb3J0IGxldmVsIChsb3cvbWVkaXVtL2hpZ2gveGhpZ2gvbWF4KTsgYXR0YWNoZXMgdG8gbW9kZWwKLy8gICAgICAgICAgICAgICAgIDVoICAgICAgIDUtaG91ciBxdW90YSByZW1haW5pbmcgKyByZXNldCBjb3VudGRvd24KLy8gICAgICAgICAgICAgICAgIHdlZWsgICAgIHdlZWtseSBxdW90YSByZW1haW5pbmcgKyByZXNldCBjb3VudGRvd24KLy8gICAgICAgICAgICAgICAgIGFjY291bnQgIGFjY291bnQgbmFtZSAodGhlIHBhcnQgYmVmb3JlIEAgaW4geW91ciBDbGF1ZGUgbG9naW4gZW1haWwpCi8vICAgICAgICAgICAgICAgICBlbWFpbCAgICBmdWxsIGFjY291bnQgZW1haWwKLy8gICAgICAgICAgICAgICBEZWZhdWx0IHdoZW4gb21pdHRlZDogbW9kZWwsZWZmb3J0LDVoLHdlZWsKLy8gICAgICAgICAgICAgICBVc2UgImFsbCIgZm9yIG1vZGVsLGVmZm9ydCw1aCx3ZWVrLGFjY291bnQKLy8KLy8gRW52IHZhcnM6Ci8vICAgQ0xBVURFX1NMX0xBTkc9emggICAgICAgICAgIHNhbWUgYXMgdGhlICJ6aCIgYXJndW1lbnQKLy8gICBDTEFVREVfU0xfU0VHTUVOVFM9Li4uICAgICAgc2FtZSBhcyB0aGUgPHNlZ21lbnRzPiBhcmd1bWVudAovLyAgIENMQVVERV9TTF9BQ0NPVU5UPXlvdUB4LmNvbSBwZXItd2luZG93IGFjY291bnQgbGFiZWwgZm9yIHRoZSBhY2NvdW50L2VtYWlsCi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNlZ21lbnQgKHNldCBiZWZvcmUgbGF1bmNoaW5nIGNsYXVkZSkuIE5lZWRlZCB3aGVuCi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNldmVyYWwgd2luZG93cyBhcmUgbG9nZ2VkIGludG8gZGlmZmVyZW50IGFjY291bnRzLAovLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBiZWNhdXNlIH4vLmNsYXVkZS5qc29uIG9ubHkgc3RvcmVzIHRoZSBsYXN0IGxvZ2luLgpjb25zdCBhcmdzID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpOwpjb25zdCBaSCA9IGFyZ3MuaW5jbHVkZXMoInpoIikgfHwgcHJvY2Vzcy5lbnYuQ0xBVURFX1NMX0xBTkcgPT09ICJ6aCI7CmNvbnN0IERFTU8gPSBhcmdzLmluY2x1ZGVzKCJkZW1vIik7CmNvbnN0IHNlZ0FyZyA9CiAgYXJncy5maW5kKChhKSA9PiBhICE9PSAiemgiICYmIGEgIT09ICJkZW1vIikgfHwgcHJvY2Vzcy5lbnYuQ0xBVURFX1NMX1NFR01FTlRTIHx8ICIiOwpjb25zdCBBTEwgPSAibW9kZWwsZWZmb3J0LDVoLHdlZWssYWNjb3VudCI7CmNvbnN0IHNlZ3MgPSAoc2VnQXJnID09PSAiYWxsIiA/IEFMTCA6IHNlZ0FyZyB8fCAibW9kZWwsZWZmb3J0LDVoLHdlZWsiKQogIC5zcGxpdCgiLCIpCiAgLm1hcCgocykgPT4gcy50cmltKCkpCiAgLmZpbHRlcihCb29sZWFuKTsKY29uc3QgaGFzID0gKHMpID0+IHNlZ3MuaW5jbHVkZXMocyk7CgppbXBvcnQgeyByZWFkRmlsZVN5bmMgfSBmcm9tICJub2RlOmZzIjsKaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gIm5vZGU6b3MiOwppbXBvcnQgeyBqb2luIH0gZnJvbSAibm9kZTpwYXRoIjsKCmNvbnN0IFQgPSBaSAogID8gewogICAgICB3YWl0OiAi6aGN5bqm6LOH6KiK5b6F6aaW5qyh6KuL5rGC5b6M6aGv56S6IiwKICAgICAgd2VlazogIumAsSIsCiAgICAgIG5vbmU6IChsYWJlbCkgPT4gYCR7bGFiZWx9IOKAlGAsCiAgICAgIHNlZzogKGxhYmVsLCByLCBjKSA9PiBgJHtsYWJlbH0g5YmpICR7cn0lJHtjID8gYCAo6YeN572uICR7Y30pYCA6ICIifWAsCiAgICAgIHNvb246ICLljbPlsIfph43nva4iLAogICAgfQogIDogewogICAgICB3YWl0OiAidXNhZ2Ugc2hvd24gYWZ0ZXIgZmlyc3QgcmVxdWVzdCIsCiAgICAgIHdlZWs6ICJ3ZWVrIiwKICAgICAgbm9uZTogKGxhYmVsKSA9PiBgJHtsYWJlbH0g4oCUYCwKICAgICAgc2VnOiAobGFiZWwsIHIsIGMpID0+IGAke2xhYmVsfSAke3J9JSBsZWZ0JHtjID8gYCAocmVzZXRzICR7Y30pYCA6ICIifWAsCiAgICAgIHNvb246ICJyZXNldHRpbmciLAogICAgfTsKCmFzeW5jIGZ1bmN0aW9uIHJlYWRTdGRpbigpIHsKICBjb25zdCBjaHVua3MgPSBbXTsKICBmb3IgYXdhaXQgKGNvbnN0IGMgb2YgcHJvY2Vzcy5zdGRpbikgY2h1bmtzLnB1c2goYyk7CiAgcmV0dXJuIEJ1ZmZlci5jb25jYXQoY2h1bmtzKS50b1N0cmluZygidXRmOCIpOwp9CgpmdW5jdGlvbiBjb3VudGRvd24ocmVzZXRzQXQpIHsKICBpZiAoIXJlc2V0c0F0KSByZXR1cm4gIiI7CiAgY29uc3Qgc2VjcyA9IHJlc2V0c0F0IC0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCk7CiAgaWYgKHNlY3MgPD0gMCkgcmV0dXJuIFQuc29vbjsKICBjb25zdCBkID0gTWF0aC5mbG9vcihzZWNzIC8gODY0MDApOwogIGNvbnN0IGggPSBNYXRoLmZsb29yKChzZWNzICUgODY0MDApIC8gMzYwMCk7CiAgY29uc3QgbSA9IE1hdGguZmxvb3IoKHNlY3MgJSAzNjAwKSAvIDYwKTsKICBpZiAoZCA+IDApIHJldHVybiBgJHtkfWQke2h9aGA7CiAgaWYgKGggPiAwKSByZXR1cm4gYCR7aH1oJHttfW1gOwogIHJldHVybiBgJHttfW1gOwp9CgpmdW5jdGlvbiBzZWcobGFiZWwsIHdpbikgewogIGlmICghd2luIHx8IHdpbi51c2VkX3BlcmNlbnRhZ2UgPT0gbnVsbCkgcmV0dXJuIFQubm9uZShsYWJlbCk7CiAgY29uc3QgcmVtYWluID0gTWF0aC5tYXgoMCwgMTAwIC0gd2luLnVzZWRfcGVyY2VudGFnZSkudG9GaXhlZCgwKTsKICByZXR1cm4gVC5zZWcobGFiZWwsIHJlbWFpbiwgY291bnRkb3duKHdpbi5yZXNldHNfYXQpKTsKfQoKLy8gQWNjb3VudCBlbWFpbCBpcyBOT1QgaW4gdGhlIHN0YXR1cyBsaW5lIEpTT04sIGFuZCB+Ly5jbGF1ZGUuanNvbiBob2xkcyBvbmx5IE9ORQovLyBhY2NvdW50ICh0aGUgbGFzdCBsb2dpbikg4oCUIHNvIHdpdGggbXVsdGlwbGUgd2luZG93cyBvbiBkaWZmZXJlbnQgYWNjb3VudHMgaXQKLy8gY2FuJ3QgdGVsbCB0aGVtIGFwYXJ0LiBSZXNvbHV0aW9uIG9yZGVyOgovLyAgIDEuIENMQVVERV9TTF9BQ0NPVU5UIGVudiDigJQgZXhwbGljaXQgcGVyLXdpbmRvdyBsYWJlbCAoc2V0IGl0IGJlZm9yZSBsYXVuY2hpbmcKLy8gICAgICBjbGF1ZGUgaW4gdGhhdCB3aW5kb3cpOyBhbHdheXMgY29ycmVjdCwgYWx3YXlzIHdpbnMuCi8vICAgMi4gLmNsYXVkZS5qc29uIHVuZGVyIENMQVVERV9DT05GSUdfRElSICh3aGVuIGVhY2ggYWNjb3VudCB1c2VzIGl0cyBvd24gY29uZmlnCi8vICAgICAgZGlyKSwgZWxzZSB+Ly5jbGF1ZGUuanNvbiBhcyBhIGJlc3QtZWZmb3J0IGZhbGxiYWNrLgpmdW5jdGlvbiBhY2NvdW50KGZ1bGwpIHsKICBjb25zdCBvdmVycmlkZSA9IHByb2Nlc3MuZW52LkNMQVVERV9TTF9BQ0NPVU5UOwogIGlmIChvdmVycmlkZSkgcmV0dXJuIGZ1bGwgPyBvdmVycmlkZSA6IG92ZXJyaWRlLnNwbGl0KCJAIilbMF07CiAgdHJ5IHsKICAgIGNvbnN0IGRpciA9IHByb2Nlc3MuZW52LkNMQVVERV9DT05GSUdfRElSIHx8IGhvbWVkaXIoKTsKICAgIGNvbnN0IGogPSBKU09OLnBhcnNlKAogICAgICByZWFkRmlsZVN5bmMoam9pbihkaXIsICIuY2xhdWRlLmpzb24iKSwgInV0ZjgiKS5yZXBsYWNlKC9e77u/LywgIiIpCiAgICApOwogICAgY29uc3QgZW1haWwgPSBqPy5vYXV0aEFjY291bnQ/LmVtYWlsQWRkcmVzczsKICAgIGlmICghZW1haWwpIHJldHVybiAiIjsKICAgIHJldHVybiBmdWxsID8gZW1haWwgOiBlbWFpbC5zcGxpdCgiQCIpWzBdOwogIH0gY2F0Y2ggewogICAgcmV0dXJuICIiOwogIH0KfQoKY29uc3QgREVNT19EQVRBID0gewogIG1vZGVsOiB7IGRpc3BsYXlfbmFtZTogIk9wdXMgNC44IiB9LAogIGVmZm9ydDogeyBsZXZlbDogImhpZ2giIH0sCiAgcmF0ZV9saW1pdHM6IHsKICAgIGZpdmVfaG91cjogewogICAgICB1c2VkX3BlcmNlbnRhZ2U6IDEzLAogICAgICByZXNldHNfYXQ6IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgMyAqIDM2MDAgKyAxMiAqIDYwLAogICAgfSwKICAgIHNldmVuX2RheTogewogICAgICB1c2VkX3BlcmNlbnRhZ2U6IDM4LAogICAgICByZXNldHNfYXQ6IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgNCAqIDg2NDAwICsgNiAqIDM2MDAsCiAgICB9LAogIH0sCn07Cgp0cnkgewogIGxldCBpbnB1dDsKICBpZiAoREVNTykgewogICAgaW5wdXQgPSBERU1PX0RBVEE7CiAgfSBlbHNlIHsKICAgIGNvbnN0IHJhdyA9ICgoYXdhaXQgcmVhZFN0ZGluKCkpIHx8ICJ7fSIpLnJlcGxhY2UoL17vu78vLCAiIikudHJpbSgpIHx8ICJ7fSI7CiAgICBpbnB1dCA9IEpTT04ucGFyc2UocmF3KTsKICB9CgogIGNvbnN0IG1vZGVsID0gaW5wdXQ/Lm1vZGVsPy5kaXNwbGF5X25hbWUgfHwgIkNsYXVkZSI7CiAgY29uc3QgZWZmb3J0ID0gaW5wdXQ/LmVmZm9ydD8ubGV2ZWw7CiAgY29uc3QgcGFydHMgPSBbXTsKCiAgaWYgKGhhcygibW9kZWwiKSkgewogICAgcGFydHMucHVzaChoYXMoImVmZm9ydCIpICYmIGVmZm9ydCA/IGAke21vZGVsfcK3JHtlZmZvcnR9YCA6IG1vZGVsKTsKICB9IGVsc2UgaWYgKGhhcygiZWZmb3J0IikgJiYgZWZmb3J0KSB7CiAgICBwYXJ0cy5wdXNoKGVmZm9ydCk7CiAgfQoKICBjb25zdCBybCA9IGlucHV0LnJhdGVfbGltaXRzOwogIGlmIChoYXMoIjVoIikgfHwgaGFzKCJ3ZWVrIikpIHsKICAgIGlmICghcmwpIHsKICAgICAgcGFydHMucHVzaChULndhaXQpOwogICAgfSBlbHNlIHsKICAgICAgaWYgKGhhcygiNWgiKSkgcGFydHMucHVzaChzZWcoIjVoIiwgcmwuZml2ZV9ob3VyKSk7CiAgICAgIGlmIChoYXMoIndlZWsiKSkgcGFydHMucHVzaChzZWcoVC53ZWVrLCBybC5zZXZlbl9kYXkpKTsKICAgIH0KICB9CgogIGlmIChoYXMoImFjY291bnQiKSB8fCBoYXMoImVtYWlsIikpIHsKICAgIGxldCBhID0gYWNjb3VudChoYXMoImVtYWlsIikpOwogICAgaWYgKCFhICYmIERFTU8pIGEgPSBoYXMoImVtYWlsIikgPyAieW91QGV4YW1wbGUuY29tIiA6ICJ5b3UiOwogICAgaWYgKGEpIHBhcnRzLnB1c2goYSk7CiAgfQoKICBwcm9jZXNzLnN0ZG91dC53cml0ZShwYXJ0cy5qb2luKCIgfCAiKSB8fCBtb2RlbCk7Cn0gY2F0Y2ggKGUpIHsKICBwcm9jZXNzLnN0ZG91dC53cml0ZShgc3RhdHVzbGluZSBlcnI6ICR7U3RyaW5nKGUubWVzc2FnZSkuc2xpY2UoMCwgNDApfWApOwp9Cg==";

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
