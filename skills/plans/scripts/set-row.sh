#!/bin/sh
set -eu
proj="${1:?project required}"
id="${2:?id required}"
status="${3:?status required}"
branch="${4:--}"
note="${5:--}"
idx="${PLANS_DIR:-$HOME/Plans}/$proj/index.tsv"
[ -f "$idx" ] || { echo "no index.tsv for $proj" >&2; exit 1; }
case "$status" in
  TODO|DOING|DONE|DROPPED|BLOCKED|REVIEW) ;;
  *) echo "bad status: $status" >&2; exit 1 ;;
esac
tmp="$(mktemp "${TMPDIR:-/tmp}/plans-index.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
awk -F'\t' -v OFS='\t' -v id="$id" -v st="$status" -v br="$branch" -v nt="$note" \
    -v today="$(date +%F)" '
FNR == 1 { print; next }
$1 == id {
  $3 = st
  if (br != "-") $8 = br
  if (nt != "-") {
    gsub(/[\t\r\n]/, " ", nt)
    if (length(nt) > 100) nt = substr(nt, 1, 100)
    $10 = nt
  }
  $9 = today
  hit = 1
}
{ print }
END { if (!hit) { print "id not found: " id > "/dev/stderr"; exit 1 } }
' "$idx" > "$tmp"
mv "$tmp" "$idx"
grep -m1 "^$id	" "$idx"
