# One-command HARIL installer for Windows (Windows PowerShell 5.1 and PowerShell 7):
#   .\install.ps1 [--no-runtime] [--root <dir>] [--dry-run] [--help]
# It only checks that node is on PATH and runs scripts\install.mjs, which holds every step.
# PATH and the registry are never edited. Keep this file ASCII: PowerShell 5.1 reads it as ANSI.

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine('install: node was not found on PATH.')
  [Console]::Error.WriteLine('install: HARIL needs Node 24 (^24.21.0 || >=26.8.0). Get it from https://nodejs.org/en/download')
  [Console]::Error.WriteLine('install: or a version manager such as fnm or nvm, then run .\install.ps1 again.')
  exit 2
}

# Two Join-Path calls: PowerShell 5.1 takes one child path, and pwsh on Linux keeps a backslash literally.
& node (Join-Path (Join-Path $PSScriptRoot 'scripts') 'install.mjs') @args
exit $LASTEXITCODE
