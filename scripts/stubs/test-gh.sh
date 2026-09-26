#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0
export GH_STUB_DIR="$tmp"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

printf 'prefix\n' > "$tmp/pr_list.prefix"
printf '7\n' > "$tmp/pr_list.prefix.exit"
printf 'exact\n' > "$tmp/pr_list_--head_main"
[ "$(sh "$script_dir/gh" pr list --head main)" = exact ] || fail 'exact fixture did not win'

status=0
sh "$script_dir/gh" pr list --head feature > "$tmp/out" || status=$?
[ "$status" -eq 7 ] || fail "prefix exited $status"
[ "$(cat "$tmp/out")" = prefix ] || fail 'prefix output did not match'

status=0
sh "$script_dir/gh" pr view > "$tmp/out" 2> "$tmp/err" || status=$?
[ "$status" -eq 1 ] || fail "no match exited $status"
grep -qx 'gh stub: no fixture pr_view for: pr view' "$tmp/err" || fail 'missing no fixture message'

echo ok
