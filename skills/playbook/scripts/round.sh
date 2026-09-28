#!/bin/sh
set -eu

usage() {
  echo 'usage: round.sh gate <pr> [--wait] [critical=true] | round.sh decide <pr> <branch> [critical=true] [<reviewer>=fixed|<reviewer>=dismissed ...]' >&2
  exit 2
}

refuse() {
  printf 'round: %s\n' "$*" >&2
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
outcomes=' '
for option do
  case $option in
    --wait) [ "$phase" = gate ] && [ "$wait" = no ] || usage; wait=yes ;;
    critical=true) [ -z "$critical" ] || usage; critical=$option ;;
    *=fixed|*=dismissed)
      [ "$phase" = decide ] || usage
      name=${option%%=*}
      printf '%s\n' "$name" | LC_ALL=C grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$' || usage
      case $outcomes in *" $name "*) usage ;; esac
      outcomes="$outcomes$name "
      ;;
    *) usage ;;
  esac
done

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
if ! active=$(sh "$script_dir/reviewers.sh" --active NAME); then
  refuse 'cannot read active reviewers'
fi

if [ -z "$active" ]; then
  [ "$outcomes" = ' ' ] || usage
  printf 'done\n'
  exit 0
fi

tab=$(printf '\t')
for option do
  case $option in
    *=fixed|*=dismissed)
      name=${option%%=*}
      printf '%s\n' "$active" | awk -F "$tab" -v name="$name" '$1 == name { found = 1 } END { exit !found }' || usage
      ;;
  esac
done

tmp=$(mktemp -d "${TMPDIR:-/tmp}/round.XXXXXX") || refuse 'cannot make temporary directory'
trap 'rm -rf "$tmp"' 0
printf '%s\n' "$active" > "$tmp/active"

run_reviewer() {
  name=$1
  script=$script_dir/../../$name/scripts/verdict.sh
  verdict='handback refused'

  if [ ! -f "$script" ]; then
    printf 'round: %s has no scripts/verdict.sh\n' "$name" >&2
  else
    set -- "$phase" "$pr"
    if [ "$phase" = decide ]; then
      set -- "$@" "$branch"
      for option in $options; do
        case $option in "$name"=*) set -- "$@" "outcome=${option#*=}" ;; esac
      done
    fi

    [ -z "$critical" ] || set -- "$@" "$critical"

    if sh "$script" "$@" < /dev/null > "$tmp/output" &&
      LC_ALL=C awk 'NR == 1 && $0 ~ /^(absent|wait|triage|done|rereview|handback|unavailable)( [a-z0-9-]+)*$/ { if (($1 != "handback" && $1 != "unavailable") || NF > 1) valid = 1 } END { exit !(NR == 1 && valid) }' "$tmp/output"; then
      IFS= read -r verdict < "$tmp/output"
    fi
  fi

  printf '%s\t%s\n' "$name" "$verdict" > "$tmp/$name"
}

options=$*
if [ "$phase" = decide ] || [ "$wait" = yes ]; then
  limits=$(sh "$script_dir/check-state.sh" --limits) || refuse 'cannot read check limits'
  window=$(printf '%s\n' "$limits" | sed -n 's/^window=//p')
  cap=$(printf '%s\n' "$limits" | sed -n 's/^cap=//p')
  deadline=$(( $(date +%s) + window + cap ))
fi

while :; do
  while IFS="$tab" read -r name label; do
    run_reviewer "$name"
  done < "$tmp/active"

  handbacks=
  unavailable=
  seen_wait=no
  seen_appear=no
  seen_triage=no
  seen_rereview=no
  seen_done=no
  while IFS="$tab" read -r name label; do
    IFS="$tab" read -r found verdict < "$tmp/$name"
    word=${verdict%% *}
    case $word in
      handback)
        [ -z "$handbacks" ] || handbacks="$handbacks, "
        handbacks="$handbacks$name ${verdict#handback }"
        ;;
      unavailable)
        [ -z "$unavailable" ] || unavailable="$unavailable, "
        unavailable="$unavailable$name unavailable ${verdict#unavailable }"
        ;;
      wait)
        seen_wait=yes
        [ "$verdict" = 'wait check-appear' ] && seen_appear=yes
        ;;
      triage) seen_triage=yes ;;
      rereview) seen_rereview=yes ;;
      done) seen_done=yes ;;
    esac
  done < "$tmp/active"

  combined=done
  if [ -n "$handbacks" ]; then
    combined="handback $handbacks"
  elif [ "$seen_wait" = yes ]; then
    combined=wait
  elif [ "$seen_triage" = yes ]; then
    combined=triage
  elif [ "$seen_rereview" = yes ]; then
    combined=rereview
  elif [ "$seen_done" = yes ]; then
    combined=done
  elif [ -n "$unavailable" ]; then
    combined="handback $unavailable"
  fi

  [ "$combined" = wait ] || break

  if [ "$phase" = decide ]; then
    [ "$seen_appear" = yes ] || break
  else
    [ "$wait" = yes ] || break
  fi

  remaining=$(( deadline - $(date +%s) ))
  [ "$remaining" -gt 0 ] || break
  poll=${ROUND_POLL:-30}
  [ "$poll" -le "$remaining" ] || poll=$remaining
  sleep "$poll"
  [ "$(date +%s)" -lt "$deadline" ] || break
done

while IFS="$tab" read -r name label; do
  IFS="$tab" read -r found verdict < "$tmp/$name"
  printf '%s %s\n' "$name" "$verdict"
done < "$tmp/active"

printf '%s\n' "$combined"
