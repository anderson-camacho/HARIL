@echo off
rem One-command HARIL installer for Windows: install.cmd [--no-runtime] [--root <dir>] [--dry-run] [--help]
rem It runs install.ps1 with the execution policy bypassed for this process only, so no policy blocks it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
