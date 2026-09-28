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
if [ "$phase" = gate ] && [ "$wait" = yes ]; then
  state=$(sh "$script_dir/state.sh" "$pr" --wait) || refuse 'cannot read review state'
else
  state=$(sh "$script_dir/state.sh" "$pr") || refuse 'cannot read review state'
fi

if [ "$outcome" = dismissed ]; then
  sh "$script_dir/decide.sh" "$state" "$critical" dismissed=yes
elif [ "$outcome" = fixed ]; then
  sh "$script_dir/decide.sh" "$state" "$critical" fixed=yes
else
  sh "$script_dir/decide.sh" "$state" "$critical"
fi
