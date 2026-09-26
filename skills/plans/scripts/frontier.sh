#!/bin/sh
set -eu
plans="${PLANS_DIR:-$HOME/Plans}"
mode="default"
stack=""

usage() {
  echo 'usage: frontier.sh [--next | --stacks-on <id>] [Project]' >&2
}

stop() {
  if [ "$mode" = default ]; then
    printf '%s\n' "$@"
    exit 0
  fi

  printf '%s\n' "$@" >&2
  exit 1
}

case "${1:-}" in
  --next) mode="next"; shift ;;
  --stacks-on)
    [ "$#" -ge 2 ] || { usage; exit 2; }
    mode="stacks"
    stack="$2"
    shift 2
    ;;
  -*) usage; exit 2 ;;
esac

[ "$#" -le 1 ] || { usage; exit 2; }
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
    miss="no project under $plans matches '$repo'. Pass one: /plans <Project>"
    if [ ! -d "$plans" ]; then
      stop "$miss" "$plans does not exist. Create it, or set PLANS_DIR."
    fi

    known=$(ls -1 "$plans" 2>/dev/null | tr '\n' ' ')
    [ -n "$known" ] && stop "$miss" "known projects: $known"
    stop "$miss"
  fi
fi
idx="$plans/$proj/index.tsv"
[ -f "$idx" ] || stop "no index.tsv for $proj (run /plans new to bootstrap)"
awk -F'\t' -v mode="$mode" -v stack="$stack" '
function ancestor(ancestor_id, descendant_id,    n, parts, i, parent, item) {
  if (ancestor_id == descendant_id) return 0
  for (item in seen) delete seen[item]
  for (item in queue) delete queue[item]
  queued = 0
  seen[descendant_id] = 1
  while (1) {
    if (descendant_id in deps) {
      n = split(deps[descendant_id], parts, ",")
      for (i = 1; i <= n; i++) {
        parent = parts[i]
        gsub(/[ \t]/, "", parent)
        if (parent == ancestor_id) return 1
        if (parent != "" && parent != "-" && !seen[parent]) {
          seen[parent] = 1
          queue[++queued] = parent
        }
      }
    }
    if (!queued) break
    descendant_id = queue[queued--]
  }
  return 0
}
function before(left, right,    l, rr, i) {
  split(left, l, " ")
  split(right, rr, " ")
  for (i = 2; i <= 3; i++)
    if (l[i] != rr[i]) return l[i] < rr[i]
  return l[1] < rr[1]
}
function sort_ready(    i, j, value) {
  for (i = 2; i <= r; i++) {
    value = ready[i]
    for (j = i - 1; j >= 1 && !before(ready[j], value); j--)
      ready[j + 1] = ready[j]
    ready[j + 1] = value
  }
}
function ready_id(line,    fields) {
  split(line, fields, " ")
  return fields[1]
}
FNR == NR {
  if (NR > 1) {
    st[$1] = $3
    deps[$1] = $6
    branch[$1] = $8
  }
  next
}
FNR == 1 { next }
$3 == "DOING" { doing = doing (doing ? ", " : "") $1 " " $2 " " $8; next }
$3 == "REVIEW" { review[++v] = sprintf("%-4s %-3s %-34s %s", $1, $4, substr($2, 1, 34), $8); next }
$3 != "TODO" { next }
{
  blockers = ""
  reviews_only = 1
  n = split($6, b, ",")
  for (i = 1; i <= n; i++) {
    key = b[i]
    gsub(/[ \t]/, "", key)
    if (key == "" || key == "-") continue
    s = st[key]
    if (s != "DONE" && s != "DROPPED") {
      blockers = blockers (blockers ? "," : "") key
      if (s != "REVIEW") reviews_only = 0
    }
  }
  note = $10
  if (length(note) > 52) note = substr(note, 1, 49) "..."
  slug = substr($2, 1, 34)
  stacked_on = ""
  if (blockers != "" && reviews_only) {
    n = split(blockers, b, ",")
    for (i = 1; i <= n; i++) {
      candidate = b[i]
      topmost = 1
      for (j = 1; j <= n; j++)
        if (i != j && !ancestor(b[j], candidate)) topmost = 0
      if (topmost) {
        stacked_on = candidate
        break
      }
    }
  }
  if (blockers == "" || stacked_on != "") {
    if (stacked_on != "") note = "stacks on " stacked_on " (" branch[stacked_on] ")"
    ready[++r] = sprintf("%-4s %-3s %-3s %-34s %s", $1, $4, $5, slug, note)
    stacks_on[$1] = stacked_on
  } else {
    suffix = reviews_only ? " (two stacks)" : ""
    held[++k] = sprintf("%-4s %-3s %-34s waits on %s%s", $1, $4, slug, blockers, suffix)
  }
}
END {
  sort_ready()
  if (mode == "next") {
    if (r) print ready_id(ready[1])
    exit
  }
  if (mode == "stacks") {
    for (i = 1; i <= r; i++)
      if (stacks_on[ready_id(ready[i])] == stack) print ready_id(ready[i])
    exit
  }
  printf "READY %d\n", r + 0
  for (i = 1; i <= r; i++) print ready[i]
  if (k) {
    printf "\nBLOCKED %d\n", k
    for (i = 1; i <= k; i++) print held[i]
  }
  if (v) {
    printf "\nREVIEW %d\n", v
    for (i = 1; i <= v; i++) print review[i]
  }
  if (doing) printf "\nDOING %s\n", doing
}
' "$idx" "$idx"
