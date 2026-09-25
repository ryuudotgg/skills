#!/bin/sh

note() { printf 'delivery-mode: %s\n' "$*" >&2; }

cr=$(printf '\r')

if [ -n "${SKILLS_CONF:-}" ]; then
  conf=$SKILLS_CONF
elif [ -n "${HOME:-}" ]; then
  conf=$HOME/.agents/skills.conf
else
  echo hands-off
  exit 0
fi

case $conf in
  /*) ;;
  *)
    note "config path is not absolute: $conf"
    echo hands-off
    exit 0
    ;;
esac

if [ ! -e "$conf" ] && [ ! -L "$conf" ]; then
  echo hands-off
  exit 0
fi

if [ ! -f "$conf" ] || [ ! -r "$conf" ]; then
  note "$conf: not a readable regular file"
  echo hands-off
  exit 0
fi

mode=
with=
seen_mode=0
seen_with=0
lineno=0
bad=0
# IFS= keeps edge spaces so they fail the match; the || test reads a final line with no newline.
while IFS= read -r line || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  line=${line%"$cr"}

  case $line in
    ''|'#'*) continue ;;
  esac

  if [ "$seen_mode" = 0 ] && printf '%s\n' "$line" |
    LC_ALL=C grep -Eq '^DELIVERY=(prs|hands-off)$'; then
    seen_mode=1
    mode=${line#DELIVERY=}
  elif [ "$seen_with" = 0 ] && printf '%s\n' "$line" |
    LC_ALL=C grep -Eq '^WITH=([a-z0-9]+(-[a-z0-9]+)*( [a-z0-9]+(-[a-z0-9]+)*)*)?$'; then
    seen_with=1
    with=${line#WITH=}
  else
    bad=$lineno
    break
  fi
done < "$conf"

if [ "$bad" != 0 ]; then
  note "$conf: line $bad: malformed, ignoring the file"
  echo hands-off
  exit 0
fi

[ -n "$mode" ] || mode=hands-off

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
root=$script_dir/../..

frontmatter_verdict() {
  skill_md=$1
  opened=0
  closed=0
  optional=0
  requires=none

  if [ ! -r "$skill_md" ]; then
    echo not-extension
    return
  fi

  while IFS= read -r fm || [ -n "$fm" ]; do
    fm=${fm%"$cr"}

    if [ "$opened" = 0 ]; then
      [ "$fm" = --- ] || break
      opened=1
      continue
    fi

    if [ "$fm" = --- ]; then
      closed=1
      break
    fi

    [ "$fm" = 'optional: true' ] && optional=1

    case $fm in
      *requires*)
        if [ "$fm" = 'requires: prs' ] && [ "$requires" != unknown ]; then
          requires=prs
        else
          requires=unknown
        fi
        ;;
    esac
  done < "$skill_md"

  if [ "$closed" = 0 ] || [ "$optional" = 0 ]; then
    echo not-extension
    return
  fi

  echo "requires-$requires"
}

active=
seen=' '
set -f
for name in $with; do
  case $seen in
    *" $name "*) continue ;;
  esac

  seen="$seen$name "

  if [ "$name" = prs ]; then
    note "prs dropped: prs is a mode, set DELIVERY=prs"
    continue
  fi

  if [ ! -f "$root/$name/SKILL.md" ]; then
    note "$name dropped: not installed"
    continue
  fi

  case $(frontmatter_verdict "$root/$name/SKILL.md") in
    not-extension) note "$name dropped: not an extension" ;;

    requires-unknown) note "$name dropped: unknown requires" ;;

    requires-prs)
      if [ "$mode" = prs ]; then
        active="$active$name
"
      else
        note "$name dropped: requires DELIVERY=prs"
      fi
      ;;

    *) active="$active$name
" ;;
  esac
done
set +f

echo "$mode"
printf '%s' "$active"
exit 0
