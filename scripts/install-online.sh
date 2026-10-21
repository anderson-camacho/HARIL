#!/bin/sh
# HARIL user installer: curl -fsSL https://raw.githubusercontent.com/anderson-camacho/HARIL/main/scripts/install-online.sh | sh
# Temporary source only, no persistent checkout; never needs sudo.
set -eu
ref="${HARIL_INSTALL_REF:-main}"
case "$ref" in
  *[!a-zA-Z0-9._/-]*|*..*) echo "Invalid HARIL_INSTALL_REF" >&2; exit 2 ;;
esac
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node 24.21+ from https://nodejs.org/en/download before continuing." >&2
  exit 2
fi
tmp="$(mktemp -d "${TMPDIR:-/tmp}/haril-install.XXXXXXXX")"
cleanup() {
  if [ "${HARIL_KEEP_SOURCE:-0}" = "1" ]; then
    echo "Temporary source kept at $tmp"
  else
    rm -rf -- "$tmp"
  fi
}
trap cleanup EXIT HUP INT TERM
source_dir=''
if command -v curl >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1; then
  if curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 180 "https://codeload.github.com/anderson-camacho/HARIL/zip/refs/heads/$ref" -o "$tmp/source.zip"; then
    if unzip -q "$tmp/source.zip" -d "$tmp"; then
      for entry in "$tmp"/HARIL-*/install.sh; do
        if [ -f "$entry" ]; then source_dir="$(dirname "$entry")"; break; fi
      done
    else
      echo "Downloaded archive is corrupt; trying Git fallback." >&2
    fi
  fi
fi
if [ -z "$source_dir" ]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "Archive download failed; install git or check GitHub access." >&2
    exit 1
  fi
  source_dir="$tmp/checkout"
  mkdir -p "$source_dir"
  git -C "$source_dir" init -q
  git -C "$source_dir" remote add origin https://github.com/anderson-camacho/HARIL.git
  ok=0
  for attempt in 1 2 3; do
    if git -c http.version=HTTP/1.1 -C "$source_dir" fetch -q --depth 1 --no-tags origin "$ref"; then
      ok=1
      break
    fi
    echo "GitHub download attempt $attempt failed; retrying." >&2
    sleep "$attempt"
  done
  if [ "$ok" -ne 1 ]; then
    echo "Unable to download HARIL after three attempts." >&2
    exit 1
  fi
  git -C "$source_dir" checkout -q --detach FETCH_HEAD
fi
sh "$source_dir/install.sh"
bin="${XDG_DATA_HOME:-$HOME/.local/share}/haril/bin"
if [ "${HARIL_NO_PATH:-0}" != "1" ]; then
  profile="$HOME/.profile"
  line='export PATH="'"$bin"':$PATH" # HARIL user installer'
  if ! grep -Fq '# HARIL user installer' "$profile" 2>/dev/null; then
    printf '\n%s\n' "$line" >> "$profile"
    echo "Added HARIL to $profile (open a new login shell)."
  fi
fi
"$bin/haril" --version
if [ "${HARIL_NO_GENTLE_SHELL:-0}" != "1" ]; then
  if command -v gentle-shell >/dev/null 2>&1; then
    echo "Gentle Shell already installed; leaving it unchanged."
  elif command -v npm >/dev/null 2>&1; then
    echo "Installing standalone Gentle Shell (gentle-pi@4.1.0)."
    npm install -g gentle-pi@4.1.0 --no-audit --no-fund ||
      echo "Warning: HARIL installed, but Gentle Shell needs a manual retry: npm install -g gentle-pi@4.1.0" >&2
  else
    echo "Warning: npm unavailable; Gentle Shell was not installed." >&2
  fi
fi
echo "Done. Open a new terminal: haril --version; haril doctor; haril update"
