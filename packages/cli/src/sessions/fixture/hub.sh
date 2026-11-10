#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || [ -z "$1" ]; then
  echo "usage: hub.sh <dir-a> [<dir-b>]" >&2
  exit 2
fi

source=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
repo=$(CDPATH= cd -P "$source/../../../../.." && pwd)
live="$repo/packages/cli/src/test/hub-live.ts"
bin="$repo/skills/playbook/bin"

absolute() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$(pwd)" "$1" ;;
  esac
}

fresh() {
  case "$1" in
    *[\'\"\$\`\ ]*)
      echo "hub.sh: $1 holds a quote, a dollar, a backtick or a space" >&2
      exit 2
      ;;
  esac

  if [ -e "$1" ] && [ ! -e "$1/.hub-fixture" ] && [ -n "$(ls -A "$1")" ]; then
    echo "hub.sh: $1 is not empty and no hub.sh fixture made it" >&2
    exit 1
  fi

  if [ -e "$1/hub.env" ]; then bun "$live" down "$1" >/dev/null; fi
  rm -rf "$1"
  "$source/machine.sh" "$1" >/dev/null
  : >"$1/.hub-fixture"
  : >"$1/skills.conf"
}

env_of() {
  printf 'export HOME="%s/home" PLANS_DIR="%s/plans" SKILLS_CONF="%s/skills.conf"' "$1" "$1" "$1"
  printf ' AGENTS_DIR="%s/home/.agents" CLAUDE_CONFIG_DIR="%s/home/.claude" CODEX_HOME="%s/home/.codex"' "$1" "$1" "$1"
  printf ' HUB_URL="%s" HUB_NETWORK=local HUB_KEYS=file SKILLS_AUTO_UPDATE=0 SKILLS_MACHINE_REFRESH=0' "$2"
  printf ' PATH="%s:$PATH"' "$bin"
}

in_checkout() {
  dir=$1
  shift
  (
    eval "$(env_of "$dir" "$url")"
    cd "$dir/checkout/Alpha"
    "$@"
  )
}

a=$(absolute "$1")
b=${2:+$(absolute "$2")}

fresh "$a"
if [ -n "$b" ]; then fresh "$b"; fi

started=$(cd "$repo" && bun "$live" up "$a")
url=$(printf '%s\n' "$started" | sed -n 's/^HUB_URL=//p')
code=$(printf '%s\n' "$started" | sed -n 's/^init code //p')

in_checkout "$a" skills hub init "$url" --code "$code" --label A >/dev/null

if [ -n "$b" ]; then
  invite="$a/invite.out"
  in_checkout "$a" skills hub invite --label B >"$invite" 2>&1 &
  waiting=$!

  tries=0
  until grep -q '^skills hub join ' "$invite" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -gt 150 ] || ! kill -0 "$waiting" 2>/dev/null; then
      echo "hub.sh: A printed no invite, see $invite" >&2
      exit 1
    fi

    sleep 0.1
  done

  token=$(sed -n 's/^skills hub join [^ ]* //p' "$invite" | head -n 1)
  in_checkout "$b" skills hub join "$url" "$token" >/dev/null
  wait "$waiting"
fi

in_checkout "$a" skills machine refresh >/dev/null
if [ -n "$b" ]; then in_checkout "$b" skills machine refresh >/dev/null; fi

printf "A_ENV='%s'\n" "$(env_of "$a" "$url")"
if [ -n "$b" ]; then printf "B_ENV='%s'\n" "$(env_of "$b" "$url")"; fi
