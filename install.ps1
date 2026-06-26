# Claude Code Usage Statusline - Windows bootstrap installer.
# Usage:
#   irm https://raw.githubusercontent.com/nyannyn/claude-code-usage-statusline/main/install.ps1 | iex
# For a Traditional Chinese status line, set the language first:
#   $env:CLAUDE_SL_LANG="zh"; irm <same url> | iex
# To pick which segments to show (model,effort,5h,week,account,email or "all"):
#   $env:CLAUDE_SL_SEGMENTS="all"; irm <same url> | iex
$ErrorActionPreference = "Stop"

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host "Node.js not found. Install it from https://nodejs.org and run this again." -ForegroundColor Red
  return
}

$src = "https://raw.githubusercontent.com/nyannyn/claude-code-usage-statusline/main/install.mjs"
$tmp = Join-Path $env:TEMP "claude-statusline-install.mjs"
Invoke-RestMethod $src -OutFile $tmp

if ($env:CLAUDE_SL_LANG -eq "zh") { & $node $tmp zh } else { & $node $tmp }
