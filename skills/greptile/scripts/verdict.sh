#!/bin/sh
set -eu

usage() {
  echo 'usage: verdict.sh gate <pr> [critical=true] | verdict.sh decide <pr> <branch> [critical=true] [outcome=fixed|outcome=dismissed]' >&2
  exit 2
}

refuse() {
  printf 'verdict: %s\n' "$*" >&2
  exit 1
}

[ "$#" -ge 2 ] || usage
phase=$1
pr=$2
shift 2
case $phase in gate|decide) ;; *) usage ;; esac
case $pr in ''|*[!0-9]*) usage ;; esac

branch=
if [ "$phase" = decide ]; then
  [ "$#" -ge 1 ] || usage
  branch=$1
  shift
  case $branch in ''|-*|*=*) usage ;; esac
fi

critical=
outcome=
for option do
  case $option in
    critical=true) [ -z "$critical" ] || usage; critical=$option ;;
    outcome=fixed|outcome=dismissed) [ "$phase" = decide ] && [ -z "$outcome" ] || usage; outcome=${option#outcome=} ;;
    *) usage ;;
  esac
done

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
playbook=$script_dir/../../playbook/scripts
tab=$(printf '\t')

read_key() {
  rows=$(sh "$playbook/reviewers.sh" "$1") || refuse "cannot read reviewer $1"
  printf '%s\n' "$rows" | awk -F "$tab" '$1 == "greptile" { print $2 }'
}

check=$(read_key CHECK)
trigger=$(read_key TRIGGER)
logins=$(read_key LOGINS)
[ -n "$check" ] && [ -n "$trigger" ] && [ -n "$logins" ] || refuse 'greptile is not a declared reviewer'

decide() {
  if [ "$phase" = decide ] && [ -n "$outcome" ]; then
    reviewed=$(printf '%s\n' "$score" | sed -n 's/.* reviewed=\([^ ]*\).*/\1/p')
    tip=
    if [ "$reviewed" != none ] && [ "$outcome" = fixed ]; then
      tip=$(git rev-parse --verify "refs/heads/$branch^{commit}" 2>/dev/null) || refuse 'branch is not a local branch'
    fi

    if [ "$reviewed" != none ] && [ "$reviewed" != "$tip" ]; then
      facts=$(sh "$script_dir/fix-facts.sh" "$reviewed" "$branch") || refuse 'cannot read fix facts'
      if [ "$outcome" = dismissed ]; then
        facts='commits=0 lines=0 added=0 moved=no'
      fi

      sh "$script_dir/decide.sh" "$check_state" "$score" "$facts" "$critical"
      return
    fi
  fi

  sh "$script_dir/decide.sh" "$check_state" "$score" "$critical"
}

check_state=$(sh "$playbook/check-state.sh" "$pr" "$check" "$trigger" "$logins") || refuse 'cannot read check state'
score=$(sh "$script_dir/score.sh" "$pr") || refuse 'cannot read score'
verdict=$(decide) || refuse 'cannot decide review state'

printf '%s\n' "$verdict"
