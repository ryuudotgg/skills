#!/bin/sh
set -eu

usage() {
  echo 'usage: project.sh [--checkout | --is <Project>]' >&2
  exit 2
}

case "$#:${1:-}" in
  0:) mode=detect ;;
  1:--checkout) mode=checkout ;;
  2:--is) mode=is ;;
  *) usage ;;
esac

top=$(git rev-parse --show-toplevel 2>/dev/null || true)
main=""
if [ -n "$top" ]; then
  repo=$(basename "$top")
  common=$(git rev-parse --path-format=absolute --git-common-dir)
  if [ "$(basename "$common")" = .git ]; then
    main=$(basename "$(dirname "$common")")
  else
    main=$(basename "$common" .git)
  fi
  [ "$main" = "$repo" ] && main=""
else
  repo=$(basename "$PWD")
fi

if [ "$mode" = checkout ]; then
  printf '%s\n' "$repo"
  exit 0
fi

if [ "$mode" = is ]; then
  project=$2
  if [ -z "$top" ]; then
    printf 'not inside a git repository, not a checkout of %s\n' "$project"
    exit 1
  fi

  lower=$(printf '%s' "$project" | tr 'A-Z' 'a-z')
  for candidate in "$repo" "$main"; do
    [ -n "$candidate" ] || continue
    [ "$(printf '%s' "$candidate" | tr 'A-Z' 'a-z')" = "$lower" ] && exit 0
  done

  printf 'this checkout is %s, not a checkout of %s\n' "$repo" "$project"
  exit 1
fi

plans="${PLANS_DIR:-$HOME/Plans}"
for candidate in "$repo" "$main"; do
  [ -n "$candidate" ] || continue
  lower=$(printf '%s' "$candidate" | tr 'A-Z' 'a-z')
  for d in "$plans"/*/; do
    [ -d "$d" ] || continue
    n=$(basename "$d")
    [ "$(printf '%s' "$n" | tr 'A-Z' 'a-z')" = "$lower" ] && printf '%s\n' "$n" && exit 0
  done
done

exit 1
