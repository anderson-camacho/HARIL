#!/bin/sh
# One-command HARIL installer for macOS and Linux:
#   ./install.sh [--no-runtime] [--root <dir>] [--dry-run] [--help]
# It only checks that node is on PATH and runs scripts/install.mjs, which holds every step.
# PATH and shell profiles are never edited.
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "install: node was not found on PATH." >&2
  echo "install: HARIL needs Node 24 (^24.21.0 || >=26.8.0). Get it from https://nodejs.org/en/download" >&2
  echo "install: or a version manager such as fnm or nvm, then run ./install.sh again." >&2
  exit 2
fi

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/scripts/install.mjs" "$@"
