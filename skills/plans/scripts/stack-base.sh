#!/bin/sh
set -eu
script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
cut=0

usage() {
  echo 'usage: stack-base.sh [--cut] <Project> <id>' >&2
  exit 2
}

refuse() {
  echo "stack-base: $*" >&2
  exit 1
}

[ "${1:-}" = --cut ] && { cut=1; shift; }
[ "$#" -eq 2 ] || usage
proj="$1"
id="$2"
idx="${PLANS_DIR:-$HOME/Plans}/$proj/index.tsv"
[ -f "$idx" ] || refuse "no index.tsv for $proj"

field() {
  awk -F'\t' -v id="$1" -v col="$2" 'NR > 1 && $1 == id { print $col; exit }' "$idx"
}

has_branch() {
  git rev-parse --verify --quiet "refs/heads/$1" >/dev/null
}

slug=$(field "$id" 2)
[ -n "$slug" ] || refuse "id $id not in $idx"

case "$(field "$id" 3)" in
  DONE|DROPPED|REVIEW) refuse "row $id is $(field "$id" 3), nothing to start" ;;
esac

git rev-parse --git-dir >/dev/null 2>&1 || refuse "not inside a git repository"
[ -z "$(git status --porcelain)" ] || refuse "working tree is dirty, commit or clear it first"
has_branch "feat/$slug" && refuse "feat/$slug already exists, check it out instead of cutting it again"

mode=$(sh "$script_dir/../../playbook/scripts/delivery-mode.sh" 2>/dev/null | sed -n 1p)

live() {
  [ "$mode" = prs ] && refuse "$*"
  echo "stack-base: warning, $*" >&2
}

current=$(git branch --show-current)
holder=$(awk -F'\t' -v id="$id" -v b="$current" 'NR > 1 && $3 == "DOING" && $1 != id && $8 == b { print $1; exit }' "$idx")
[ -n "$holder" ] && live "row $holder is DOING on $current, this checkout is its thread"

unmerged=""
merges=""
for blocker in $(field "$id" 6 | tr ',' ' '); do
  [ "$blocker" = - ] && continue
  case "$(field "$blocker" 3)" in
    "") refuse "blocker $blocker not in $idx" ;;
    DONE|DROPPED) continue ;;
    DOING) live "blocker $blocker is DOING, wait until it is in REVIEW" ;;
  esac

  branch=$(field "$blocker" 8)
  [ -n "$branch" ] && [ "$branch" != - ] || refuse "blocker $blocker has no branch, so no PR"
  command -v gh >/dev/null 2>&1 || refuse "gh not found, cannot check blocker $blocker"

  prs=$(gh pr list --head "$branch" --state all --json state,mergeCommit \
    --jq '.[] | [.state, .mergeCommit.oid // "-"] | join(" ")') \
    || refuse "gh pr list failed for $branch"

  case "$prs" in
    *OPEN*)
      has_branch "$branch" || refuse "blocker $blocker branch $branch is not in this checkout"
      unmerged="$unmerged $blocker:$branch"
      ;;
    *MERGED*)
      oid=$(printf '%s\n' "$prs" | awk '$1 == "MERGED" { print $2; exit }')
      merges="$merges $blocker:$branch:$oid"
      ;;
    *CLOSED*) refuse "blocker $blocker PR on $branch was closed without merging" ;;
    *) refuse "blocker $blocker has no PR for $branch" ;;
  esac
done

contains() {
  git merge-base --is-ancestor "$1" "$2" 2>/dev/null
}

if [ -z "$unmerged" ]; then
  default=$(git ls-remote --symref origin HEAD 2>/dev/null \
    | awk '$1 == "ref:" { sub("refs/heads/", "", $2); print $2; exit }')
  [ -n "$default" ] || refuse "cannot read the default branch of origin"
  git fetch --quiet origin "+refs/heads/$default:refs/remotes/origin/$default" \
    || refuse "fetch of origin $default failed"

  base="origin/$default"
  for merge in $merges; do
    contains "${merge##*:}" "$base" || refuse "blocker ${merge%%:*} merged, but not yet into $base"
  done
else
  base=""
  for candidate in $unmerged; do
    top="${candidate#*:}"
    for other in $unmerged; do
      git merge-base --is-ancestor "${other#*:}" "$top" || { top=""; break; }
    done

    [ -n "$top" ] && { base="$top"; break; }
  done

  [ -n "$base" ] || refuse "blockers$(printf ' %s' $unmerged | sed 's/:[^ ]*//g') are on two chains, no branch contains the others"

  for merge in $merges; do
    branch=$(printf '%s' "$merge" | cut -d: -f2)
    contains "${merge##*:}" "$base" || { has_branch "$branch" && contains "$branch" "$base"; } \
      || refuse "blocker ${merge%%:*} merged but $base does not contain it, rebase $base onto what it merged into"
  done
fi

if [ "$cut" -eq 1 ]; then
  git checkout --quiet --no-track -b "feat/$slug" "$base" || refuse "cannot cut feat/$slug from $base"
  git config "branch.feat/$slug.skills-base" "$base"
fi

printf '%s\n' "$base"
