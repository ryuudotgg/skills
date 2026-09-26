#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
stub_bin=$(CDPATH= cd "$script_dir/../../../scripts/stubs" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/playbook-review-round.XXXXXX")
trap 'rm -rf "$tmp"' 0

export GH_STUB_DIR="$tmp/gh" GH_STUB_LOG="$tmp/gh.log" SKILLS_CONF="$tmp/skills.conf"
export PLANS_DIR="$tmp/plans" GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
PATH="$stub_bin:$PATH"
export PATH

mkdir -p "$GH_STUB_DIR" "$PLANS_DIR"
: > "$GH_STUB_LOG"
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

review_fixture() {
  marker='###'
  fixture "$marker a:3 by one
https://example/a
first

$marker b:file by two
https://example/b
second
" 0 api 'repos/{owner}/{repo}/pulls/12/comments' --paginate --jq '.[] | "### \(.path):\(.line // .original_line // "file") by \(.user.login)\n\(.html_url)\n\(.body)\n"'
  fixture 'intro
Comments Outside Diff
This is outside.
' 0 pr view 12 --json body --jq .body
  fixture '' 0 pr view 12 --json reviews --jq '.reviews[] | select(.body != "") | "### review by \(.author.login), \(.state)\n\(.body)\n"'
  fixture "$marker comment by three
https://example/c
reply
" 0 pr view 12 --json comments --jq '.comments[] | "### comment by \(.author.login)\n\(.url)\n\(.body)\n"'
}

review_fixture
sh "$script_dir/review-read.sh" 12 > "$tmp/out"
headers=$(grep '^==' "$tmp/out")
[ "$headers" = "$(printf '== inline comments\n== PR body\n== reviews\n== PR comments\n== comments outside diff')" ] || fail 'review headers out of order'
grep -A1 '^== reviews$' "$tmp/out" | grep -Fxq empty || fail 'missing empty reviews'
grep -Fxq 'found in: PR body' "$tmp/out" || fail 'missing outside source'
grep -Fxq 'This is outside.' "$tmp/out" || fail 'missing outside block'
[ "$(cat "$GH_STUB_LOG")" = "$(printf '%s\n%s\n%s\n%s' \
  'api repos/{owner}/{repo}/pulls/12/comments --paginate --jq .[] | "### \(.path):\(.line // .original_line // "file") by \(.user.login)\n\(.html_url)\n\(.body)\n"' \
  'pr view 12 --json body --jq .body' \
  'pr view 12 --json reviews --jq .reviews[] | select(.body != "") | "### review by \(.author.login), \(.state)\n\(.body)\n"' \
  'pr view 12 --json comments --jq .comments[] | "### comment by \(.author.login)\n\(.url)\n\(.body)\n"')" ] || fail 'review calls differ'

cat "$GH_STUB_LOG" >> "$tmp/all.log"
: > "$GH_STUB_LOG"
review_fixture
fixture '' 1 pr view 12 --json body --jq .body
expect_refusal 'review-read: gh failed reading PR body' sh "$script_dir/review-read.sh" 12
if sh "$script_dir/review-read.sh" x > "$tmp/out" 2> "$tmp/err"; then
  fail 'non numeric review number succeeded'
fi
[ "$(cat "$tmp/err" | sed -n '1p')" = 'usage: review-read.sh <pr number>' ] || fail 'non numeric did not use usage'

fresh() {
  name=$1
  origin=$tmp/$name.git
  repo=$tmp/$name
  rm -rf "$origin" "$repo" "$PLANS_DIR/Proj"
  git init --quiet --bare -b main "$origin"
  git clone --quiet "$origin" "$repo" 2>/dev/null
  cd "$repo"
  git config commit.gpgsign false
  printf 'base\n' > shared
  printf 'a\n' > round
  git add -- shared round
  git commit --quiet -m 'chore: initial'
  git push --quiet origin main
  git checkout --quiet -b feat/a
  git config branch.feat/a.skills-base origin/main
  printf 'a1\n' > a
  git add -- a
  git commit --quiet -m 'feat: a'
  git push --quiet -u origin feat/a
  git checkout --quiet -b feat/b
  git config branch.feat/b.skills-base feat/a
  printf 'b1\n' > b
  git add -- b
  git commit --quiet -m 'feat: b'
  git push --quiet -u origin feat/b
  git checkout --quiet -b feat/c
  git config branch.feat/c.skills-base feat/b
  printf 'c1\n' > c
  git add -- c
  git commit --quiet -m 'feat: c'
  git push --quiet -u origin feat/c
  git checkout --quiet feat/a
  mkdir -p "$PLANS_DIR/Proj"
  printf 'id\ta\tb\tc\td\te\tf\tbranch\n1\t-\t-\t-\t-\t-\t-\tfeat/a\n2\t-\t-\t-\t-\t-\t-\tfeat/b\n3\t-\t-\t-\t-\t-\t-\tfeat/c\n' > "$PLANS_DIR/Proj/index.tsv"
  cat "$GH_STUB_LOG" >> "$tmp/all.log"
  : > "$GH_STUB_LOG"
  printf 'DELIVERY=prs\n' > "$SKILLS_CONF"
}

run_round() {
  sh "$script_dir/fix-round.sh" -P Proj -m 'fix: guard empty input' round
}

fresh happy
old_a=$(git rev-parse feat/a)
printf 'round change\n' >> round
run_round > "$tmp/out" 2> "$tmp/err" || fail "happy failed: $(cat "$tmp/err")"
[ "$(git --git-dir="$origin" rev-parse feat/a)" = "$(git rev-parse feat/a)" ] || fail 'a not pushed'
[ "$(git --git-dir="$origin" rev-parse feat/b)" = "$(git rev-parse feat/b)" ] || fail 'b not pushed'
[ "$(git --git-dir="$origin" rev-parse feat/c)" = "$(git rev-parse feat/c)" ] || fail 'c not pushed'
[ "$(git rev-parse feat/a^)" = "$old_a" ] || fail 'a parent changed'
git merge-base --is-ancestor feat/a feat/b || fail 'a not below b'
git merge-base --is-ancestor feat/b feat/c || fail 'b not below c'
[ "$(git rev-list --count feat/a..feat/b)" = 1 ] || fail 'b has wrong count'
[ "$(git rev-list --count feat/b..feat/c)" = 1 ] || fail 'c has wrong count'
[ "$(git branch --show-current)" = feat/a ] || fail 'wrong final branch'
[ ! -s "$GH_STUB_LOG" ] || fail 'fix round called gh'

fresh hands-off
printf 'DELIVERY=hands-off\n' > "$SKILLS_CONF"
printf 'change\n' >> round
expect_refusal 'fix-round: delivery mode is not prs' run_round

fresh unowned-current
sed -i.bak '/feat\/a/d' "$PLANS_DIR/Proj/index.tsv"
rm "$PLANS_DIR/Proj/index.tsv.bak"
printf 'change\n' >> round
expect_refusal 'fix-round: feat/a is not an owned branch' run_round

fresh unowned-layer
sed -i.bak '/feat\/b/d' "$PLANS_DIR/Proj/index.tsv"
rm "$PLANS_DIR/Proj/index.tsv.bak"
printf 'change\n' >> round
expect_refusal 'fix-round: feat/b above feat/a is not an owned branch' run_round

fresh two-children
git branch feat/other feat/a
git config branch.feat/other.skills-base feat/a
printf 'change\n' >> round
expect_refusal 'fix-round: two layers above feat/a: feat/b feat/other' run_round

fresh nothing
expect_refusal 'fix-round: nothing to commit for this round' run_round

fresh staged
printf 'change\n' >> round
printf 'outside\n' > outside
git add -- outside
expect_refusal 'fix-round: already staged outside the file list: outside' run_round

fresh remote-layer
git checkout --quiet feat/b
git commit --quiet --allow-empty -m 'feat: remote b'
git push --quiet origin feat/b
git reset --quiet --hard HEAD^
git checkout --quiet feat/a
printf 'change\n' >> round
expect_refusal 'fix-round: origin/feat/b differs from feat/b, sync it first' run_round

fresh remote-current
git checkout --quiet feat/a
git commit --quiet --allow-empty -m 'feat: remote a'
git push --quiet origin feat/a
git reset --quiet --hard HEAD^
printf 'change\n' >> round
expect_refusal 'fix-round: origin/feat/a has commits feat/a lacks' run_round

fresh conflict
git checkout --quiet feat/b
printf 'b change\n' >> round
git add -- round
git commit --quiet -m 'feat: b edits round'
git push --quiet origin feat/b
git checkout --quiet feat/a
old_b=$(git rev-parse feat/b)
printf 'a change\n' >> round
expect_refusal 'fix-round: rebase conflict on feat/b, the round is pushed on feat/a, feat/b and every layer above it are untouched' run_round
[ "$(git --git-dir="$origin" rev-parse feat/b)" = "$old_b" ] || fail 'conflicting layer moved'
[ ! -d .git/rebase-merge ] && [ ! -d .git/rebase-apply ] || fail 'rebase remains'
[ "$(git branch --show-current)" = feat/a ] || fail 'conflict left wrong branch'
[ -z "$(git status --porcelain)" ] || fail 'conflict left dirty tree'

fresh upper-conflict
git checkout --quiet feat/c
printf 'c change\n' >> round
git add -- round
git commit --quiet -m 'feat: c edits round'
git push --quiet origin feat/c
git checkout --quiet feat/a
old_c=$(git rev-parse feat/c)
printf 'a change\n' >> round
expect_refusal 'fix-round: rebase conflict on feat/c, the round is pushed on feat/a, feat/c and every layer above it are untouched' run_round
[ "$(git --git-dir="$origin" rev-parse feat/b)" = "$(git rev-parse feat/b)" ] || fail 'layer below conflict not pushed'
git merge-base --is-ancestor feat/a feat/b || fail 'layer below conflict not rebased'
[ "$(git --git-dir="$origin" rev-parse feat/c)" = "$old_c" ] || fail 'conflicting upper layer moved'
[ "$(git branch --show-current)" = feat/a ] || fail 'upper conflict left wrong branch'

fresh deletion
git rm --quiet -- a
run_round_files() {
  sh "$script_dir/fix-round.sh" -P Proj -m 'fix: drop stale file' "$@"
}
run_round_files a > "$tmp/out" 2> "$tmp/err" || fail "deletion failed: $(cat "$tmp/err")"
git --git-dir="$origin" cat-file -e feat/a:a 2>/dev/null && fail 'deletion not pushed'
[ "$(git --git-dir="$origin" rev-parse feat/c)" = "$(git rev-parse feat/c)" ] || fail 'deletion did not rebase c'

fresh unreadable-remote
real_git=$(command -v git)
mkdir -p "$tmp/flaky-bin"
cat > "$tmp/flaky-bin/git" <<SH
#!/bin/sh
[ "\$1 \$2" = 'ls-remote --exit-code' ] && exit 128
exec "$real_git" "\$@"
SH
chmod 755 "$tmp/flaky-bin/git"
printf 'change\n' >> round
expect_refusal 'fix-round: cannot read origin/feat/a' env PATH="$tmp/flaky-bin:$PATH" sh "$script_dir/fix-round.sh" -P Proj -m 'fix: guard empty input' round

fresh unpublished
git branch -D --quiet feat/c
git checkout --quiet -b feat/d feat/a
git config branch.feat/b.skills-base feat/d
printf '4\t-\t-\t-\t-\t-\t-\tfeat/d\n' >> "$PLANS_DIR/Proj/index.tsv"
printf 'change\n' >> round
sh "$script_dir/fix-round.sh" -P Proj -m 'fix: guard empty input' round > "$tmp/out" 2> "$tmp/err" \
  && fail 'unpublished branch succeeded'
grep -Fq 'fix-round: origin has no feat/d, publish it first' "$tmp/err" || fail "missing refusal: $(cat "$tmp/err")"

fresh held-layer
old_origin_a=$(git --git-dir="$origin" rev-parse feat/a)
git worktree add --quiet "$tmp/held" feat/b
held=$(git worktree list --porcelain | awk '
  /^worktree / { path = substr($0, 10) }
  /^branch refs\/heads\/feat\/b$/ { print path; exit }
')
printf 'change\n' >> round
expect_refusal "fix-round: feat/b is checked out in $held" run_round
[ "$(git --git-dir="$origin" rev-parse feat/a)" = "$old_origin_a" ] || fail 'held layer pushed a'
git worktree remove --force "$tmp/held"

fresh doing-layer
old_origin_a=$(git --git-dir="$origin" rev-parse feat/a)
sed -i.bak 's/^3\t-\t-\t-/3\t-\tDOING\t-/' "$PLANS_DIR/Proj/index.tsv"
rm "$PLANS_DIR/Proj/index.tsv.bak"
printf 'change\n' >> round
expect_refusal 'fix-round: row 3 is DOING on feat/c' run_round
[ "$(git --git-dir="$origin" rev-parse feat/a)" = "$old_origin_a" ] || fail 'doing layer pushed a'

cat "$GH_STUB_LOG" >> "$tmp/all.log"
if grep -Eq '^(pr (comment|review|close|merge|edit)|issue comment|api .*(-X|--method|-f |-F |--field|--raw-field|graphql))' "$tmp/all.log"; then
  fail 'review action used gh'
fi

echo ok
