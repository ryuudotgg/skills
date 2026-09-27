#!/bin/sh
set -eu

usage() {
  echo 'usage: settings.sh <reviewer>' >&2
  exit 2
}

note() { printf 'settings: %s\n' "$*" >&2; }

[ "$#" -eq 1 ] || usage
printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$' || usage
reviewer=$1

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
tab=$(printf '\t')
cr=$(printf '\r')
nl='
'

export LC_ALL=C

if ! rows=$(sh "$script_dir/reviewers.sh" --settings); then
  note 'cannot read reviewer declarations'
  exit 1
fi

if ! printf '%s\n' "$rows" | cut -f 1 | grep -Fxq "$reviewer"; then
  note "$reviewer is not an installed reviewer"
  exit 1
fi

mode=$(sh "$script_dir/delivery-mode.sh" 2>/dev/null) || mode=
active=0
if [ "$(printf '%s\n' "$mode" | sed -n 1p)" = prs ] && printf '%s\n' "$mode" | sed 1d | grep -Fxq "$reviewer"; then
  active=1
fi

conf=
if [ -n "${SKILLS_CONF:-}" ]; then
  conf=$SKILLS_CONF
elif [ -n "${HOME:-}" ]; then
  conf=$HOME/.agents/skills.conf
fi

case $conf in
  /*) [ -f "$conf" ] && [ -r "$conf" ] || conf= ;;
  *) conf= ;;
esac

config_key() {
  printf '%s_%s\n' "$1" "$2" | tr '[:lower:]-' '[:upper:]_'
}

claimed=$(printf '%s\n' "$rows" | while IFS="$tab" read -r name setting default regex; do config_key "$name" "$setting"; done)

conf_lines=
if [ -n "$conf" ]; then
  conf_lines=$(sed "s/$cr\$//" "$conf" | grep -E '^[A-Z0-9]+(_[A-Z0-9]+)+=' | grep -Ev '^(DELIVERY|WITH)=' || true)
fi

printf '%s\n' "$conf_lines" | cut -d = -f 1 | sort -u | while IFS= read -r key; do
  [ -z "$key" ] || printf '%s\n' "$claimed" | grep -Fxq "$key" || note "$conf: $key is no installed reviewer's setting"
done

git_values=$(mktemp "${TMPDIR:-/tmp}/settings.XXXXXX")
trap 'rm -f "$git_values"' 0

apply() {
  source=$1
  count=$2
  candidate=$3
  [ "$count" -gt 0 ] || return 0

  if [ "$active" = 0 ]; then
    note "$source ignored, $reviewer is not active"
    return 0
  fi

  if [ "$count" -gt 1 ]; then
    note "$source is set more than once, skipped"
    return 0
  fi

  case $candidate in
    ''|*"$cr"*|*"$nl"*) ;;
    *)
      if printf '%s\n' "$candidate" | grep -Exq -e "$regex"; then
        value=$candidate
        return 0
      fi
      ;;
  esac

  note "$source=$candidate is not valid, skipped"
}

printf '%s\n' "$rows" | while IFS="$tab" read -r name setting default regex; do
  [ "$name" = "$reviewer" ] || continue
  value=$default
  key=$(config_key "$name" "$setting")

  matches=$(printf '%s\n' "$conf_lines" | grep -E "^$key=" || true)
  count=$(printf '%s' "$matches" | grep -c '' || true)
  apply "$conf: $key" "$count" "${matches#*=}"

  count=0
  candidate=
  if git config --local --includes --null --get-all "skills.$reviewer.$setting" > "$git_values" 2>/dev/null; then
    count=$(tr -cd '\000' < "$git_values" | wc -c | tr -d ' ')
    candidate=$(tr -d '\000' < "$git_values"; printf .)
    candidate=${candidate%.}
  fi

  apply "git config skills.$reviewer.$setting" "$count" "$candidate"
  printf '%s=%s\n' "$setting" "$value"
done
