#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)

usage() {
  echo 'usage: below.sh <Project> <base>' >&2
  exit 2
}

refuse() {
  echo "below: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || usage
project=$1
base=$2
index="${PLANS_DIR:-$HOME/Plans}/$project/index.tsv"

[ -f "$index" ] || refuse "no index.tsv for $project"

case "$base" in
  origin/*) exit 0 ;;
esac

output=
errors=$(mktemp "${TMPDIR:-/tmp}/plans-below.XXXXXX")
trap 'rm -f "$errors"' EXIT

for branch in $(sh "$script_dir/chain.sh" "$base"); do
  id=$(awk -F '\t' -v branch="$branch" 'NR > 1 && $8 == branch { print $1; exit }' "$index")
  [ -n "$id" ] || refuse "$branch is not an owned branch"

  if prs=$(gh pr list --head "$branch" --state all --json number,state \
    --jq '.[] | "\(.state) \(.number)"'); then
    :
  else
    refuse "gh pr list failed for $branch"
  fi

  number=$(printf '%s\n' "$prs" | awk '$1 == "OPEN" { print $2; exit }')
  if [ -z "$number" ]; then
    case "$prs" in
      *MERGED*) continue ;;
      *CLOSED*) refuse "PR for $branch was closed without merging" ;;
      *) refuse "$branch has no PR" ;;
    esac
  fi

  if checks=$(gh pr checks "$number" --json name,bucket,link \
    --jq '.[] | select(.bucket == "fail") | [.name, .link] | @tsv' 2>"$errors"); then
    status=0
  else
    status=$?
  fi

  if [ "$status" -ne 0 ] && [ "$status" -ne 1 ] && [ "$status" -ne 8 ]; then
    refuse "gh pr checks failed for $branch"
  fi

  if [ "$status" -eq 1 ] && [ -z "$checks" ] && ! grep -Fq 'no checks reported' "$errors"; then
    refuse "gh pr checks failed for $branch"
  fi

  line="layer	$id	$branch	$number"
  if [ -n "$output" ]; then
    output="$output
$line"
  else
    output=$line
  fi

  [ -n "$checks" ] || continue
  while IFS="$(printf '\t')" read -r name link; do
    output="$output
fail	$branch	$name	$link"
  done <<EOF
$checks
EOF
done

[ -z "$output" ] || printf '%s\n' "$output"
