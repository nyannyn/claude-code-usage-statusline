# Instructions for AI agents

If you are an AI coding agent (Claude Code, Cursor, etc.) helping a user set up
this status line, follow this flow so the user gets exactly the segments they
want and can **see a preview before installing**.

## 1. Offer the menu

Ask the user which segments to enable (multi-select). The order they pick is the
order shown, left to right:

| segment   | shows                                                        |
| --------- | ----------------------------------------------------------- |
| `model`   | model display name (e.g. `Opus 4.8`)                        |
| `effort`  | reasoning effort level — attaches to the model as `·high`. Higher effort burns quota faster, so it's worth watching |
| `5h`      | 5-hour quota remaining + reset countdown                    |
| `week`    | weekly quota remaining + reset countdown                    |
| `account` | account name (the part before `@` in the Claude login email) |
| `email`   | full account email                                          |

Default if the user has no preference: `model,effort,5h,week`.
`all` is shorthand for `model,effort,5h,week,account`.

Notes to relay:

- `effort` is omitted automatically for models that don't support the effort
  parameter (e.g. Haiku).
- `account` / `email` are read from `~/.claude.json` (the user's existing Claude
  login) — no extra setup, nothing is sent anywhere.
- Don't combine `account` and `email`; pick one.

## 2. Render a preview (do this before installing)

The script has a `demo` flag that renders a sample line from fake data **without
needing real Claude Code input**, so you can show the user exactly what they'll
get. Run it once per candidate segment set:

```bash
node statusline-limits.mjs zh <segments> demo      # Traditional Chinese
node statusline-limits.mjs <segments> demo         # English
```

Examples (these are the actual outputs):

```
$ node statusline-limits.mjs zh model,effort,5h,week demo
Opus 4.8·high | 5h 剩 87% (重置 3h12m) | 週 剩 62% (重置 4d6h)

$ node statusline-limits.mjs zh all demo
Opus 4.8·high | 5h 剩 87% (重置 3h12m) | 週 剩 62% (重置 4d6h) | <account-name>

$ node statusline-limits.mjs model,effort,5h,week,email demo
Opus 4.8·high | 5h 87% left (resets 3h12m) | week 62% left (resets 4d6h) | you@example.com
```

For `account` / `email`, `demo` shows the user's real account if `~/.claude.json`
exists, otherwise a placeholder. Show the rendered line and confirm the choice.

## 3. Install with the chosen segments

Bake the confirmed selection into the install command:

```bash
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/nyannyn/claude-code-usage-statusline/main/install.mjs | node - zh <segments>
```

```powershell
# Windows
$env:CLAUDE_SL_LANG="zh"; $env:CLAUDE_SL_SEGMENTS="<segments>"; irm https://raw.githubusercontent.com/nyannyn/claude-code-usage-statusline/main/install.ps1 | iex
```

The installer writes the `statusLine` command into `~/.claude/settings.json`.
Tell the user to **fully restart Claude Code** afterwards.

## 4. If the status line stays blank afterwards

A `statusLine` entry in a project's `.claude/settings.json` or
`.claude/settings.local.json` overrides the user-level one (project beats user;
`.local` beats everything). A command generated under a different OS (e.g. a WSL
`/home/.../node` path on native Windows) fails silently. Check those files first —
see the Troubleshooting section in the README.
