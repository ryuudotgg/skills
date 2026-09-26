#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)

usage() {
  echo 'usage: fix-round.sh -P <Project> -m "<message>" <file>...' >&2
  exit 2
}

refuse() {
  printf 'fix-round: %s\n' "$*" >&2
  exit 1
}

. "$script_dir/commit-message.sh"

project=
message=
has_project=0
has_message=0
while getopts ':P:m:' option; do
  case $option in
    P)
      [ "$has_project" -eq 0 ] || usage
      project=$OPTARG
      has_project=1
      ;;

    m)
      [ "$has_message" -eq 0 ] || usage
      message=$OPTARG
      has_message=1
      ;;

    *) usage ;;
  esac
done

shift "$((OPTIND - 1))"
[ "$has_project" -eq 1 ] && [ "$has_message" -eq 1 ] && [ "$#" -gt 0 ] || usage
validate_message "$message"

mode=$(sh "$script_dir/delivery-mode.sh" 2>/dev/null | sed -n '1p')
[ "$mode" = prs ] || refuse 'delivery mode is not prs'

[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || refuse 'not inside a work tree'
branch=$(git symbolic-ref --quiet --short HEAD) || refuse 'detached HEAD'
trunk=$(git ls-remote --symref origin HEAD 2>/dev/null | awk '$1 == "ref:" { sub("refs/heads/", "", $2); print $2; exit }')
[ -n "$trunk" ] || refuse 'cannot read the default branch of origin'
[ "$branch" != "$trunk" ] || refuse "cannot publish the default branch $trunk"

plans_root=${PLANS_DIR:-$HOME/Plans}
index=$plans_root/$project/index.tsv
[ -f "$index" ] || refuse "no index.tsv for $project"
owned=$(awk -F '\t' 'NR > 1 && $8 != "-" { print $8 }' "$index")
printf '%s\n' "$owned" | grep -Fxq -- "$branch" || refuse "$branch is not an owned branch"

layers=
parent=$branch
while :; do
  children=
  for candidate in $(git for-each-ref --format='%(refname:short)' refs/heads); do
    [ "$(git config "branch.$candidate.skills-base" || true)" = "$parent" ] \
      && children="$children $candidate"
  done

  first=$(printf '%s\n' "$children" | awk '{ print $1 }')
  second=$(printf '%s\n' "$children" | awk '{ print $2 }')
  [ -z "$second" ] || refuse "two layers above $parent: $first $second"
  [ -n "$first" ] || break
  parent=$first
  printf '%s\n' "$owned" | grep -Fxq -- "$parent" || refuse "$parent above $branch is not an owned branch"

  if [ -n "$layers" ]; then
    layers="$layers
$parent"
  else
    layers=$parent
  fi
done

records=
for layer in "$branch" $layers; do
  local_tip=$(git rev-parse "refs/heads/$layer")
  if git ls-remote --exit-code --heads origin "$layer" >/dev/null 2>&1; then
    git fetch --quiet origin "+refs/heads/$layer:refs/remotes/origin/$layer" >&2 \
      || refuse "cannot fetch origin/$layer"
    remote_tip=$(git rev-parse "refs/remotes/origin/$layer")
    if [ "$layer" = "$branch" ]; then
      git merge-base --is-ancestor "$remote_tip" "$local_tip" \
        || refuse "origin/$branch has commits $branch lacks"
    elif [ "$remote_tip" != "$local_tip" ]; then
      refuse "origin/$layer differs from $layer, sync it first"
    fi

    exists=1
  else
    status=$?
    [ "$status" -eq 2 ] || refuse "cannot read origin/$layer"
    [ "$layer" != "$branch" ] || refuse "origin has no $branch, publish it first"
    exists=0
  fi

  if [ -n "$records" ]; then
    records="$records
$layer|$local_tip|$exists"
  else
    records="$layer|$local_tip|$exists"
  fi
done

staged=$(git diff --cached --no-renames --name-only)
selected=$(git diff --cached --no-renames --name-only -- "$@")
if [ -n "$staged" ]; then
  printf '%s\n' "$staged" | while IFS= read -r path; do
    printf '%s\n' "$selected" | grep -Fxq -- "$path" \
      || refuse "already staged outside the file list: $path"
  done
fi

for path in "$@"; do
  shift
  if [ -e "$path" ] || git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    set -- "$@" "$path"
  elif ! printf '%s\n' "$staged" | grep -Fxq -- "$path"; then
    refuse "no such file: $path"
  fi
done

[ "$#" -eq 0 ] || git add -- "$@" >&2
if git diff --cached --no-renames --quiet; then
  refuse 'nothing to commit for this round'
fi

git commit --quiet -m "$message" >&2
actual=$(git log -1 --format=%B)
if [ "$actual" != "$message" ]; then
  git reset --quiet --soft HEAD^ >&2
  refuse 'commit message was altered by a hook or template'
fi

short=$(git rev-parse --short HEAD)
git push --quiet origin "refs/heads/$branch:refs/heads/$branch" >&2

output="committed $short on $branch
pushed $branch"
parent=$branch
for layer in $layers; do
  parent_old=$(printf '%s\n' "$records" | awk -F '|' -v name="$parent" '$1 == name { print $2; exit }')
  old_tip=$(printf '%s\n' "$records" | awk -F '|' -v name="$layer" '$1 == name { print $2; exit }')
  exists=$(printf '%s\n' "$records" | awk -F '|' -v name="$layer" '$1 == name { print $3; exit }')
  if ! git rebase --quiet --onto "$parent" "$parent_old" "$layer" >&2; then
    git rebase --abort >&2 || true
    git checkout --quiet "$branch" >&2
    refuse "rebase conflict on $layer, the round is pushed on $branch, $layer and every layer above it are untouched"
  fi

  if [ "$exists" = 1 ]; then
    git push --quiet --force-with-lease="refs/heads/$layer:$old_tip" origin "refs/heads/$layer:refs/heads/$layer" >&2
    output="$output
rebased $layer and pushed"
  else
    output="$output
rebased $layer (not on origin, not pushed)"
  fi
  parent=$layer
done

git checkout --quiet "$branch" >&2
printf '%s\n' "$output"
