#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
plans="${PLANS_DIR:-$HOME/Plans}"

usage() {
  echo 'usage: handoff.sh <Project> <id>' >&2
}

refuse() {
  echo "handoff: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || { usage; exit 2; }
proj="$1"
id="$2"
idx="$plans/$proj/index.tsv"

[ -f "$idx" ] || refuse "no index.tsv for $proj"

field() {
  awk -F '\t' -v id="$1" -v col="$2" 'NR > 1 && $1 == id { print $col; exit }' "$idx"
}

found=$(field "$id" 1)
[ -n "$found" ] || refuse "id $id not found"

status=$(field "$id" 3)
[ "$status" = DOING ] || refuse "row $id is $status, not DOING"

branch=$(field "$id" 8)
[ -n "$branch" ] && [ "$branch" != - ] || refuse "row $id has no branch"

sh "$script_dir/set-row.sh" "$proj" "$id" REVIEW >/dev/null

if ! frontier=$(sh "$script_dir/frontier.sh" --stacks-on "$id" "$proj"); then
  sh "$script_dir/set-row.sh" "$proj" "$id" DOING >/dev/null || true
  refuse 'frontier.sh failed'
fi

if [ -n "$frontier" ]; then
  sh "$script_dir/log.sh" "$proj" "$id" handback "$branch"
  printf 'review %s %s\n' "$id" "$branch"
  for next in $frontier; do
    printf 'next %s\n' "$next"
  done
  exit 0
fi

sh "$script_dir/set-row.sh" "$proj" "$id" DOING >/dev/null

stack="$branch"
seen=" $branch "
current="$branch"
while base=$(git config --get "branch.$current.skills-base"); do
  [ -n "$base" ] || break

  case "$base" in
    origin/*) break ;;
  esac

  case "$seen" in
    *" $base "*) break ;;
  esac

  stack="$base $stack"
  seen="$seen$base "
  current="$base"
done

printf 'babysit %s\n' "$stack"
