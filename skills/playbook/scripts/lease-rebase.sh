#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)

usage() {
  echo 'usage: lease-rebase.sh <parent> <parent-old-tip> <branch>...' >&2
  exit 2
}

refuse() {
  printf 'lease-rebase: %s\n' "$*" >&2
  exit 1
}

[ "$#" -ge 3 ] || usage
new_parent=$1
old=$2
shift 2

mode=$(sh "$script_dir/delivery-mode.sh" 2>/dev/null | sed -n '1p')
[ "$mode" = prs ] || refuse 'delivery mode is not prs'

[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] \
  || refuse 'not inside a work tree'
original=$(git symbolic-ref --quiet --short HEAD) || refuse 'detached HEAD'
[ -z "$(git status --porcelain)" ] || refuse 'dirty tree'
trunk=$(git ls-remote --symref origin HEAD 2>/dev/null \
  | awk '$1 == "ref:" { sub("refs/heads/", "", $2); print $2; exit }')

[ -n "$trunk" ] || refuse 'cannot read the default branch of origin'
git rev-parse --verify --end-of-options "$old^{commit}" >/dev/null 2>&1 \
  || refuse "no such commit: $old"
git rev-parse --verify --end-of-options "$new_parent^{commit}" >/dev/null 2>&1 \
  || refuse "no such parent: $new_parent"

root=$(git rev-parse --show-toplevel)
worktrees=$(git worktree list --porcelain)
seen=
for branch in "$@"; do
  [ "$branch" != "$trunk" ] || refuse "cannot rebase the default branch $trunk"
  case " $seen " in
    *" $branch "*) refuse "branch listed twice: $branch" ;;
  esac

  seen="$seen $branch"
  git show-ref --verify --quiet "refs/heads/$branch" || refuse "no local branch $branch"
  if git ls-remote --exit-code origin "refs/heads/$branch" >/dev/null; then
    :
  else
    status=$?
    [ "$status" -eq 2 ] || refuse "cannot read origin/$branch"
    refuse "$branch is not on origin"
  fi

  path=$(printf '%s\n' "$worktrees" | awk -v ref="refs/heads/$branch" -v root="$root" '
    /^worktree / { path = substr($0, 10) }
    /^branch / && substr($0, 8) == ref && path != root { print path; exit }
  ')

  [ -z "$path" ] || refuse "$branch is checked out in $path"
  git fetch --quiet origin "+refs/heads/$branch:refs/remotes/origin/$branch" >&2 \
    || refuse "cannot read origin/$branch"
  expected=$(git rev-parse "refs/remotes/origin/$branch")
  git merge-base --is-ancestor "$expected" "refs/heads/$branch" \
    || refuse "origin/$branch has commits $branch lacks"

  shift
  set -- "$@" "$branch" "$expected"
done

while [ "$#" -gt 0 ]; do
  branch=$1
  expected=$2
  shift 2
  before=$(git rev-parse "refs/heads/$branch")
  if ! git rebase --quiet --no-update-refs --onto "$new_parent" "$old" "$branch" >&2; then
    git rebase --abort >&2 || refuse "rebase of $branch onto $new_parent failed and could not be aborted"
    git checkout --quiet "$original" >&2
    refuse "rebase conflict on $branch onto $new_parent"
  fi

  after=$(git rev-parse "refs/heads/$branch")
  if [ "$after" != "$expected" ]; then
    if ! git push --quiet "--force-with-lease=refs/heads/$branch:$expected" \
      origin "refs/heads/$branch:refs/heads/$branch" >&2; then
      git reset --quiet --hard "$before" >&2
      git checkout --quiet "$original" >&2
      refuse "lease push rejected for $branch, reset to $before"
    fi
  fi

  printf '%s %s %s\n' "$branch" "$before" "$after"
  new_parent=$branch
  old=$before
done

git checkout --quiet "$original" >&2
