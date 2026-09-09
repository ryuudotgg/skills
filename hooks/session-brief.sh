#!/bin/bash
# Kill switch: AGENT_HOOKS=0 disables every hook.
[ "${AGENT_HOOKS:-1}" = "0" ] && exit 0

PLANS="${PLANS_DIR:-$HOME/Plans}"

emit() { python3 -c '
import json,sys
t=sys.stdin.read().strip()
if t:
    print(json.dumps({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":t}}))
'; }

{
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

  branch=$(git branch --show-current 2>/dev/null)
  [ -z "$branch" ] && exit 0
  dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  untracked=$(git status --porcelain 2>/dev/null | grep -c '^??' | tr -d ' ')

  echo "Branch: $branch  (${dirty} changed, ${untracked} untracked)"

  [ -d "$PLANS" ] || exit 0

  repo=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)")
  proj=""
  for d in "$PLANS"/*/; do
    [ -d "$d" ] || continue
    n=$(basename "$d")
    [ "$(echo "$n" | tr 'A-Z' 'a-z')" = "$(echo "$repo" | tr 'A-Z' 'a-z')" ] && proj="$n" && break
  done
  [ -z "$proj" ] && exit 0

  idx="$PLANS/$proj/index.tsv"
  [ -f "$idx" ] || exit 0

  # Branches carry no plan id; the index row's branch column is the link.
  id=$(awk -F'\t' -v b="$branch" 'NR>1 && $8==b {print $1; exit}' "$idx")
  if [ -n "$id" ]; then
    row=$(awk -F'\t' -v i="$id" '$1==i {print "Plan "$1" "$2" ["$3"] "$10}' "$idx")
    [ -n "$row" ] && echo "$row"
  fi

  open=$(awk -F'\t' 'NR>1 && ($3=="TODO"||$3=="DOING"||$3=="BLOCKED")' "$idx" | wc -l | tr -d ' ')
  echo "$PLANS/$proj: $open open. Run /plans for the frontier."

  log="$PLANS/log.tsv"
  if [ -f "$log" ]; then
    tail=$(awk -F'\t' -v p="$proj" -v i="$id" -v b="$branch" \
      'NR>1 && $2==p && ((i!="" && $3==i) || index($5,b)>0)' "$log" | tail -3)
    [ -n "$tail" ] && { echo "Recent trail:"; echo "$tail"; }
  fi
} 2>/dev/null | emit
exit 0
