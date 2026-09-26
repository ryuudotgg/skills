#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
stub_bin=$(CDPATH= cd "$script_dir/../../../scripts/stubs" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/plans-stack-base.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tab=$(printf '\t')

export PLANS_DIR="$tmp/plans"
export GH_STUB_DIR="$tmp/gh"
export GH_STUB_LOG="$tmp/gh.log"
export SKILLS_CONF="$tmp/skills.conf"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
PATH="$stub_bin:$PATH"

mkdir -p "$PLANS_DIR/fixture" "$GH_STUB_DIR"
echo DELIVERY=prs > "$SKILLS_CONF"

git init --quiet --bare -b main "$tmp/origin.git"
git clone --quiet "$tmp/origin.git" "$tmp/work" 2>/dev/null
cd "$tmp/work"
git config commit.gpgsign false
git commit --quiet --allow-empty -m init
git push --quiet origin main

layer() {
  git checkout --quiet -b "$1" "$2"
  git commit --quiet --allow-empty -m "$1"
}

layer feat/open main
layer feat/child feat/open
layer feat/other main
git checkout --quiet main
git commit --quiet --allow-empty -m 'squash of feat/merged'
git push --quiet origin main
merge_oid=$(git rev-parse HEAD)
layer feat/rebased main
layer feat/squashed-bottom main
layer feat/on-squashed feat/squashed-bottom
layer feat/reused main
git checkout --quiet main

row() {
  printf '%s\n' "$1${tab}$2${tab}$3${tab}P1${tab}S${tab}$4${tab}-${tab}$5${tab}2026-09-26${tab}-"
}

{
  printf '%s\n' "id${tab}slug${tab}status${tab}pri${tab}effort${tab}blocked_by${tab}ctx${tab}branch${tab}updated${tab}note"
  row 100 merged REVIEW - feat/merged
  row 101 open REVIEW - feat/open
  row 102 child REVIEW 101 feat/child
  row 103 other REVIEW - feat/other
  row 104 unstarted TODO - -
  row 105 closed REVIEW - feat/closed
  row 106 no-pr REVIEW - feat/nopr
  row 107 dropped DROPPED - -
  row 108 into-layer REVIEW - feat/into-layer
  row 109 rebased REVIEW - feat/rebased
  row 110 after-merged TODO 100,107 -
  row 111 after-open TODO 101 -
  row 112 after-child TODO 101,102 -
  row 113 two-chains TODO 101,103 -
  row 114 after-unstarted TODO 104 -
  row 115 after-closed TODO 105 -
  row 116 after-no-pr TODO 106 -
  row 117 cut-me TODO 101 -
  row 118 unblocked TODO - -
  row 119 merged-and-stale TODO 100,101 -
  row 121 merged-and-rebased TODO 100,109 -
  row 122 after-layer-merge TODO 108 -
  row 123 already-open REVIEW - feat/already-open
  row 124 reused REVIEW - feat/reused
  row 125 after-reused TODO 124 -
  row 126 squashed-bottom REVIEW - feat/squashed-bottom
  row 127 on-squashed REVIEW 126 feat/on-squashed
  row 128 after-squash-stack TODO 126,127 -
  row 129 after-layer-and-parent TODO 101,102,108 -
} > "$PLANS_DIR/fixture/index.tsv"

prs() {
  key=$(printf '%s' "pr list --head $1 --state all --json state,mergeCommit --jq .[] | [.state, .mergeCommit.oid // \"-\"] | join(\" \")" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s' "$2" > "$GH_STUB_DIR/$key"
}

prs feat/merged "MERGED $merge_oid"
prs feat/into-layer "MERGED $(git rev-parse feat/child)"
prs feat/open 'OPEN -'
prs feat/child 'OPEN -'
prs feat/other 'OPEN -'
prs feat/rebased 'OPEN -'
prs feat/closed 'CLOSED -'
prs feat/reused "MERGED $merge_oid
OPEN -"
prs feat/squashed-bottom "MERGED $merge_oid"
prs feat/nopr ''
prs feat/on-squashed 'OPEN -'

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_base() {
  actual=$(sh "$script_dir/stack-base.sh" fixture "$1") || fail "$1 exited nonzero"
  [ "$actual" = "$2" ] || fail "$1 printed '$actual', expected '$2'"
}

expect_refusal() {
  id="$1"
  reason="$2"
  shift 2
  if "$@" sh "$script_dir/stack-base.sh" fixture "$id" > "$tmp/out" 2> "$tmp/err"; then
    fail "$id succeeded, expected refusal naming '$reason'"
  fi

  grep -q "$reason" "$tmp/err" || fail "$id stderr lacks '$reason': $(cat "$tmp/err")"
  [ ! -s "$tmp/out" ] || fail "$id printed a base while refusing"
}

expect_base 110 origin/main
expect_base 111 feat/open
expect_base 112 feat/child
expect_base 118 origin/main
grep -q -- '--head feat/merged' "$GH_STUB_LOG" || fail 'merged blocker was not checked with gh'

expect_refusal 113 'two chains' env
expect_refusal 114 'no branch' env
expect_refusal 115 'closed without merging' env
expect_refusal 116 'no PR' env
expect_refusal 119 'feat/open does not contain it' env
expect_base 121 feat/rebased
expect_refusal 122 'merged, but not yet into origin/main' env
expect_base 125 feat/reused
expect_base 128 feat/on-squashed
expect_base 129 feat/child
expect_refusal 123 'nothing to start' env
mkdir "$tmp/nogh"
for tool in sh git awk sed cut tr dirname cat; do
  ln -s "$(command -v "$tool")" "$tmp/nogh/$tool"
done

expect_refusal 111 'gh not found' env PATH="$tmp/nogh"

touch dirt
expect_refusal 118 'dirty' env
rm dirt

{
  row 120 busy DOING - feat/busy
  row 130 held DOING - feat/held
  row 131 after-held TODO 130 -
} >> "$PLANS_DIR/fixture/index.tsv"

actual=$(sh "$script_dir/stack-base.sh" fixture 111 2> "$tmp/err") || fail 'a DOING row in another checkout refused'
[ "$actual" = feat/open ] || fail "unrelated DOING row printed '$actual'"
[ ! -s "$tmp/err" ] || fail "unrelated DOING row warned: $(cat "$tmp/err")"
expect_refusal 131 'blocker 130 is DOING' env

git checkout --quiet -b feat/busy main
expect_refusal 111 'row 120 is DOING on feat/busy' env
echo DELIVERY=hands-off > "$SKILLS_CONF"
actual=$(sh "$script_dir/stack-base.sh" fixture 111 2> "$tmp/err") || fail 'hands-off refused on a held checkout'
[ "$actual" = feat/open ] || fail "hands-off printed '$actual'"
grep -q 'warning, row 120 is DOING on feat/busy' "$tmp/err" || fail 'hands-off did not warn on the held checkout'
git checkout --quiet main

actual=$(sh "$script_dir/stack-base.sh" --cut fixture 117 2>/dev/null) || fail '--cut exited nonzero'
[ "$actual" = feat/open ] || fail "--cut printed '$actual'"
[ "$(git branch --show-current)" = feat/cut-me ] || fail '--cut did not check out feat/cut-me'
[ "$(git config branch.feat/cut-me.skills-base)" = feat/open ] || fail 'skills-base not recorded'

actual=$(sh "$script_dir/stack-base.sh" --cut fixture 118 2>/dev/null) || fail 'trunk --cut exited nonzero'
[ "$actual" = origin/main ] || fail "trunk --cut printed '$actual'"
[ "$(git config branch.feat/unblocked.skills-base)" = origin/main ] || fail 'trunk skills-base not recorded'
[ -z "$(git config branch.feat/unblocked.merge || true)" ] || fail '--cut tracked the default branch'
expect_refusal 117 'already exists' env

echo ok
