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

reviewers=$script_dir/../../playbook/scripts/reviewers.sh
installed_logins=$(sh "$reviewers" LOGINS) || refuse 'cannot read reviewer declarations'
installed_names=$(sh "$reviewers" NAME) || refuse 'cannot read reviewer declarations'

names=$(printf '%s\n' "$installed_names" | cut -f 2- | python3 -c 'import sys; print(" or ".join(sys.stdin.read().splitlines()))')
logins=$(printf '%s\n' "$installed_logins" | cut -f 2- | python3 -c 'import json; import sys; print(", ".join(json.dumps(login.lower()) for login in sys.stdin.read().split()))')
filter=".data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not) | .comments.nodes[0] | select(.author.login // \"\" | ascii_downcase | IN($logins)) | .url"

output=

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

  [ -n "$installed_names" ] || continue

  if threads=$(gh api graphql -F 'owner={owner}' -F 'repo={repo}' -F "number=$number" \
    -F "query=@$script_dir/unresolved.graphql" \
    --jq "$filter"); then
    :
  else
    refuse "gh failed reading review threads for $branch"
  fi

  for url in $threads; do
    output="${output:+$output
}open	$id	$branch	$number	$url"
  done
done

[ -z "$output" ] && exit 0

printf '%s\n' "$output" >&2
refuse "unresolved $names threads below the base"

