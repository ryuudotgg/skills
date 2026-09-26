restack_require_replay() {
  git replay -h 2>&1 | grep -q -- '--ref-action' \
    || refuse 'git replay lacks --ref-action'
}

restack_find_holder() {
  restack_holder_path=
  restack_holder_admin=
  restack_holder_current=0

  restack_common=$(git rev-parse --path-format=absolute --git-common-dir)
  restack_common=$(cd "$restack_common" && pwd -P)

  restack_current=$(git rev-parse --absolute-git-dir)
  restack_current=$(cd "$restack_current" && pwd -P)

  restack_bare=$(git config --bool core.bare || true)

  for restack_admin in "$restack_common" "$restack_common"/worktrees/*; do
    [ -d "$restack_admin" ] || continue
    [ "$restack_admin" != "$restack_common" ] || [ "$restack_bare" != true ] || continue

    restack_claim=$(git --git-dir="$restack_admin" symbolic-ref -q HEAD || true)
    if [ "$restack_claim" != "refs/heads/$1" ] \
      && ! grep -Fxq -- "refs/heads/$1" "$restack_admin/rebase-merge/head-name" \
        "$restack_admin/rebase-apply/head-name" "$restack_admin/rebase-merge/update-refs" 2>/dev/null \
      && ! grep -Fxq -- "$1" "$restack_admin/BISECT_START" 2>/dev/null; then
      continue
    fi

    if [ "$restack_admin" = "$restack_common" ]; then
      restack_path=$(dirname "$restack_common")
    else
      restack_gitdir=$(cat "$restack_admin/gitdir" 2>/dev/null || true)
      case $restack_gitdir in
        '') refuse "$1 has a gone holder at $restack_admin (missing gitdir)" ;;

        /*) ;;

        *) restack_gitdir=$restack_admin/$restack_gitdir ;;
      esac

      restack_path=$(dirname "$restack_gitdir")
      [ -e "$restack_gitdir" ] || refuse "$1 is held by $restack_path and its directory is gone"
    fi

    if [ -d "$restack_path" ]; then
      restack_path=$(cd "$restack_path" && pwd -P)
    fi

    [ -z "$restack_holder_admin" ] \
      || refuse "$1 is held by both $restack_holder_path and $restack_path"

    restack_holder_path=$restack_path
    restack_holder_admin=$(cd "$restack_admin" && pwd -P)
    if [ "$restack_holder_admin" = "$restack_current" ]; then
      restack_holder_current=1
    fi
  done
}

restack_check_idle() {
  restack_idle_branch=$1
  shift
  restack_find_holder "$restack_idle_branch"
  [ -n "$restack_holder_admin" ] && [ "$restack_holder_current" -eq 0 ] || return 0
  [ -d "$restack_holder_path" ] || refuse "$restack_idle_branch is held by $restack_holder_path and its directory is gone"

  case " ${restack_own_rows:-} " in
    *" $restack_idle_branch "*) ;;

    *)
      for restack_index in "$@"; do
        [ -f "$restack_index" ] || continue

        restack_doing=$(awk -F '\t' -v branch="$restack_idle_branch" 'NR > 1 && $3 == "DOING" && $8 == branch { print $1; exit }' "$restack_index")
        [ -z "$restack_doing" ] \
          || refuse "row $restack_doing in $restack_index is DOING on $restack_idle_branch, held by $restack_holder_path"
      done
      ;;
  esac

  for restack_operation in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG sequencer index.lock; do
    [ ! -e "$restack_holder_admin/$restack_operation" ] \
      || refuse "$restack_idle_branch is held by $restack_holder_path with $restack_operation in progress"
  done

  restack_status=$(git --no-optional-locks --git-dir="$restack_holder_admin" --work-tree="$restack_holder_path" status --porcelain --untracked-files=no) \
    || refuse "cannot read holder $restack_holder_path for $restack_idle_branch"

  [ -z "$restack_status" ] || refuse "$restack_idle_branch is held by $restack_holder_path with tracked changes"
}

restack_check_files() {
  restack_ignored=$(git --git-dir="$restack_holder_admin" --work-tree="$restack_holder_path" ls-files -o -i --exclude-standard --directory) \
    || refuse "cannot read ignored files in $restack_holder_path"

  restack_added=$(git diff --no-renames --name-only --diff-filter=A "$2" "$3")
  if [ -n "$restack_ignored" ] && [ -n "$restack_added" ] \
    && printf '%s\n' "$restack_ignored" | restack_added=$restack_added awk '
      function covers(path, set,   prefix, parts, count, i) {
        count = split(path, parts, "/")
        prefix = ""
        for (i = 1; i <= count; i++) {
          prefix = prefix (i > 1 ? "/" : "") parts[i]
          if (prefix in set) return 1
        }
        return 0
      }
      BEGIN { count = split(ENVIRON["restack_added"], list, "\n"); for (i = 1; i <= count; i++) adds[list[i]] = 1 }
      { sub("/$", ""); ignored[$0] = 1; if (covers($0, adds)) hit = 1 }
      END { for (a in adds) if (covers(a, ignored)) hit = 1; exit !hit }
    '; then
    refuse "$1 is held by $restack_holder_path and an ignored file sits where the move adds one"
  fi

  [ "$(git config --bool core.logAllRefUpdates || true)" != false ] && git reflog exists "refs/heads/$1" \
    || refuse "$1 is held by $restack_holder_path and has no reflog to check the move against"

  restack_index=$(mktemp "${TMPDIR:-/tmp}/restack-index.XXXXXX")
  cp "$restack_holder_admin/index" "$restack_index" 2>/dev/null || : > "$restack_index"
  if GIT_INDEX_FILE=$restack_index git --git-dir="$restack_holder_admin" --work-tree="$restack_holder_path" \
    read-tree -n -u -m HEAD "$3" >&2; then
    rm -f "$restack_index"
  else
    rm -f "$restack_index"
    refuse "$1 is held by $restack_holder_path and its files block the move"
  fi
}

restack_plan() {
  restack_onto=$(git rev-parse --verify "$1^{commit}") || refuse "no such parent: $1"
  restack_parent=$1
  restack_parent_old=$2
  shift 2
  restack_moves=

  for restack_layer in "$@"; do
    restack_old=$(git rev-parse "refs/heads/$restack_layer")
    restack_find_holder "$restack_layer"

    restack_suffix=
    if [ -n "$restack_holder_admin" ]; then
      restack_suffix=", held by $restack_holder_path"
    fi

    # Git replay is experimental and defaults to writing refs, so pin print.
    restack_stderr=$(mktemp "${TMPDIR:-/tmp}/restack-replay.XXXXXX")
    if restack_replay=$(git replay --ref-action=print --onto "$restack_onto" "$restack_parent_old..refs/heads/$restack_layer" 2>"$restack_stderr"); then
      rm -f "$restack_stderr"
    else
      restack_status=$?
      restack_reason=$(sed -n '1p' "$restack_stderr")
      rm -f "$restack_stderr"
      [ "$restack_status" -eq 1 ] || refuse "cannot replay $restack_layer onto $restack_parent: $restack_reason"

      restack_conflict="rebase conflict on $restack_layer onto $restack_parent$restack_suffix"
      return 1
    fi

    if [ -z "$restack_replay" ]; then
      restack_new=$restack_onto
    else
      restack_new=$(printf '%s\n' "$restack_replay" | awk -v ref="refs/heads/$restack_layer" -v old="$restack_old" '
        NR == 1 && NF == 4 && $1 == "update" && $2 == ref && $4 == old { tip = $3 }
        END { if (NR == 1) print tip }
      ')

      [ -n "$restack_new" ] || refuse "invalid replay output for $restack_layer"
    fi

    restack_new=$(git rev-parse --verify "$restack_new^{commit}") \
      || refuse "invalid replay tip for $restack_layer"

    [ -z "$restack_holder_admin" ] || restack_check_files "$restack_layer" "$restack_old" "$restack_new"

    restack_moves="${restack_moves}${restack_layer} ${restack_old} ${restack_new}
"

    restack_parent=$restack_layer
    restack_parent_old=$restack_old
    restack_onto=$restack_new
  done
}

restack_move() {
  restack_find_holder "$1"
  [ "$(git rev-parse "refs/heads/$1")" = "$2" ] || refuse "$1 moved since the restack was planned"
  [ "$2" != "$3" ] || return 0

  if [ -n "$restack_holder_admin" ]; then
    git --git-dir="$restack_holder_admin" --work-tree="$restack_holder_path" reset --quiet --keep "$3" >&2 \
      || refuse "cannot move $1 held by $restack_holder_path"

    [ "$(git rev-parse "refs/heads/$1")" = "$3" ] \
      || refuse "$1 moved in holder $restack_holder_path during the restack"

    restack_previous=$(git rev-parse "refs/heads/$1@{1}") || refuse "cannot read the previous tip of $1"
    if [ "$restack_previous" != "$2" ]; then
      git --git-dir="$restack_holder_admin" --work-tree="$restack_holder_path" reset --quiet --keep "$restack_previous" >&2 \
        || refuse "cannot restore raced holder $restack_holder_path on $1"

      refuse "$1 moved in holder $restack_holder_path during the restack"
    fi
  else
    git update-ref "refs/heads/$1" "$3" "$2" || refuse "cannot move $1"
  fi
}

restack_push() {
  restack_pushed=
  set --

  while read -r restack_push_layer restack_push_old restack_push_new; do
    [ -n "$restack_push_layer" ] || continue

    restack_lease=$(printf '%s\n' "$restack_leases" | awk -v layer="$restack_push_layer" '$1 == layer { print $2; exit }')
    [ -n "$restack_lease" ] && [ "$restack_lease" != "$restack_push_new" ] || continue

    set -- "$@" "--force-with-lease=refs/heads/$restack_push_layer:$restack_lease"
    restack_pushed="${restack_pushed}${restack_push_layer} ${restack_push_old} ${restack_push_new}
"
  done <<EOF
$restack_moves
EOF

  [ "$#" -gt 0 ] || return 0
  set -- "$@" origin

  while read -r restack_push_layer restack_push_old restack_push_new; do
    [ -n "$restack_push_layer" ] || continue

    set -- "$@" "$restack_push_new:refs/heads/$restack_push_layer"
  done <<EOF
$restack_pushed
EOF

  git push --quiet --atomic "$@" >&2
}

restack_rollback() {
  restack_rollback_started=0
  restack_rollback_moves=
  set --

  while read -r restack_rollback_layer restack_rollback_old restack_rollback_new; do
    [ -n "$restack_rollback_layer" ] || continue

    if [ "$restack_rollback_layer" = "$restack_failed_layer" ]; then
      restack_rollback_started=1
    fi

    [ "$restack_rollback_started" -eq 1 ] || continue
    printf '%s\n' "$restack_pushed" | awk -v restack_name="$restack_rollback_layer" '$1 == restack_name { found = 1 } END { exit !found }' || continue

    restack_rollback_old=$(printf '%s\n' "$restack_leases" | awk -v layer="$restack_rollback_layer" '$1 == layer { print $2; exit }')
    set -- "$@" "--force-with-lease=refs/heads/$restack_rollback_layer:$restack_rollback_new"
    restack_rollback_moves="${restack_rollback_moves}${restack_rollback_layer} ${restack_rollback_old}
"
  done <<EOF
$restack_moves
EOF

  [ "$#" -gt 0 ] || return 0
  set -- "$@" origin

  while read -r restack_rollback_layer restack_rollback_old; do
    [ -n "$restack_rollback_layer" ] || continue

    set -- "$@" "$restack_rollback_old:refs/heads/$restack_rollback_layer"
  done <<EOF
$restack_rollback_moves
EOF

  git push --quiet --atomic "$@" >&2
}

restack_apply() {
  restack_completed=

  while read -r restack_apply_layer restack_apply_old restack_apply_new; do
    [ -n "$restack_apply_layer" ] || continue

    if restack_move_error=$(
      exec 2>&1
      restack_check_idle "$restack_apply_layer" "$@"
      [ -z "$restack_holder_admin" ] || restack_check_files "$restack_apply_layer" "$restack_apply_old" "$restack_apply_new"
      restack_move "$restack_apply_layer" "$restack_apply_old" "$restack_apply_new"
    ); then
      restack_completed="${restack_completed}${restack_apply_layer} ${restack_apply_old} ${restack_apply_new}
"
    else
      restack_failed_layer=$restack_apply_layer
      restack_error="cannot move $restack_failed_layer: ${restack_move_error#*: }"

      if ! restack_rollback; then
        restack_error="$restack_error; lease rollback rejected"
      fi

      return 1
    fi
  done <<EOF
$restack_moves
EOF
}
