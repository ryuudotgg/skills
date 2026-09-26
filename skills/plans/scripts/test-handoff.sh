#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/plans-handoff.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tab=$(printf '\t')

export PLANS_DIR="$tmp/plans"
project=fixture
idx="$PLANS_DIR/$project/index.tsv"
repo="$tmp/repo"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

row() {
  printf '%s\n' "$1${tab}$2${tab}$3${tab}P1${tab}S${tab}$4${tab}-${tab}$5${tab}2026-09-26${tab}-"
}

mkdir -p "$PLANS_DIR/$project"
{
  printf '%s\n' "id${tab}slug${tab}status${tab}pri${tab}effort${tab}blocked_by${tab}ctx${tab}branch${tab}updated${tab}note"
  row 010 base DOING - feat/base
  row 011 child TODO 010 -
  row 020 top DOING - feat/top
  row 030 todo TODO - -
} > "$idx"

git init --quiet "$repo"
cd "$repo"
git config commit.gpgsign false
git -c user.name=test -c user.email=test@example.com commit --quiet --allow-empty -m init
git config branch.feat/top.skills-base feat/mid
git config branch.feat/mid.skills-base feat/low
git config branch.feat/low.skills-base origin/main

output=$(sh "$script_dir/handoff.sh" "$project" 010) || fail '010 exited nonzero'
expected='review 010 feat/base
next 011'
[ "$output" = "$expected" ] || fail "010 printed '$output', expected '$expected'"

status=$(awk -F '\t' '$1 == "010" { print $3; exit }' "$idx")
branch=$(awk -F '\t' '$1 == "010" { print $8; exit }' "$idx")
[ "$status" = REVIEW ] || fail "010 status was $status, expected REVIEW"
[ "$branch" = feat/base ] || fail "010 branch was $branch, expected feat/base"
awk -F '\t' 'END { exit !($2 == "fixture" && $3 == "010" && $4 == "handback" && $5 == "feat/base") }' "$PLANS_DIR/log.tsv" \
  || fail 'last log row was not fixture 010 handback feat/base'

output=$(sh "$script_dir/handoff.sh" "$project" 020) || fail '020 exited nonzero'
[ "$output" = 'babysit feat/low feat/mid feat/top' ] \
  || fail "020 printed '$output', expected babysit stack"

status=$(awk -F '\t' '$1 == "020" { print $3; exit }' "$idx")
[ "$status" = DOING ] || fail "020 status was $status, expected DOING"
if awk -F '\t' '$3 == "020" { found = 1 } END { exit found ? 0 : 1 }' "$PLANS_DIR/log.tsv"; then
  fail '020 wrote a log row'
fi

cp "$idx" "$tmp/before"
if sh "$script_dir/handoff.sh" "$project" 030 >"$tmp/out" 2>"$tmp/err"; then
  fail '030 succeeded, expected refusal'
else
  status=$?
fi

[ "$status" -eq 1 ] || fail "030 exited $status, expected 1"
cmp -s "$idx" "$tmp/before" || fail '030 changed the index'

if sh "$script_dir/handoff.sh" "$project" 099 >"$tmp/out" 2>"$tmp/err"; then
  fail '099 succeeded, expected refusal'
else
  status=$?
fi

[ "$status" -eq 1 ] || fail "099 exited $status, expected 1"

echo ok
