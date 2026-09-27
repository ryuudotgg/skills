#!/bin/sh
set -eu

usage() {
  echo 'usage: reviewers.sh [--active] <KEY>' >&2
  exit 2
}

refuse() {
  printf 'reviewers: %s: %s\n' "$conf" "$*" >&2
  exit 1
}

active=0
if [ "${1:-}" = --active ]; then
  active=1
  shift
fi

[ "$#" -eq 1 ] || usage
printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[A-Z][A-Z0-9_]*$' || usage
key=$1

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
root=$script_dir/../..
cr=$(printf '\r')
tab=$(printf '\t')

export LC_ALL=C

read_all() {
  for directory in "$root"/*/; do
    conf=${directory}reviewer.conf
    [ -e "$conf" ] || [ -L "$conf" ] || continue
    [ -f "$conf" ] && [ -r "$conf" ] || refuse 'not a readable regular file'

    name=${directory%/}
    name=${name##*/}
    printf '%s\n' "$name" | grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$' || refuse 'invalid reviewer name'
    seen=' '
    value=
    found=0
    logins=
    handles=
    trigger=

    while IFS= read -r line || [ -n "$line" ]; do
      line=${line%"$cr"}
      case $line in
        ''|'#'*) continue ;;
      esac

      printf '%s\n' "$line" | grep -Eq '^[A-Z][A-Z0-9_]*=' || refuse 'malformed line'
      field=${line%%=*}
      entry=${line#*=}
      case $seen in
        *" $field "*) refuse "duplicate $field" ;;
      esac

      seen="$seen$field "
      case $field in
        NAME|LOGINS|HANDLES|TRIGGER|CHECK)
          printf '%s\n' "$entry" | grep -q '[^[:space:]]' || refuse "empty $field"
          ;;
      esac

      set -f
      case $field in
        LOGINS)
          for login in $entry; do
            printf '%s\n' "$login" | grep -Eq '^[A-Za-z0-9-]+(\[bot\])?$' || refuse "invalid login: $login"
          done
          ;;

        HANDLES)
          for handle in $entry; do
            case $handle in
              @*) ;;
              *) refuse "invalid handle: $handle" ;;
            esac
          done
          ;;
      esac
      set +f

      case $field in
        LOGINS) logins=$entry ;;

        HANDLES) handles=$entry ;;

        TRIGGER) trigger=$entry ;;
      esac

      if [ "$field" = "$key" ]; then
        value=$entry
        found=1
      fi
    done < "$conf"

    for field in NAME LOGINS HANDLES TRIGGER CHECK; do
      case $seen in
        *" $field "*) ;;
        *) refuse "missing $field" ;;
      esac
    done

    set -f
    for login in $logins; do
      case " $logins " in
        *" ${login%\[bot\]}[bot] "*) ;;
        *) refuse "login $login has no [bot] form" ;;
      esac
    done

    summons=0
    lower_trigger=$(printf '%s' "$trigger" | tr '[:upper:]' '[:lower:]')
    for handle in $handles; do
      case $lower_trigger in
        "$(printf '%s' "$handle" | tr '[:upper:]' '[:lower:]')"*) summons=1 ;;
      esac
    done
    set +f

    [ "$summons" = 1 ] || refuse 'TRIGGER does not start with one of its HANDLES'

    if [ "$found" = 1 ]; then
      printf '%s\t%s\n' "$name" "$value"
    fi
  done
}

rows=$(read_all) || exit 1
if [ "$active" = 1 ]; then
  mode=$(sh "$script_dir/delivery-mode.sh" 2>/dev/null)
  [ "$(printf '%s\n' "$mode" | sed -n '1p')" = prs ] || exit 0
  enabled=$(printf '%s\n' "$mode" | sed '1d')

  while IFS="$tab" read -r name value; do
    [ -n "$name" ] || continue
    if printf '%s\n' "$enabled" | grep -Fxq "$name"; then
      printf '%s\t%s\n' "$name" "$value"
    fi
  done <<EOF
$rows
EOF
elif [ -n "$rows" ]; then
  printf '%s\n' "$rows"
fi
