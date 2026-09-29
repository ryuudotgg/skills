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
. "$script_dir/restack.sh"
restack_own_rows=

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

why=$(sh "$script_dir/../../plans/scripts/project.sh" --is "$project") || refuse "$why"
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

restack_indexes=$index
restack_find_layers "$branch" "$index"
layers=$restack_layers
restack_require_replay

local_tip=$(git rev-parse "refs/heads/$branch")
if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git fetch --quiet origin "+refs/heads/$branch:refs/remotes/origin/$branch" >&2 \
    || refuse "cannot fetch origin/$branch"

  remote_tip=$(git rev-parse "refs/remotes/origin/$branch")
  git merge-base --is-ancestor "$remote_tip" "$local_tip" \
    || refuse "origin/$branch has commits $branch lacks"
else
  status=$?
  [ "$status" -eq 2 ] || refuse "cannot read origin/$branch"
  refuse "origin has no $branch, publish it first"
fi

records="$branch|$local_tip|1"
restack_read_origin $layers
if [ -n "$restack_records" ]; then
  records="$records
$restack_records"
fi

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
refuse() {
  printf 'fix-round: %s, the round is pushed on %s, every layer above it is untouched\n' "$*" "$branch" >&2
  exit 1
}

parent_old=$(printf '%s\n' "$records" | awk -F '|' -v name="$branch" '$1 == name { print $2; exit }')
restack_plan "$branch" "$parent_old" $layers || refuse "$restack_conflict"

restack_push || refuse 'lease push rejected'

refuse() {
  printf 'fix-round: %s\n' "$*" >&2
  exit 1
}

move_failed=0
restack_apply "$index" || move_failed=1

while read -r layer old_tip new_tip; do
  [ -n "$layer" ] || continue
  exists=$(printf '%s\n' "$records" | awk -F '|' -v name="$layer" '$1 == name { print $3; exit }')
  if [ "$exists" = 1 ]; then
    output="$output
rebased $layer and pushed"
  else
    output="$output
rebased $layer (not on origin, not pushed)"
  fi
done <<EOF
$restack_completed
EOF

printf '%s\n' "$output"
[ "$move_failed" -eq 0 ] || refuse "$restack_error"
