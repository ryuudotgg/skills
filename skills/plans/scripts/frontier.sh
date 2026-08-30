#!/bin/sh
set -eu
plans="${PLANS_DIR:-$HOME/Plans}"
proj="${1:-}"
if [ -z "$proj" ]; then
  repo=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
  lower=$(printf '%s' "$repo" | tr 'A-Z' 'a-z')
  for d in "$plans"/*/; do
    [ -d "$d" ] || continue
    n=$(basename "$d")
    [ "$(printf '%s' "$n" | tr 'A-Z' 'a-z')" = "$lower" ] && proj="$n" && break
  done
  if [ -z "$proj" ]; then
    echo "no project under $plans matches '$repo'. Pass one: /plans <Project>"
    if [ -d "$plans" ]; then
      known=$(ls -1 "$plans" 2>/dev/null | tr '\n' ' ')
      [ -n "$known" ] && echo "known projects: $known"
    else
      echo "$plans does not exist. Create it, or set PLANS_DIR."
    fi
    exit 0
  fi
fi
idx="$plans/$proj/index.tsv"
if [ ! -f "$idx" ]; then
  echo "no index.tsv for $proj (run /plans new to bootstrap)"
  exit 0
fi
awk -F'\t' '
FNR==NR { if (NR > 1) st[$1] = $3; next }
FNR == 1 { next }
$3 == "DOING" { doing = doing (doing ? ", " : "") $1 " " $2 " " $8; next }
$3 != "TODO" { next }
{
  blockers = ""
  n = split($6, b, ",")
  for (i = 1; i <= n; i++) {
    key = b[i]
    gsub(/[ \t]/, "", key)
    if (key == "" || key == "-") continue
    s = st[key]
    if (s != "DONE" && s != "DROPPED") blockers = blockers (blockers ? "," : "") key
  }
  note = $10
  if (length(note) > 52) note = substr(note, 1, 49) "..."
  slug = substr($2, 1, 34)
  if (blockers == "")
    ready[++r] = sprintf("%-4s %-3s %-3s %-34s %s", $1, $4, $5, slug, note)
  else
    held[++k] = sprintf("%-4s %-3s %-34s waits on %s", $1, $4, slug, blockers)
}
END {
  printf "READY %d\n", r + 0
  cmd = "sort -k2,2 -k3,3 -k1,1"
  for (i = 1; i <= r; i++) print ready[i] | cmd
  close(cmd)
  if (k) {
    printf "\nBLOCKED %d\n", k
    for (i = 1; i <= k; i++) print held[i]
  }
  if (doing) printf "\nDOING %s\n", doing
}
' "$idx" "$idx"
