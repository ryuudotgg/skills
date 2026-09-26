#!/bin/sh
set -eu

usage() {
  echo 'usage: chain.sh <branch>' >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
branch=$1
stack=$branch
seen=" $branch "
current=$branch

while :; do
  base=$(git config --get "branch.$current.skills-base" || true)
  [ -n "$base" ] || break

  case "$base" in
    origin/*) break ;;
  esac

  case "$seen" in
    *" $base "*) break ;;
  esac

  stack="$base
$stack"
  seen="$seen$base "
  current=$base
done

printf '%s\n' "$stack"
