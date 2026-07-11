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
- **Pick your segments** — choose which parts to show (model, effort, quota, account) and preview before installing. See [Customize segments](#customize-segments).
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

## Customize segments

You choose which parts appear, and in what order, by passing a comma-separated list:

| segment   | shows                                                                  |
| --------- | --------------------------------------------------------------------- |
| `model`   | model display name (e.g. `Opus 4.8`)                                  |
| `effort`  | reasoning effort level — appended to the model as `·high`. Higher effort burns quota faster |
| `5h`      | 5-hour quota remaining + reset countdown                              |
| `week`    | weekly quota remaining + reset countdown                              |
| `account` | account name (the part before `@` in your Claude login email)         |
| `email`   | full account email                                                   |

Default is `model,effort,5h,week`. `all` means `model,effort,5h,week,account`.
`account` / `email` are read from your existing `~/.claude.json` — nothing is sent anywhere.

> **Heads-up on `account` / `email` with multiple windows.** The status line JSON
> contains no account field, and `~/.claude.json` stores only the **last login**, so
> if you run several windows on different accounts they'll all show that one account.
> For a correct per-window label, set `CLAUDE_SL_ACCOUNT` before launching Claude Code
> in that window (e.g. `CLAUDE_SL_ACCOUNT=work@acme.com claude`), or give each account
> its own `CLAUDE_CONFIG_DIR`. The script checks `CLAUDE_SL_ACCOUNT` first, then
> `.claude.json` under `CLAUDE_CONFIG_DIR`, then `~/.claude.json`.

**Preview before you install.** The `demo` flag renders a sample line from fake data, no Claude Code needed:

```bash
node statusline-limits.mjs zh all demo
# Opus 4.8·high | 5h 剩 87% (重置 3h12m) | 週 剩 62% (重置 4d6h) | your-name

node statusline-limits.mjs model,effort,5h,week,email demo
# Opus 4.8·high | 5h 87% left (resets 3h12m) | week 62% left (resets 4d6h) | you@example.com
```

Install with your chosen segments by appending them:

```bash
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/nyannyn/claude-code-usage-statusline/main/install.mjs | node - zh all
```

```powershell
# Windows
$env:CLAUDE_SL_LANG="zh"; $env:CLAUDE_SL_SEGMENTS="all"; irm https://raw.githubusercontent.com/nyannyn/claude-code-usage-statusline/main/install.ps1 | iex
```

> **Using an AI agent to set this up?** Point it at [`AGENTS.md`](AGENTS.md) — it tells the agent to offer the segment menu, render a preview, and install your selection.

## Multi-account dashboard

Running several Claude subscriptions (e.g. one `CLAUDE_CONFIG_DIR` per account)? The dashboard shows **every account's 5-hour and weekly quota side by side** in your browser — one card per account, merged by email across machines, in a single flat list, with usage bars, reset countdowns, email/plan/model, and data freshness. If the same account is also logged in on another machine (or WSL), that copy doesn't get its own card — it shows up as an "others" status line under the main card instead. Auto-refreshes every 30 seconds.

**Try it right now** (fake data, reads nothing, no install):

```bash
curl -fsSL https://raw.githubusercontent.com/nyannyn/claude-code-usage-statusline/main/dashboard.mjs | node - demo
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/nyannyn/claude-code-usage-statusline/main/dashboard.mjs | node - demo
```

### Organizing multiple accounts

Two roles, and it helps to decide which each account plays:

- **Flex slot** — the default `~/.claude` (no `CLAUDE_CONFIG_DIR` set). Disposable: `/login` swaps whoever's in it whenever you like. Good for a throwaway or short-lived account you don't want to track over time.
- **Fixed account** — its own dedicated `CLAUDE_CONFIG_DIR` (e.g. `~/.claude-work`), logged in once. Stable identity, so the dashboard can follow its quota across sessions.

Rule of thumb: give any account you want to **watch in the dashboard** a fixed config dir; leave temporary ones in the flex slot.

**Real usage in 3 steps:**

1. Give each account its own config dir and log in once per dir: `CLAUDE_CONFIG_DIR=~/.claude-b claude`
2. Install the status line (top of this README) — the installer now also drops `dashboard.mjs` into `~/.claude/` and, on Windows, puts a **"Claude Usage Dashboard" shortcut on your desktop**. On macOS/Linux it prints a ready-made `claude-usage` alias for your shell rc.
3. Launch it — double-click the shortcut, use the alias, or run the same one-liner as above without `demo` (add `--live` for idle accounts):

```bash
node ~/.claude/dashboard.mjs           # snapshots only, zero API calls
node ~/.claude/dashboard.mjs --live    # + query Anthropic for accounts with no open window
```

**Adding and removing accounts.** The dashboard discovers accounts from files, so there's nothing to register:

- **Add:** `CLAUDE_CONFIG_DIR=~/.claude-<name> claude`, then `/login`. Its card appears the first time the status line renders in that window.
- **Remove:** delete the config dir, then delete its snapshot `~/.claude-usage/<profile>.json` — otherwise the account lingers as a permanently stale (grey) card. The snapshot filename is the config dir's basename (`.claude-work.json`). To hide a card without deleting anything, use `CLAUDE_SL_IGNORE` (below), or set `CLAUDE_SL_MAX_AGE_DAYS` to drop cards you haven't used in a while.

**How it gets the data — two sources, merged per profile:**

1. **Snapshots (default, zero API calls).** Whenever the status line renders, it also drops that profile's latest `rate_limits` into `~/.claude-usage/<profile>.json`. The dashboard reads those files — nothing else. Data is as fresh as the last prompt you sent in each account's window; a card goes `stale` after 15 minutes without one. On Windows the dashboard also scans every WSL distro's `~/.claude-usage`, so native and WSL windows land on the same page.

2. **Live mode (`--live`, opt-in).** Additionally reads each profile's OAuth token from `<config-dir>/.credentials.json` and queries Anthropic's usage endpoint directly — fresh numbers even for accounts with no open window. Tokens never leave your machine (the only request goes to `api.anthropic.com`), but note this endpoint is undocumented and rate-limits aggressively, so results are cached for 60 seconds. Expired tokens are reported per card; opening Claude Code once on that account refreshes them.

```bash
node dashboard.mjs zh --live          # snapshots + live polling
node dashboard.mjs --port 8080       # custom port
node dashboard.mjs --no-open         # don't auto-launch the browser
node dashboard.mjs --takeover        # if the port is taken, ask the running instance to shut down and take over
```

**Running it as a background/startup service.** `--takeover` lets you register the dashboard as a startup item without worrying about "port already in use" — the new instance POSTs `/api/shutdown` to whichever instance is already listening, waits for it to exit, and then binds the port itself. On Windows, a simple way to get this running at login: put a shortcut in your Startup folder (`shell:startup`) that runs `wscript.exe` against a tiny `.vbs` wrapper (so no console window flashes) invoking `node dashboard.mjs --takeover --no-open`; each login (or manual re-run after an upgrade) then cleanly replaces the previous instance instead of failing to bind.

| env var | meaning |
| --- | --- |
| `CLAUDE_USAGE_DIRS` | extra snapshot dirs, `;`-separated |
| `CLAUDE_CONFIG_DIRS` | config dirs for `--live`, `;`-separated (default: every `~/.claude*` dir with a `.credentials.json`) |
| `CLAUDE_SL_SNAPSHOT=0` | stop the status line from writing snapshots |
| `CLAUDE_SL_USAGE_DIR` | where the status line writes snapshots (default `~/.claude-usage`) |
| `CLAUDE_SL_IGNORE` | profile keys to hide, `;`-separated; matches `key` (`.claude-c`) or `key\|host` |
| `CLAUDE_SL_MAX_AGE_DAYS` | hide snapshot-only cards not updated in N days (default `0` = keep forever; live cards are never aged out) |

Profiles are identified by **config dir name + host** underneath, because a Windows `.claude-b` and a WSL `.claude-b` can be different logins — but since quota belongs to the account, not the machine, entries sharing an email are merged into one card, and every other machine's copy is folded into that card's "others" list instead of getting a card of its own. Each card shows the account's email (best effort — `.claude.json` only records the last login), plan, model, usage bars with reset countdowns, and per-model weekly caps in live mode. After you `/login` a *new* account into an existing config dir, that email only refreshes once that account renders the status line at least once, so the dashboard (and status line) may briefly show the previous login's address.

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

**The status line shows up, but some segments are missing / the language is wrong** — e.g. no account, or English where you configured Traditional Chinese. Not blank, just half-right.

Same override as above, except this time the shadowing `statusLine` points at the *same script with stale arguments*. Say you later add arguments to the user-level command (e.g. `… statusline-limits.mjs zh all` to show Traditional Chinese + account), but some project's `.claude/settings.local.json` still holds the old argument-less command — that more specific entry wins, so the segments fall back to the default `model,effort,5h,week` (no account) and the language falls back to English. The command still runs, so nothing is blank; it's just missing pieces.

**Fix:** same as above — delete the leftover `statusLine` from the project's `.claude/settings.*.json` (to fall back to the user-level one), or bring its arguments back in sync with the user-level command.

## Uninstall

Remove the `statusLine` key from `~/.claude/settings.json` (and optionally delete `~/.claude/statusline-limits.mjs`).

## Development

The status line script and the dashboard are embedded in `install.mjs` as the `SCRIPT_B64` and `DASHBOARD_B64` constants. After editing either source file, re-embed both:

```bash
node -e "
const fs = require('fs');
let s = fs.readFileSync('install.mjs', 'utf8');
for (const [c, f] of [['SCRIPT_B64', 'statusline-limits.mjs'], ['DASHBOARD_B64', 'dashboard.mjs']])
  s = s.replace(new RegExp('const ' + c + ' =\\r?\\n  \"[A-Za-z0-9+/=]+\";'),
    'const ' + c + ' =\n  \"' + fs.readFileSync(f).toString('base64') + '\";');
fs.writeFileSync('install.mjs', s);
"
```

## Similar projects

- [hell0github/claude-statusline](https://github.com/hell0github/claude-statusline) — lightweight, tracks context/cost/reset (Bash; requires WSL or Git Bash on Windows)
- [Customize your status line — Claude Code Docs](https://code.claude.com/docs/en/statusline)

## License

[MIT](LICENSE)
