#!/usr/bin/env bash
# прогон бара на реальном payload; аргумент — файл payload
set -u
D="/c/Users/WormAlien/Desktop/Autoreger_Clean"
for f in "$@"; do
  p="$(cat "$D/_sandbox/statusline-payloads/$f")"
  out="$(STATUSLINE_PAYLOAD="$p" bash "$D/routing/statusline-autoreger.sh")"
  printf '%-20s %s\n' "$f" "$out"
  printf '%-20s RAW %s\n' "" "$(printf '%s' "$out" | sed 's/\x1b/ESC/g')"
done
