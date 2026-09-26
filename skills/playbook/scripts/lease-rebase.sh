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

. "$script_dir/restack.sh"
restack_own_rows=${SKILLS_OWN_ROWS:-}

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

restack_require_replay
plans_root=${PLANS_DIR:-$HOME/Plans}
layers=
restack_leases=
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

  restack_check_idle "$branch" "$plans_root"/*/index.tsv
  git fetch --quiet origin "+refs/heads/$branch:refs/remotes/origin/$branch" >&2 \
    || refuse "cannot read origin/$branch"
  expected=$(git rev-parse "refs/remotes/origin/$branch")
  git merge-base --is-ancestor "$expected" "refs/heads/$branch" \
    || refuse "origin/$branch has commits $branch lacks"

  layers="$layers $branch"
  restack_leases="${restack_leases}${branch} ${expected}
"
done

restack_plan "$new_parent" "$old" $layers || refuse "$restack_conflict"
restack_push || refuse 'lease push rejected, no layer moved'

move_failed=0
restack_apply "$plans_root"/*/index.tsv || move_failed=1
[ -z "$restack_completed" ] || printf '%s' "$restack_completed"
[ "$move_failed" -eq 0 ] || refuse "$restack_error"
