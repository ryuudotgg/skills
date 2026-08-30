#!/bin/sh
set -eu
proj="${1:?project required}"
id="${2:?id required}"
event="${3:?event required}"
detail="${4:-}"
log="${PLANS_DIR:-$HOME/Plans}/log.tsv"
if [ ! -f "$log" ]; then
  mkdir -p "$(dirname "$log")"
  printf 'ts\tproject\tid\tevent\tdetail\n' > "$log"
fi
detail="$(printf '%s' "$detail" | tr '\t\r\n' '   ' | cut -c1-140)"
printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$proj" "$id" "$event" "$detail" >> "$log"
