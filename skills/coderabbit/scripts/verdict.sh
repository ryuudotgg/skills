#!/bin/sh
set -eu

usage() {
  echo 'usage: verdict.sh gate <pr> [--wait] [critical=true] | verdict.sh decide <pr> <branch> [critical=true] [outcome=fixed|outcome=dismissed]' >&2
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

wait=no
critical=
outcome=
for option do
  case $option in
    --wait) [ "$phase" = gate ] && [ "$wait" = no ] || usage; wait=yes ;;
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
  printf '%s\n' "$rows" | awk -F "$tab" '$1 == "coderabbit" { print $2 }'
}

check=$(read_key CHECK)
trigger=$(read_key TRIGGER)
logins=$(read_key LOGINS)
[ -n "$check" ] && [ -n "$trigger" ] && [ -n "$logins" ] || refuse 'coderabbit is not a declared reviewer'
limits=$(sh "$playbook/check-state.sh" --limits) || refuse 'cannot read check limits'
window=$(printf '%s\n' "$limits" | sed -n 's/^window=//p')
cap=$(printf '%s\n' "$limits" | sed -n 's/^cap=//p')
deadline=$(( $(date +%s) + window + cap ))

decide() {
  if [ "$outcome" = dismissed ]; then
    sh "$script_dir/decide.sh" "$check_state" "$state" "$critical" dismissed=yes
  else
    sh "$script_dir/decide.sh" "$check_state" "$state" "$critical"
  fi
}

while :; do
  check_state=$(sh "$playbook/check-state.sh" "$pr" "$check" "$trigger" "$logins") || refuse 'cannot read check state'
  state=$(sh "$script_dir/state.sh" "$pr") || refuse 'cannot read review state'
  verdict=$(decide) || refuse 'cannot decide review state'
  gate=${check_state##* gate=}
  if [ "$phase" = decide ]; then
    [ "$gate" = appear ] || break
  else
    [ "$wait" = yes ] || break
    case $verdict in wait*) ;; *) break ;; esac
  fi

  remaining=$(( deadline - $(date +%s) ))
  [ "$remaining" -gt 0 ] || break
  poll=${CODERABBIT_POLL:-30}
  [ "$poll" -le "$remaining" ] || poll=$remaining
  sleep "$poll"
  [ "$(date +%s)" -lt "$deadline" ] || break
done

printf '%s\n' "$verdict"
