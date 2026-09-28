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
  role=$2
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
    elif [ "$wait" = yes ] && [ "$role" = required ]; then
      set -- "$@" --wait
    fi

    [ -z "$critical" ] || set -- "$@" "$critical"

    if sh "$script" "$@" < /dev/null > "$tmp/output" &&
      LC_ALL=C awk 'NR == 1 && $0 ~ /^(absent|wait|triage|done|rereview|handback)( [a-z0-9-]+)*$/ { if ($1 != "handback" || NF > 1) valid = 1 } END { exit !(NR == 1 && valid) }' "$tmp/output"; then
      IFS= read -r verdict < "$tmp/output"
    fi
  fi

  printf '%s\t%s\t%s\n' "$name" "$role" "$verdict" > "$tmp/$name"
}

options=$*
required=0
all_absent=yes
while IFS="$tab" read -r name label; do
  settings=$(sh "$script_dir/settings.sh" "$name") || refuse "cannot read $name settings"

  role=$(printf '%s\n' "$settings" | sed -n 's/^role=//p')
  case $role in required|advisory) ;; *) refuse "invalid $name role" ;; esac

  printf '%s\n' "$role" > "$tmp/$name.role"

  if [ "$role" = required ]; then
    required=$((required + 1))
    run_reviewer "$name" required
    verdict=$(cut -f 3- "$tmp/$name")
    [ "$verdict" = absent ] || all_absent=no
  fi
done < "$tmp/active"

promote=no
if [ "$required" -eq 0 ] || [ "$all_absent" = yes ]; then
  promote=yes
fi

while IFS="$tab" read -r name label; do
  role=$(cat "$tmp/$name.role")
  [ "$role" = advisory ] || continue
  if [ "$promote" = yes ]; then
    role=required
  fi
  run_reviewer "$name" "$role"
done < "$tmp/active"

combined=done
while IFS="$tab" read -r name label; do
  IFS="$tab" read -r found role verdict < "$tmp/$name"
  printf '%s %s %s\n' "$name" "$role" "$verdict"
  word=${verdict%% *}
  [ "$role" = required ] || [ "$word" = triage ] || continue

  case $word in
    handback)
      case $combined in handback*) ;; *) combined="handback $name ${verdict#handback }" ;; esac
      ;;
    triage)
      case $combined in handback*) ;; *) combined=triage ;; esac
      ;;
    rereview)
      case $combined in done|wait) combined=rereview ;; esac
      ;;
    wait)
      [ "$combined" != done ] || combined=wait
      ;;
  esac
done < "$tmp/active"

printf '%s\n' "$combined"
