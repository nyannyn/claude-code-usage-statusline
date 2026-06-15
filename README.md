# claude-code-usage-statusline

在 Claude Code 狀態列即時顯示訂閱方案的 **5 小時 / 7 天剩餘額度與重置倒數**,零相依、單一檔、跨平台。

```
Opus 4.8 | 5h 剩 87% (重置 3h12m) | 週 剩 62% (重置 4d6h)
```

額度資料直接取自 Claude Code 餵給 statusLine 的 stdin JSON(`rate_limits`),**不呼叫任何 API、不需金鑰**。

---

## 一鍵安裝

前置需求:已安裝 **Node.js**(`node --version` 能跑即可)。

### macOS / Linux / WSL

```bash
curl -fsSL https://raw.githubusercontent.com/<YOUR_GH>/claude-code-usage-statusline/main/install.mjs | node -
```

### Windows(PowerShell)

PowerShell 的管線會幫文字加 BOM 害 `node -` 解析失敗,所以**先下載再執行**:

```powershell
irm https://raw.githubusercontent.com/<YOUR_GH>/claude-code-usage-statusline/main/install.mjs -OutFile "$env:TEMP\install.mjs"; node "$env:TEMP\install.mjs"
```

### 或:下載整個 repo 後本機執行(任何 OS)

```bash
node install.mjs
```

安裝完**完全重啟 Claude Code**,送出第一則訊息收到回應後即顯示。

---

## 它做了什麼

1. 把狀態列腳本寫到該使用者的 `~/.claude/statusline-limits.mjs`
2. 偵測目前 node 的完整路徑(`process.execPath`)與家目錄,自動組出機器專屬命令
3. 把 `statusLine` 合併進 `~/.claude/settings.json`(解析後只加這個鍵,**保留既有設定**)

整個安裝器是**單一 `install.mjs`**,狀態列腳本以 base64 內嵌其中,所以可直接 `curl | node -`。

---

## 注意事項 / 踩坑

- **額度欄位的出現條件**:`rate_limits` 僅 **Claude Pro/Max 訂閱**、且**本 session 收到第一個回應後**才會由 Claude Code 提供;剛開啟時顯示「額度資訊待首次請求後顯示」屬正常。
- **為何不用 bare `node` / 不直接複製 settings.json**:Claude Code 在 **Windows** 透過類 bash 的 shell 執行 statusLine 命令,反斜線會被當跳脫字元吃掉(`C:\...node.exe` → 找不到 node → 狀態列全空),PATH 也可能不含 node(如 nvm-for-windows)。安裝器用「**當前 node 絕對路徑 + 正斜線 + 雙引號**」一次解決,並避免硬編別人不存在的路徑。
- **BOM**:stdin JSON 偶爾帶 BOM,腳本已在 `JSON.parse` 前 strip 掉。
- 設定改動需**重啟** CLI 才會載入。

## 移除

把 `~/.claude/settings.json` 裡的 `statusLine` 鍵刪掉即可(並可刪 `~/.claude/statusline-limits.mjs`)。

---

## 開發:修改狀態列腳本後

腳本以 base64 內嵌在 `install.mjs` 的 `SCRIPT_B64`。改完原始碼後重新編碼回填:

```bash
node -e "process.stdout.write(require('fs').readFileSync('statusline-limits.mjs').toString('base64'))"
```

(若你保留了獨立的 `statusline-limits.mjs` 原始檔)

---

## 類似專案(參考)

社群已有多個 Claude Code 狀態列方案,各有取捨(進度條、context、成本、peak/off-peak 等),可依需求挑選:

- [andrewii23/claude-statusline](https://github.com/andrewii23/claude-statusline) — 極簡,含 usage bars 與 rate limit 追蹤
- [ohugonnot/claude-code-statusline](https://github.com/ohugonnot/claude-code-statusline) — session/weekly 配額、重置倒數、context、git branch
- [haunchen/claude-code-statusline](https://github.com/haunchen/claude-code-statusline) — peak/off-peak 感知
- [hell0github/claude-statusline](https://github.com/hell0github/claude-statusline) — 輕量,context/cost/重置
- [jtbr 的完整 gist](https://gist.github.com/jtbr/4f99671d1cee06b44106456958caba8b) — 色彩進度條 + pacing,含各種 gotcha 說明
- [官方文件:Customize your status line](https://code.claude.com/docs/en/statusline)

本專案的取向:**最小、零相依、單檔可 `curl | node`、專治跨 OS(尤其 Windows shell)安裝坑**。

## License

MIT
