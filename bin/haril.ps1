# HARIL shim for PowerShell (M1-D10): runs the built CLI without editing PATH.
# Usage: .\bin\haril.ps1 <command> [args]   (run "npm run build" first)
$entry = "$PSScriptRoot\..\apps\haril\dist\haril.mjs"
if (-not (Test-Path -LiteralPath $entry)) {
  [Console]::Error.WriteLine('haril: apps\haril\dist\haril.mjs not found. Run "npm run build" first.')
  exit 2
}
& node $entry @args
exit $LASTEXITCODE
