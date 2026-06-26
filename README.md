# Claude Code Usage Statusline

**English** · [繁體中文](README.zh-TW.md)

A status line for [Claude Code](https://claude.com/claude-code) that shows the current model, its **reasoning effort level**, and your subscription's **5-hour and weekly usage** with reset countdowns — at a glance, on every prompt.

```
Opus 4.8·high | 5h 87% left (resets 3h12m) | week 62% left (resets 4d6h)
```

The `·high` after the model name is the live reasoning effort (`low` / `medium` / `high` / `xhigh` / `max`) — handy because higher effort burns through your quota faster. It is omitted for models that don't support the effort parameter.

Usage data is read straight from the JSON that Claude Code passes to the status line (`rate_limits` and `effort`). **No API calls, no tokens, no keys.**

## Features

- **Native on Windows** — runs in CMD/PowerShell as well as macOS, Linux, and WSL. No bash or `jq` required.
- **Zero dependencies** — pure Node.js, nothing to `npm install`.
- **Single file** — the whole installer is one `install.mjs`, so it works as a `curl | node` one-liner.
- **Non-destructive install** — merges into `~/.claude/settings.json`, preserving your existing settings.

## Install in 3 steps

**1.** Make sure [Node.js](https://nodejs.org) is installed (run `node --version` — if you see a version number, you're set).

**2.** Copy the one line for your system and paste it into your terminal, then press Enter:

- **macOS / Linux / WSL** — paste into Terminal:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/nyannyn/claude-code-usage-statusline/main/install.mjs | node -
  ```

- **Windows** — paste into PowerShell:

  ```powershell
  irm https://raw.githubusercontent.com/nyannyn/claude-code-usage-statusline/main/install.ps1 | iex
  ```

**3.** Quit Claude Code completely and reopen it. Done — usage appears after your first message.

> Prefer a Traditional Chinese status line? Use the commands in the [繁體中文 README](README.zh-TW.md).

## How it works

The installer:

1. Writes the status line script to `~/.claude/statusline-limits.mjs`.
2. Detects the current Node.js path (`process.execPath`) and home directory, then builds a machine-specific command.
3. Merges a `statusLine` entry into `~/.claude/settings.json`, leaving your other settings untouched.

The status line script itself is embedded in `install.mjs` as base64, which is what makes the `curl | node` one-liner possible.

## Notes

- **When usage shows up:** `rate_limits` is provided only on **Claude Pro/Max** plans, and only **after the first response** in a session. Before that, the line reads `額度資訊待首次請求後顯示` ("usage shown after first request") — this is expected.
- **Why a full Node path with forward slashes:** on Windows, Claude Code launches the status line command through a bash-like shell. Backslashes get swallowed and `node` may not be on that shell's `PATH` (e.g. with nvm). The installer sidesteps both by writing an absolute, forward-slashed, quoted command.

## Troubleshooting

**The status line is blank / nothing shows up** — even though the install said it succeeded.

The usual cause is **another `statusLine` entry overriding the one the installer wrote.** Claude Code merges settings from several files, and the most specific wins:

```
~/.claude/settings.json            ← user level (the installer writes here)
<project>/.claude/settings.json    ← project, shared        (overrides user)
<project>/.claude/settings.local.json ← project, local      (overrides everything)
```

So if any project folder you open has a `statusLine` in its `.claude/settings.json` or `.claude/settings.local.json`, that one shadows the user-level command — the installer's entry is correct but never gets used.

This bites hardest **across operating systems.** A command generated under WSL/Linux looks like:

```json
"statusLine": {
  "type": "command",
  "command": "/home/<user>/.nvm/versions/node/v24.14.0/bin/node /home/<user>/.claude/statusline-limits.mjs"
}
```

That absolute Linux path does not exist on native Windows, so the command fails silently and the status line stays blank — restarting the shell never helps, because the broken entry is still there.

**Fix:** open the project's `.claude/settings.json` and `.claude/settings.local.json` and remove the `statusLine` block (so the user-level one applies again), **or** re-run the installer in the environment you actually use so the path matches. To confirm which command is live, check the `statusLine` value in each settings file from the most specific down.

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
