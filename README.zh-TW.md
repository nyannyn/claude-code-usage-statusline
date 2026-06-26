# Claude Code 額度狀態列

[English](README.md) · **繁體中文**

一個 [Claude Code](https://claude.com/claude-code) 狀態列,在每次輸入時一眼看見訂閱方案的 **5 小時與每週額度**及重置倒數。

```
Opus 4.8 | 5h 剩 87% (重置 3h12m) | 週 剩 62% (重置 4d6h)
```

額度資料直接讀取 Claude Code 餵給狀態列的 JSON(`rate_limits`)。**不呼叫 API、不需金鑰。**

## 特色

- **Windows 原生可用** — CMD/PowerShell 與 macOS、Linux、WSL 皆可,毋須 bash 或 `jq`。
- **零相依** — 純 Node.js,沒有要 `npm install` 的東西。
- **單一檔** — 整個安裝器就是一個 `install.mjs`,可直接 `curl | node` 一鍵安裝。
- **不破壞既有設定** — 合併進 `~/.claude/settings.json`,保留你原本的設定。

## 三步驟安裝

**1.** 先確認裝了 [Node.js](https://nodejs.org)(在終端機輸入 `node --version`,有跑出版本號就 OK)。

**2.** 複製對應你系統的那一行,貼到終端機按 Enter(這裡是**中文版**指令):

- **macOS / Linux / WSL** — 貼進 Terminal:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/nyannyn/claude-code-usage-statusline/main/install.mjs | node - zh
  ```

- **Windows** — 貼進 PowerShell:

  ```powershell
  $env:CLAUDE_SL_LANG="zh"; irm https://raw.githubusercontent.com/nyannyn/claude-code-usage-statusline/main/install.ps1 | iex
  ```

**3.** 完全關閉 Claude Code 再重新打開。完成 — 送出第一則訊息後就會顯示額度。

> 想要英文狀態列?用 [English README](README.md) 裡的指令。

## 運作方式

安裝器會:

1. 將狀態列腳本寫入 `~/.claude/statusline-limits.mjs`。
2. 偵測目前 Node.js 路徑(`process.execPath`)與家目錄,組出機器專屬命令。
3. 將 `statusLine` 設定合併進 `~/.claude/settings.json`,不動其他設定。

狀態列腳本以 base64 內嵌於 `install.mjs`,這正是 `curl | node` 一鍵安裝得以成立的原因。

## 注意事項

- **額度何時出現:** `rate_limits` 僅 **Claude Pro/Max** 方案、且 session **收到第一個回應後**才會提供。在那之前狀態列會顯示「額度資訊待首次請求後顯示」,屬正常現象。
- **為何用 node 完整路徑 + 正斜線:** Windows 上 Claude Code 透過類 bash 的 shell 啟動狀態列命令,反斜線會被吃掉,且該 shell 的 `PATH` 可能不含 node(如使用 nvm)。安裝器以絕對路徑、正斜線、加雙引號的命令一次避開這兩個問題。

## 疑難排解

**狀態列空白 / 完全沒顯示** — 即使安裝顯示成功也一樣。

最常見的原因是**有另一個 `statusLine` 設定蓋過了安裝器寫入的那個。** Claude Code 會合併多個設定檔,愈「具體」的優先序愈高:

```
~/.claude/settings.json               ← 使用者層(安裝器寫這裡)
<專案>/.claude/settings.json          ← 專案層,共用      (蓋過使用者層)
<專案>/.claude/settings.local.json    ← 專案層,本機      (蓋過一切)
```

所以只要你開的某個專案資料夾,它的 `.claude/settings.json` 或 `.claude/settings.local.json` 裡有 `statusLine`,就會蓋掉使用者層的命令——安裝器寫的那筆是對的,但永遠輪不到它生效。

**跨作業系統時最容易中招。** 在 WSL/Linux 下產生的命令長這樣:

```json
"statusLine": {
  "type": "command",
  "command": "/home/<user>/.nvm/versions/node/v24.14.0/bin/node /home/<user>/.claude/statusline-limits.mjs"
}
```

這個 Linux 絕對路徑在 Windows 原生環境並不存在,於是命令靜默失敗、狀態列保持空白——重開 shell 也沒用,因為壞掉的那筆設定還在。

**修法:** 打開該專案的 `.claude/settings.json` 與 `.claude/settings.local.json`,把 `statusLine` 區塊刪掉(讓使用者層那筆重新生效),**或**在你實際使用的環境重跑一次安裝器讓路徑對上。想確認目前生效的是哪一條,就從最具體的設定檔由下往上檢查各檔的 `statusLine` 值。

## 移除

刪除 `~/.claude/settings.json` 中的 `statusLine` 鍵即可(並可一併刪除 `~/.claude/statusline-limits.mjs`)。

## 開發

狀態列腳本以 `install.mjs` 中的 `SCRIPT_B64` 常數內嵌。修改原始碼後重新編碼:

```bash
node -e "process.stdout.write(require('fs').readFileSync('statusline-limits.mjs').toString('base64'))"
```

## 類似專案

- [hell0github/claude-statusline](https://github.com/hell0github/claude-statusline) — 輕量,追蹤 context/cost/重置(Bash 撰寫;Windows 需 WSL 或 Git Bash)
- [自訂狀態列 — Claude Code 官方文件](https://code.claude.com/docs/en/statusline)

## 授權

[MIT](LICENSE)
