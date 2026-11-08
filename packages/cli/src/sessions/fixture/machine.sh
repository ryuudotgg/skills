#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: machine.sh <dir>" >&2
  exit 2
fi

source=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
case "$1" in
  /*) dir=$1 ;;
  *) dir=$(pwd)/$1 ;;
esac

mkdir -p "$dir"
cp -R "$source/home" "$source/checkout" "$source/plans" "$dir/"
rm -f "$dir/checkout/Alpha/.gitkeep"
[ -d "$dir/checkout/Alpha/.git" ] || git init -q -b feat/one "$dir/checkout/Alpha"

claude="$dir/home/.claude/projects/-tmp-sessions-fixture-checkout-Alpha/claude-fixture.jsonl"
codex="$dir/home/.codex/sessions/2026/11/07/rollout-2026-11-07T10-00-00-codex-fixture.jsonl"

printf '{"session_id":"claude-fixture","transcript_path":"%s","cwd":"%s","hook_event_name":"SessionStart","source":"startup"}\n' \
  "$claude" "$dir/checkout/Alpha" >"$dir/hook-claude.json"

printf '{"session_id":"codex-fixture","transcript_path":"%s","cwd":"%s","hook_event_name":"SessionStart","source":"startup"}\n' \
  "$codex" "$dir/checkout/Alpha" >"$dir/hook-codex.json"

find "$dir/home" -name '*.jsonl' -exec touch -t 202601010000 {} +

printf "export HOME='%s' PLANS_DIR='%s'\n" "$dir/home" "$dir/plans"
