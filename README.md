# Claude Code Usage Statusline

**English** · [繁體中文](README.zh-TW.md)

A status line for [Claude Code](https://claude.com/claude-code) that shows your subscription's **5-hour and weekly usage** with reset countdowns — at a glance, on every prompt.

```
Opus 4.8 | 5h 87% left (resets 3h12m) | week 62% left (resets 4d6h)
```

Usage data is read straight from the JSON that Claude Code passes to the status line (`rate_limits`). **No API calls, no tokens, no keys.**

## Features

- **Native on Windows** — runs in CMD/PowerShell as well as macOS, Linux, and WSL. No bash or `jq` required.
- **Zero dependencies** — pure Node.js, nothing to `npm install`.
- **Single file** — the whole installer is one `install.mjs`, so it works as a `curl | node` one-liner.
- **Non-destructive install** — merges into `~/.claude/settings.json`, preserving your existing settings.

## Requirements

[Node.js](https://nodejs.org) (any recent version — verify with `node --version`).

## Installation

**macOS / Linux / WSL**

```bash
curl -fsSL https://raw.githubusercontent.com/nyannyn/claude-code-usage-statusline/main/install.mjs | node -
```

**Windows (PowerShell)**

PowerShell adds a BOM when piping text, which breaks `node -`, so download first, then run:

```powershell
irm https://raw.githubusercontent.com/nyannyn/claude-code-usage-statusline/main/install.mjs -OutFile "$env:TEMP\install.mjs"; node "$env:TEMP\install.mjs"
```

**Any OS (from a local clone)**

```bash
node install.mjs
```

For a Traditional Chinese status line, append `zh` to any command above (e.g. `node install.mjs zh`).

Then **fully restart Claude Code**. The usage figures appear after the first response in a session.

## How it works

The installer:

1. Writes the status line script to `~/.claude/statusline-limits.mjs`.
2. Detects the current Node.js path (`process.execPath`) and home directory, then builds a machine-specific command.
3. Merges a `statusLine` entry into `~/.claude/settings.json`, leaving your other settings untouched.

The status line script itself is embedded in `install.mjs` as base64, which is what makes the `curl | node` one-liner possible.

## Notes

- **When usage shows up:** `rate_limits` is provided only on **Claude Pro/Max** plans, and only **after the first response** in a session. Before that, the line reads `額度資訊待首次請求後顯示` ("usage shown after first request") — this is expected.
- **Why a full Node path with forward slashes:** on Windows, Claude Code launches the status line command through a bash-like shell. Backslashes get swallowed and `node` may not be on that shell's `PATH` (e.g. with nvm). The installer sidesteps both by writing an absolute, forward-slashed, quoted command.

## Uninstall

Remove the `statusLine` key from `~/.claude/settings.json` (and optionally delete `~/.claude/statusline-limits.mjs`).

## Development

The status line script is embedded in `install.mjs` as the `SCRIPT_B64` constant. After editing the source, re-encode it:

```bash
node -e "process.stdout.write(require('fs').readFileSync('statusline-limits.mjs').toString('base64'))"
```

## Similar projects

- [hell0github/claude-statusline](https://github.com/hell0github/claude-statusline) — lightweight, tracks context/cost/reset (Bash; requires WSL or Git Bash on Windows)
- [Customize your status line — Claude Code Docs](https://code.claude.com/docs/en/statusline)

## License

[MIT](LICENSE)
