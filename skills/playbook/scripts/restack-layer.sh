#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)

usage() {
  echo 'usage: restack-layer.sh -P <Project> [--push] [--onto <parent> <old parent tip>]' >&2
  exit 2
}

refuse() {
  printf 'restack-layer: %s\n' "$*" >&2
  exit 1
}

. "$script_dir/restack.sh"
restack_own_rows=

project=
push=0
onto=
while [ "$#" -gt 0 ]; do
  case $1 in
    -P)
      [ -z "$project" ] && [ "$#" -ge 2 ] || usage
      project=$2
      shift 2
      ;;

    --push)
      [ "$push" -eq 0 ] || usage
      push=1
      shift
      ;;

    --onto)
      [ -z "$onto" ] && [ "$#" -ge 3 ] || usage
      onto="$2 $3"
      shift 3
      ;;

    *) usage ;;
  esac
done

[ -n "$project" ] || usage
mode=$(sh "$script_dir/delivery-mode.sh" 2>/dev/null | sed -n '1p')
[ "$mode" = prs ] || refuse 'delivery mode is not prs'
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || refuse 'not inside a work tree'

git_dir=$(git rev-parse --absolute-git-dir)
rebasing=0
if [ -f "$git_dir/rebase-merge/head-name" ]; then
  branch=$(cat "$git_dir/rebase-merge/head-name")
  branch=${branch#refs/heads/}
  rebasing=1
elif [ -f "$git_dir/rebase-apply/head-name" ]; then
  branch=$(cat "$git_dir/rebase-apply/head-name")
  branch=${branch#refs/heads/}
  rebasing=1
elif [ -d "$git_dir/rebase-apply" ]; then
  refuse 'git am in progress'
elif [ -d "$git_dir/rebase-merge" ]; then
  refuse 'rebase in progress with no branch'
else
  branch=$(git symbolic-ref --quiet --short HEAD) || refuse 'detached HEAD'
fi

plans_root=${PLANS_DIR:-$HOME/Plans}
index=$plans_root/$project/index.tsv
restack_indexes=$index
[ -f "$index" ] || refuse "no index.tsv for $project"
owned=$(awk -F '\t' 'NR > 1 && $8 != "-" { print $8 }' "$index")
printf '%s\n' "$owned" | grep -Fxq -- "$branch" || refuse "$branch is not an owned branch"

trunk=$(git ls-remote --symref origin HEAD 2>/dev/null | awk '$1 == "ref:" { sub("refs/heads/", "", $2); print $2; exit }')
[ -n "$trunk" ] || refuse 'cannot read the default branch of origin'
[ "$branch" != "$trunk" ] || refuse "cannot rebase the default branch $trunk"
base=$(git config "branch.$branch.skills-base" || true)
[ -n "$base" ] || refuse "no skills-base for $branch"
lease=$(git config "branch.$branch.skills-restack-lease" || true)
saved_onto=$(git config "branch.$branch.skills-restack-onto" || true)
if [ -n "$saved_onto" ]; then
  [ -z "$onto" ] || [ "$onto" = "$saved_onto" ] || refuse '--onto conflicts with the recorded restack'
  onto=$saved_onto
elif [ -n "$lease" ] && [ -n "$onto" ]; then
  refuse '--onto conflicts with the recorded restack'
fi

fork_point=
if [ -n "$onto" ]; then
  base=${onto%% *}
  cutoff=${onto#* }
  fork_point=$(git rev-parse --verify --end-of-options "$cutoff^{commit}") || refuse "no such commit: $cutoff"
  if [ -z "$lease" ]; then
    git merge-base --is-ancestor "$fork_point" "$branch" || refuse "$cutoff is not an ancestor of $branch"
  fi
fi

case $base in
  origin/*)
    git fetch --quiet origin "+refs/heads/${base#origin/}:refs/remotes/$base" >&2 \
      || refuse "cannot fetch $base"
    ;;
esac

base_tip=$(git rev-parse --verify "$base^{commit}") || refuse "no such base: $base"
if [ "$rebasing" -eq 1 ]; then
  unmerged=$(git ls-files -u | cut -f2 | sort -u | paste -sd ' ' -)
  [ -z "$unmerged" ] \
    || refuse "unmerged paths in $branch: $unmerged, resolve them, git add, then GIT_EDITOR=true git rebase --continue"

  refuse "rebase of $branch still in progress, finish it with GIT_EDITOR=true git rebase --continue"
fi

for operation in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG sequencer; do
  [ ! -e "$git_dir/$operation" ] || refuse "$operation in progress on $branch"
done

stale=0
git merge-base --is-ancestor "$base_tip" "$branch" || stale=1
if [ -z "$lease" ] && [ "$stale" -eq 0 ]; then
  printf '%s already sits on %s\n' "$branch" "$base"
  exit 0
fi

[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse 'tracked changes'
restack_find_layers "$branch" "$index"
layers=$restack_layers
restack_require_replay

if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git fetch --quiet origin "+refs/heads/$branch:refs/remotes/origin/$branch" >&2 \
    || refuse "cannot fetch origin/$branch"
else
  status=$?
  [ "$status" -eq 2 ] || refuse "cannot read origin/$branch"
  refuse "origin has no $branch, publish it first"
fi

origin_tip=$(git rev-parse "refs/remotes/origin/$branch")
restack_read_origin $layers
moved_origin="origin/$branch moved since the rebase began, nothing pushed; sync $branch with origin, or drop the restack with git config --unset branch.$branch.skills-restack-lease"

if [ "$stale" -eq 1 ]; then
  [ "$push" -eq 0 ] || refuse "$branch is still stale on $base, run restack-layer.sh without --push"
  if [ -n "$lease" ]; then
    [ "$origin_tip" = "$lease" ] || [ "$origin_tip" = "$(git rev-parse "refs/heads/$branch")" ] \
      || refuse "$moved_origin"
  else
    [ "$origin_tip" = "$(git rev-parse "refs/heads/$branch")" ] \
      || refuse "origin/$branch differs from $branch, sync it first"
  fi

  if [ -z "$fork_point" ]; then
    fork_point=$(git merge-base --fork-point "$base" "$branch" || true)
    if [ -z "$fork_point" ]; then
      case $base in
        origin/*) fork_point=$(git merge-base "$base" "$branch" || true) ;;
      esac
    fi
  fi

  [ -n "$fork_point" ] || refuse "cannot find where $branch forked from $base, pass --onto <parent> <old parent tip>"
  if restack_ignored_collision "$git_dir" "$(git rev-parse --show-toplevel)" "$branch" "$base_tip"; then
    refuse 'an ignored file in this checkout sits where the rebase adds one'
  fi

  recorded_lease=0
  if [ "$lease" != "$origin_tip" ]; then
    lease=$origin_tip
    git config "branch.$branch.skills-restack-lease" "$lease"
    [ -z "$onto" ] || git config "branch.$branch.skills-restack-onto" "$onto"
    recorded_lease=1
  fi

  rebase_stderr=$(mktemp "${TMPDIR:-/tmp}/restack-layer-rebase.XXXXXX")
  if GIT_EDITOR=true git rebase --no-update-refs --onto "$base_tip" "$fork_point" "$branch" >&2 2>"$rebase_stderr"; then
    rm -f "$rebase_stderr"
  else
    reason=$(sed -n '1p' "$rebase_stderr")
    rm -f "$rebase_stderr"
    if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ]; then
      refuse "conflict rebasing $branch onto $base, resolve it here, git add, GIT_EDITOR=true git rebase --continue, run the standing checks, then restack-layer.sh --push"
    fi

    if [ "$recorded_lease" -eq 1 ]; then
      git config --unset "branch.$branch.skills-restack-lease"
      [ -z "$onto" ] || git config --unset "branch.$branch.skills-restack-onto"
    fi

    refuse "cannot rebase $branch onto $base: $reason"
  fi

  printf 'rebased %s onto %s, run the standing checks, then restack-layer.sh --push\n' "$branch" "$base"
  exit 0
fi

if [ "$push" -eq 0 ]; then
  printf '%s is rebased, run the standing checks, then restack-layer.sh --push\n' "$branch"
  exit 0
fi

[ -z "$(git rev-list --merges "$base_tip..$branch")" ] || refuse "merge commit in $branch, rebase it linear"
marker=$(git diff --text --no-color --no-renames --unified=0 "$base_tip" "$branch" | awk '
  /^\+\+\+ b\// { path = substr($0, 7) }
  /^\+(<<<<<<<|>>>>>>>)( |$)/ { print path; exit }
')

[ -z "$marker" ] || refuse "conflict marker left in $marker"
[ "$origin_tip" = "$lease" ] || refuse "$moved_origin"
git push --quiet "--force-with-lease=refs/heads/$branch:$lease" origin "refs/heads/$branch:refs/heads/$branch" >&2 \
  || refuse 'lease push rejected, nothing pushed'

if [ -n "$onto" ]; then
  git config "branch.$branch.skills-base" "$base"
  git config --unset "branch.$branch.skills-restack-onto"
fi

git config --unset "branch.$branch.skills-restack-lease"
output="pushed $branch"
refuse() {
  printf 'restack-layer: %s, %s is pushed, every layer above it is untouched\n' "$*" "$branch" >&2
  exit 1
}

restack_plan "$branch" "$lease" $layers || refuse "$restack_conflict"
restack_push || refuse 'lease push rejected'

refuse() {
  printf 'restack-layer: %s\n' "$*" >&2
  exit 1
}

move_failed=0
restack_apply "$index" || move_failed=1

while read -r layer old_tip new_tip; do
  [ -n "$layer" ] || continue
  exists=$(printf '%s\n' "$restack_records" | awk -F '|' -v name="$layer" '$1 == name { print $3; exit }')
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
