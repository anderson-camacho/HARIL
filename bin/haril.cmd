@echo off
rem HARIL shim for Windows (M1-D10): runs the built CLI without editing PATH.
rem Usage: bin\haril.cmd <command> [args]   (run "npm run build" first)
if not exist "%~dp0..\apps\haril\dist\haril.mjs" (
  echo haril: apps\haril\dist\haril.mjs not found. Run "npm run build" first. 1>&2
  exit /b 2
)
@node "%~dp0..\apps\haril\dist\haril.mjs" %*
exit /b %ERRORLEVEL%
