#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
stub_bin=$(CDPATH= cd "$script_dir/../../../scripts/stubs" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/plans-preflight.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tab=$(printf '\t')

export PLANS_DIR="$tmp/plans" GH_STUB_DIR="$tmp/gh" GH_STUB_LOG="$tmp/gh.log"
export SKILLS_CONF="$tmp/skills.conf" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
PATH="$stub_bin:$PATH"
export PATH

mkdir -p "$PLANS_DIR" "$GH_STUB_DIR"
printf 'DELIVERY=prs\n' > "$SKILLS_CONF"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

fixture() {
  output=$1
  status=$2
  shift 2
  key=$(printf '%s' "$*" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s' "$output" > "$GH_STUB_DIR/$key"
  printf '%s\n' "$status" > "$GH_STUB_DIR/$key.exit"
}

expect_refusal() {
  reason=$1
  shift
  if "$@" > "$tmp/out" 2> "$tmp/err"; then
    fail "succeeded, expected refusal: $reason"
  fi

  grep -Fq "$reason" "$tmp/err" || fail "missing refusal: $reason"
  [ ! -s "$tmp/out" ] || fail 'refusal printed stdout'
}

pr_list() {
  fixture "$2" "$3" pr list --head "$1" --state all --json number,state \
    --jq '.[] | "\(.state) \(.number)"'
}

checks() {
  fixture "$2" "$3" pr checks "$1" --json name,bucket,link \
    --jq '.[] | select(.bucket == "fail") | [.name, .link] | @tsv'
}

stack_pr() {
  fixture "$2" "$3" pr list --head "$1" --state all --json state,mergeCommit \
    --jq '.[] | [.state, .mergeCommit.oid // "-"] | join(" ")'
}

review_fixture() {
  number=$1
  inline=$2
  fixture "$inline" 0 api "repos/{owner}/{repo}/pulls/$number/comments" --paginate --jq '.[] | "### \(.path):\(.line // .original_line // "file") by \(.user.login)\n\(.html_url)\n\(.body)\n"'
  fixture '' 0 pr view "$number" --json body --jq .body
  fixture '' 0 pr view "$number" --json reviews --jq '.reviews[] | select(.body != "") | "### review by \(.author.login), \(.state)\n\(.body)\n"'
  fixture '' 0 pr view "$number" --json comments --jq '.comments[] | "### comment by \(.author.login)\n\(.url)\n\(.body)\n"'
}

fresh() {
  name=$1
  origin=$tmp/$name.git
  repo=$tmp/$name
  rm -rf "$origin" "$repo" "$PLANS_DIR/Proj" "$GH_STUB_DIR"
  mkdir -p "$GH_STUB_DIR" "$PLANS_DIR/Proj"
  git init --quiet --bare -b main "$origin"
  cat > "$origin/hooks/post-receive" <<'SH'
#!/bin/sh
while read -r old new refname; do
  printf 'push %s\n' "$refname" >> "$GH_STUB_LOG"
done
SH
  chmod 755 "$origin/hooks/post-receive"
  git clone --quiet "$origin" "$repo" 2>/dev/null
  cd "$repo"
  git config commit.gpgsign false
  printf 'base\n' > base
  git add -- base
  git commit --quiet -m init
  git push --quiet origin main
  git checkout --quiet -b feat/a main
  git config branch.feat/a.skills-base origin/main
  printf 'a\n' > a
  git add -- a
  git commit --quiet -m 'feat: a'
  git push --quiet -u origin feat/a
  git checkout --quiet -b feat/b feat/a
  git config branch.feat/b.skills-base feat/a
  printf 'b\n' > b
  git add -- b
  git commit --quiet -m 'feat: b'
  git push --quiet -u origin feat/b
  git checkout --quiet main
  {
    printf '%s\n' "id${tab}slug${tab}status${tab}pri${tab}effort${tab}blocked_by${tab}ctx${tab}branch${tab}updated${tab}note"
    printf '%s\n' "1${tab}a${tab}REVIEW${tab}P1${tab}S${tab}-${tab}-${tab}feat/a${tab}2026-09-26${tab}-"
    printf '%s\n' "2${tab}b${tab}REVIEW${tab}P1${tab}S${tab}1${tab}-${tab}feat/b${tab}2026-09-26${tab}-"
    printf '%s\n' "3${tab}new${tab}TODO${tab}P1${tab}S${tab}2${tab}-${tab}-${tab}2026-09-26${tab}-"
  } > "$PLANS_DIR/Proj/index.tsv"
  : > "$GH_STUB_LOG"
}

standard_fixtures() {
  pr_list feat/a 'OPEN 1' 0
  pr_list feat/b 'OPEN 2' 0
  checks 1 "lint${tab}https://example.test/a" 1
  checks 2 "test${tab}https://example.test/b" 1
  stack_pr feat/b 'OPEN -' 0
  review_fixture 1 "### a:3 by one
https://example.test/a
first
"
  review_fixture 2 ''
}

fresh scenario
standard_fixtures
actual=$(sh "$script_dir/below.sh" Proj feat/b) || fail "below failed: $(cat "$tmp/err")"
expected=$(printf 'layer\t1\tfeat/a\t1\nfail\tfeat/a\tlint\thttps://example.test/a\nlayer\t2\tfeat/b\t2\nfail\tfeat/b\ttest\thttps://example.test/b')
[ "$actual" = "$expected" ] || fail "below printed '$actual'"
sh "$script_dir/../../playbook/scripts/review-read.sh" 1 > "$tmp/review-1"
git checkout --quiet feat/a
printf 'fixed\n' >> a
sh "$script_dir/../../playbook/scripts/fix-round.sh" -P Proj -m 'fix: guard empty input' a > "$tmp/fix"
sh "$script_dir/../../playbook/scripts/review-read.sh" 2 > "$tmp/review-2"
git checkout --quiet main
actual=$(sh "$script_dir/stack-base.sh" --cut Proj 3) || fail "stack base failed: $(cat "$tmp/err")"
[ "$actual" = feat/b ] || fail "stack base printed '$actual'"
[ "$(git --git-dir="$origin" rev-parse feat/a)" = "$(git rev-parse feat/a)" ] || fail 'a was not pushed'
[ "$(git log -1 --format=%s feat/a)" = 'fix: guard empty input' ] || fail 'a has the wrong subject'
[ "$(git --git-dir="$origin" rev-parse feat/b)" = "$(git rev-parse feat/b)" ] || fail 'b was not pushed'
git merge-base --is-ancestor feat/a feat/b || fail 'a is not an ancestor of b'
[ "$(git branch --show-current)" = feat/new ] || fail 'new is not checked out'
[ "$(git config branch.feat/new.skills-base)" = feat/b ] || fail 'new has the wrong base'
[ "$(git rev-parse HEAD)" = "$(git rev-parse feat/b)" ] || fail 'new does not start at b'
first_push=$(grep -n '^push ' "$GH_STUB_LOG" | sed -n '1s/:.*//p')
[ -n "$first_push" ] || fail 'no push was logged'
awk -v first="$first_push" 'NR >= first && /^pr checks / { exit 1 }' "$GH_STUB_LOG" || fail 'checks ran after a push'
push_a=$(grep -n '^push refs/heads/feat/a$' "$GH_STUB_LOG" | sed -n '1s/:.*//p')
push_b=$(grep -n '^push refs/heads/feat/b$' "$GH_STUB_LOG" | sed -n '1s/:.*//p')
[ -n "$push_a" ] && [ -n "$push_b" ] && [ "$push_a" -lt "$push_b" ] || fail 'push order is wrong'
! grep -Fq -- --watch "$GH_STUB_LOG" || fail 'watch was used'
! grep -Eq '^(pr (comment|review|merge|close|edit|ready)|issue comment)|graphql| -X | --method | -f | -F | --field | --raw-field |resolve' "$GH_STUB_LOG" || fail 'a mutating API was used'

fresh trunk
standard_fixtures
before=$(wc -l < "$GH_STUB_LOG")
actual=$(sh "$script_dir/below.sh" Proj origin/main) || fail 'origin main failed'
[ -z "$actual" ] || fail 'origin main printed output'
[ "$(wc -l < "$GH_STUB_LOG")" = "$before" ] || fail 'origin main logged a call'

fresh merged
pr_list feat/a 'MERGED 5' 0
pr_list feat/b 'OPEN 2' 0
checks 2 '' 8
actual=$(sh "$script_dir/below.sh" Proj feat/b) || fail 'merged layer failed'
[ "$actual" = "layer${tab}2${tab}feat/b${tab}2" ] || fail 'merged layer was not skipped'

fresh unowned
expect_refusal 'below: feat/unowned is not an owned branch' sh "$script_dir/below.sh" Proj feat/unowned

fresh closed
pr_list feat/a 'CLOSED 7' 0
expect_refusal 'below: PR for feat/a was closed without merging' sh "$script_dir/below.sh" Proj feat/a

fresh empty
pr_list feat/a '' 0
expect_refusal 'below: feat/a has no PR' sh "$script_dir/below.sh" Proj feat/a

fresh checks-failed
pr_list feat/a 'OPEN 1' 0
checks 1 '' 1
expect_refusal 'below: gh pr checks failed for feat/a' sh "$script_dir/below.sh" Proj feat/a

fresh checks-eight
pr_list feat/a 'OPEN 1' 0
checks 1 '' 8
actual=$(sh "$script_dir/below.sh" Proj feat/a) || fail 'checks exit 8 failed'
[ "$actual" = "layer${tab}1${tab}feat/a${tab}1" ] || fail 'checks exit 8 printed failures'

fresh cycle
git config branch.feat/a.skills-base feat/b
git config branch.feat/b.skills-base feat/a
actual=$(sh "$script_dir/chain.sh" feat/a)
[ "$actual" = "feat/b
feat/a" ] || fail "cycle printed '$actual'"

echo ok
