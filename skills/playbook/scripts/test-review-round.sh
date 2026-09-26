#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
stub_bin=$(CDPATH= cd "$script_dir/../../../scripts/stubs" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/playbook-review-round.XXXXXX")
trap 'rm -rf "$tmp"' 0

export GH_STUB_DIR="$tmp/gh" GH_STUB_LOG="$tmp/gh.log" SKILLS_CONF="$tmp/skills.conf"
export PLANS_DIR="$tmp/plans" GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true
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
  else
    status=$?
    [ "$status" -eq 1 ] || fail "refusal exited $status instead of 1"
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
  held=
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

snapshot_branches() {
  local_before=$(git for-each-ref --format='%(refname) %(objectname)' refs/heads/)
  remote_before=$(git --git-dir="$origin" for-each-ref --format='%(refname) %(objectname)' refs/heads/)
  caller_before=$(git status --porcelain)
}

expect_branches_unchanged() {
  [ "$(git for-each-ref --format='%(refname) %(objectname)' refs/heads/)" = "$local_before" ] \
    || fail 'refusal changed local branches'
  [ "$(git --git-dir="$origin" for-each-ref --format='%(refname) %(objectname)' refs/heads/)" = "$remote_before" ] \
    || fail 'refusal changed remote branches'
  [ "$(git status --porcelain)" = "$caller_before" ] || fail 'refusal changed caller files'
  [ "$(git branch --show-current)" = feat/a ] || fail 'refusal changed caller branch'
}

snapshot_holder() {
  holder_head=$(git -C "$held" rev-parse HEAD)
  holder_tree=$(git -C "$held" status --porcelain)
}

expect_holder_unchanged() {
  [ "$(git -C "$held" rev-parse HEAD)" = "$holder_head" ] || fail 'holder HEAD moved'
  [ "$(git -C "$held" status --porcelain)" = "$holder_tree" ] || fail 'holder files changed'
}

expect_upper_unchanged() {
  [ "$(git rev-parse feat/b)" = "$old_b" ] || fail 'local b moved'
  [ "$(git rev-parse feat/c)" = "$old_c" ] || fail 'local c moved'
  [ "$(git --git-dir="$origin" rev-parse feat/b)" = "$old_b" ] || fail 'origin b moved'
  [ "$(git --git-dir="$origin" rev-parse feat/c)" = "$old_c" ] || fail 'origin c moved'
  [ "$(git --git-dir="$origin" rev-parse feat/a)" = "$(git rev-parse feat/a)" ] || fail 'fixed branch not pushed'
  [ "$(git branch --show-current)" = feat/a ] || fail 'caller branch changed'
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
reason='fix-round: rebase conflict on feat/b onto feat/a, row 2 of Proj, held by no checkout, the round is pushed on feat/a, every layer above it is untouched'
expect_refusal "$reason" run_round
grep -Fxq "$reason" "$tmp/err" || fail 'conflict refusal differs'
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
old_b=$(git rev-parse feat/b)
old_c=$(git rev-parse feat/c)
git worktree add --quiet "$tmp/held-conflict" feat/c
held=$(CDPATH= cd "$tmp/held-conflict" && pwd -P)
snapshot_holder
printf 'a change\n' >> round
reason='fix-round: rebase conflict on feat/c onto feat/b, restack feat/b first, row 2 of Proj, held by no checkout, the round is pushed on feat/a, every layer above it is untouched'
expect_refusal "$reason" run_round
grep -Fxq "$reason" "$tmp/err" || fail 'upper conflict refusal differs'
[ "$(git --git-dir="$origin" rev-parse feat/a)" = "$(git rev-parse feat/a)" ] || fail 'fixed branch not pushed'
[ "$(git --git-dir="$origin" rev-parse feat/b)" = "$old_b" ] || fail 'middle origin moved'
[ "$(git rev-parse feat/b)" = "$old_b" ] || fail 'middle local moved'
[ "$(git rev-parse feat/c)" = "$old_c" ] || fail 'top local moved'
[ "$(git --git-dir="$origin" rev-parse feat/c)" = "$old_c" ] || fail 'conflicting upper layer moved'
[ "$(git branch --show-current)" = feat/a ] || fail 'upper conflict left wrong branch'

expect_holder_unchanged

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
old_b=$(git rev-parse feat/b)
git worktree add --quiet "$tmp/held" feat/b
held=$(CDPATH= cd "$tmp/held" && pwd -P)
printf 'stray\n' > "$held/untracked"
printf 'change\n' >> round
run_round > "$tmp/out" 2> "$tmp/err" || fail "held layer failed: $(cat "$tmp/err")"
new_b=$(git rev-parse feat/b)
[ "$new_b" != "$old_b" ] || fail 'held layer did not move'
[ "$(git -C "$held" rev-parse HEAD)" = "$new_b" ] || fail 'holder HEAD differs'
[ "$(git --git-dir="$origin" rev-parse feat/b)" = "$new_b" ] || fail 'held origin differs'
[ -z "$(git -C "$held" status --porcelain --untracked-files=no)" ] || fail 'holder is dirty'
[ "$(cat "$held/untracked")" = stray ] || fail 'untracked file changed'
[ "$(git branch --show-current)" = feat/a ] || fail 'held layer changed caller branch'
[ "$(git rev-parse feat/b^)" = "$(git rev-parse feat/a)" ] || fail 'held parent differs'

fresh doing-layer
old_origin_a=$(git --git-dir="$origin" rev-parse feat/a)
sed -i.bak 's/^3\t-\t-\t-/3\t-\tDOING\t-/' "$PLANS_DIR/Proj/index.tsv"
rm "$PLANS_DIR/Proj/index.tsv.bak"
printf 'change\n' >> round
expect_refusal 'fix-round: row 3 is DOING on feat/c' run_round
[ "$(git --git-dir="$origin" rev-parse feat/a)" = "$old_origin_a" ] || fail 'doing layer pushed a'

for busy in tracked rebase deleted doing; do
  fresh "busy-$busy"
  git worktree add --quiet "$tmp/held-$busy" feat/c
  held=$(CDPATH= cd "$tmp/held-$busy" && pwd -P)
  case $busy in
    tracked) printf 'dirty\n' >> "$held/c" ;;
    rebase)
      git -C "$held" rebase --exec false HEAD^ > "$tmp/rebase-out" 2> "$tmp/rebase-err" \
        && fail 'holder rebase did not pause'
      ;;
    deleted) rm -rf "$held" ;;
    doing)
      sed -i.bak 's/^3\t-\t-\t-/3\t-\tDOING\t-/' "$PLANS_DIR/Proj/index.tsv"
      rm "$PLANS_DIR/Proj/index.tsv.bak"
      ;;
  esac

  printf 'change\n' >> round
  snapshot_branches
  [ ! -d "$held" ] || snapshot_holder
  if [ "$busy" = doing ]; then
    SKILLS_OWN_ROWS=feat/c expect_refusal 'row 3 is DOING on feat/c' run_round
  else
    expect_refusal "$held" run_round
  fi

  expect_branches_unchanged
  [ ! -d "$held" ] || expect_holder_unchanged
done

for collision in untracked ignored ignored-dir; do
  fresh "holder-$collision"
  old_b=$(git rev-parse feat/b)
  old_c=$(git rev-parse feat/c)
  git worktree add --quiet "$tmp/collision-$collision" feat/c
  held=$(CDPATH= cd "$tmp/collision-$collision" && pwd -P)
  if [ "$collision" = ignored-dir ]; then
    mkdir "$held/incoming"
    printf 'stray\n' > "$held/incoming/private"
  else
    printf 'stray\n' > "$held/incoming"
  fi

  if [ "$collision" != untracked ]; then
    printf 'incoming\n' >> .git/info/exclude
  fi

  snapshot_holder
  printf 'incoming\n' > incoming
  printf 'change\n' >> round
  if [ "$collision" != untracked ]; then
    git add -f -- incoming
    reason="feat/c is held by $held and an ignored file sits where the move adds one"
  else
    reason="feat/c is held by $held and its files block the move"
  fi

  expect_refusal "$reason" run_round_files incoming round
  expect_upper_unchanged
  expect_holder_unchanged
done

fresh lease_race
old_b=$(git rev-parse feat/b)
old_c=$(git rev-parse feat/c)
git worktree add --quiet "$tmp/held-race" feat/c
held=$(CDPATH= cd "$tmp/held-race" && pwd -P)
snapshot_holder
git clone --quiet "$origin" "$tmp/racer" 2>/dev/null
cat > .git/hooks/pre-push <<HOOK
#!/bin/sh
case \$(cat) in
  *refs/heads/feat/c*)
    cd "$tmp/racer"
    git checkout --quiet feat/c
    printf 'race\\n' >> c
    git commit --quiet -am 'fix: race'
    git push --quiet origin feat/c
    ;;
esac
HOOK
chmod +x .git/hooks/pre-push
printf 'change\n' >> round
expect_refusal 'lease push rejected, the round is pushed on feat/a, every layer above it is untouched' run_round
[ "$(git rev-parse feat/b)" = "$old_b" ] || fail 'lease rejection moved local b'
[ "$(git rev-parse feat/c)" = "$old_c" ] || fail 'lease rejection moved local c'
[ "$(git --git-dir="$origin" rev-parse feat/b)" = "$old_b" ] || fail 'lease rejection moved remote b'
[ "$(git --git-dir="$origin" rev-parse feat/c)" = "$(git -C "$tmp/racer" rev-parse feat/c)" ] || fail 'raced tip changed'
[ "$(git --git-dir="$origin" rev-parse feat/a)" = "$(git rev-parse feat/a)" ] || fail 'fixed branch not pushed'
expect_holder_unchanged

fresh holder-busy-after-push
old_b=$(git rev-parse feat/b)
old_c=$(git rev-parse feat/c)
git worktree add --quiet "$tmp/held-after-push" feat/c
held=$(CDPATH= cd "$tmp/held-after-push" && pwd -P)
cat > .git/hooks/pre-push <<HOOK
#!/bin/sh
case \$(cat) in
  *refs/heads/feat/c*)
    if [ ! -f "$tmp/busy-hook-ran" ]; then
      printf 'busy\\n' >> "$held/c"
      touch "$tmp/busy-hook-ran"
    fi
    ;;
esac
HOOK
chmod +x .git/hooks/pre-push
printf 'change\n' >> round
if run_round > "$tmp/out" 2> "$tmp/err"; then
  fail 'holder made busy after push was moved'
else
  [ "$?" -eq 1 ] || fail 'busy move refusal did not exit 1'
fi

grep -Fq "cannot move feat/c: feat/c is held by $held with tracked changes" "$tmp/err" || fail 'missing busy move refusal'
[ "$(git rev-parse feat/b)" != "$old_b" ] || fail 'completed layer did not move'
[ "$(git rev-parse feat/b^)" = "$(git rev-parse feat/a)" ] || fail 'completed layer parent differs'
[ "$(git --git-dir="$origin" rev-parse feat/b)" = "$(git rev-parse feat/b)" ] || fail 'completed layer was rolled back'
[ "$(git rev-parse feat/c)" = "$old_c" ] || fail 'busy local layer moved'
[ "$(git --git-dir="$origin" rev-parse feat/c)" = "$old_c" ] || fail 'busy origin layer not rolled back'
[ "$(git -C "$held" rev-parse HEAD)" = "$old_c" ] || fail 'busy holder moved'
[ "$(cat "$held/c")" = "$(printf 'c1\nbusy')" ] || fail 'busy edit was lost'
grep -Fxq 'rebased feat/b and pushed' "$tmp/out" || fail 'completed layer was not reported'
if grep -q '^rebased feat/c' "$tmp/out"; then
  fail 'failed layer reported as moved'
fi

fresh no-ref-action
real_git=$(command -v git)
mkdir -p "$tmp/old-bin"
cat > "$tmp/old-bin/git" <<SH
#!/bin/sh
if [ "\$1 \$2" = 'replay -h' ]; then
  echo 'usage: git replay --onto <revision> <range>'
  exit 129
fi
exec "$real_git" "\$@"
SH
chmod 755 "$tmp/old-bin/git"
printf 'change\n' >> round
snapshot_branches
expect_refusal 'git replay lacks --ref-action' env PATH="$tmp/old-bin:$PATH" sh "$script_dir/fix-round.sh" -P Proj -m 'fix: guard empty input' round
expect_branches_unchanged

run_layer() {
  sh "$script_dir/restack-layer.sh" -P Proj "$@"
}

expect_layer_tip() {
  [ "$(git rev-parse "refs/heads/$1")" = "$2" ] || fail "local $1 differs"

  [ "$(git --git-dir="$origin" rev-parse "refs/heads/$1")" = "$3" ] || fail "origin $1 differs"

  [ ! -s "$GH_STUB_LOG" ] || fail 'restack layer called gh'
}

stale_b() {
  if [ "$1" = conflict ]; then
    git checkout --quiet feat/b

    printf 'b change\n' > round

    git add -- round

    git commit --quiet -m 'feat: b edits round'

    git push --quiet origin feat/b
  fi

  git checkout --quiet feat/a

  printf 'a change\n' > round

  git add -- round

  git commit --quiet -m 'fix: a edits round'

  git push --quiet origin feat/a

  old_b=$(git rev-parse feat/b)
  old_c=$(git rev-parse feat/c)

  git checkout --quiet feat/b
}

expect_layer_conflict() {
  expect_refusal "restack-layer: conflict rebasing $1 onto $2, resolve it here, git add, GIT_EDITOR=true git rebase --continue, run the standing checks, then restack-layer.sh --push" run_layer

  [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ] \
    || fail 'conflict left no rebase directory'

  [ "$(git config "branch.$1.skills-restack-lease")" = "$3" ] || fail 'conflict lease differs'
}

resolve_round() {
  printf '%s\n' "$1" > round

  git add -- round

  GIT_EDITOR=true git rebase --continue > "$tmp/continue-out" 2> "$tmp/continue-err" \
    || fail "continue failed: $(cat "$tmp/continue-err")"
}

expect_layer_pushed() {
  new_b=$(git rev-parse feat/b)
  [ "$new_b" != "$old_b" ] || fail 'b did not move'

  new_c=$(git rev-parse feat/c)
  [ "$new_c" != "$old_c" ] || fail 'c did not move'

  expect_layer_tip feat/b "$new_b" "$new_b"
  expect_layer_tip feat/c "$new_c" "$new_c"

  git merge-base --is-ancestor feat/a feat/b || fail 'b lacks a'

  git merge-base --is-ancestor feat/b feat/c || fail 'c lacks b'

  [ -z "$(git config branch.feat/b.skills-restack-lease || true)" ] || fail 'b lease remains'

  [ "$(cat "$tmp/out")" = "$(printf 'pushed feat/b\nrebased feat/c and pushed')" ] || fail 'push output differs'
}

fresh layer-conflict
stale_b conflict
expect_layer_conflict feat/b feat/a "$old_b"
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ -z "$(git symbolic-ref --quiet HEAD || true)" ] || fail 'conflict HEAD is attached'
expect_refusal 'restack-layer: unmerged paths in feat/b: round, resolve them, git add, then GIT_EDITOR=true git rebase --continue' run_layer
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
resolve_round "$(printf 'resolved\n%s HEAD\nkept marker' '<<<<<<<')"
rebased_b=$(git rev-parse feat/b)
expect_refusal 'restack-layer: conflict marker left in round' run_layer --push
expect_layer_tip feat/b "$rebased_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ "$(git config branch.feat/b.skills-restack-lease)" = "$old_b" ] || fail 'marker refusal lost lease'
printf 'resolved\n' > round
git add -- round
git commit --quiet -m 'fix: remove conflict marker'
run_layer --push > "$tmp/out" 2> "$tmp/err" || fail "resolved push failed: $(cat "$tmp/err")"
expect_layer_pushed
run_layer > "$tmp/out" 2> "$tmp/err"
[ "$(cat "$tmp/out")" = 'feat/b already sits on feat/a' ] || fail 'post push run differs'
expect_layer_tip feat/b "$new_b" "$new_b"
expect_layer_tip feat/c "$new_c" "$new_c"

fresh layer-origin-moved
stale_b conflict
expect_layer_conflict feat/b feat/a "$old_b"
resolve_round resolved
rebased_b=$(git rev-parse feat/b)
git clone --quiet "$origin" "$tmp/layer-racer" 2>/dev/null
git -C "$tmp/layer-racer" checkout --quiet feat/b
printf 'race\n' > "$tmp/layer-racer/race"
git -C "$tmp/layer-racer" add -- race
git -C "$tmp/layer-racer" commit --quiet -m 'fix: raced b'
git -C "$tmp/layer-racer" push --quiet origin feat/b
raced_b=$(git -C "$tmp/layer-racer" rev-parse feat/b)
expect_refusal 'restack-layer: origin/feat/b moved since the rebase began, nothing pushed; sync feat/b with origin, or drop the restack with git config --unset branch.feat/b.skills-restack-lease' run_layer --push
expect_layer_tip feat/b "$rebased_b" "$raced_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ "$(git config branch.feat/b.skills-restack-lease)" = "$old_b" ] || fail 'origin race lost lease'

fresh layer-clean
stale_b clean
expect_refusal 'restack-layer: feat/b is still stale on feat/a, run restack-layer.sh without --push' run_layer --push
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ -z "$(git config branch.feat/b.skills-restack-lease || true)" ] || fail 'stale push recorded lease'
run_layer > "$tmp/out" 2> "$tmp/err" || fail "clean rebase failed: $(cat "$tmp/err")"
[ "$(cat "$tmp/out")" = 'rebased feat/b onto feat/a, run the standing checks, then restack-layer.sh --push' ] || fail 'clean rebase output differs'
rebased_b=$(git rev-parse feat/b)
[ "$rebased_b" != "$old_b" ] || fail 'clean rebase did not move b'
expect_layer_tip feat/b "$rebased_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ "$(git config branch.feat/b.skills-restack-lease)" = "$old_b" ] || fail 'clean rebase lease differs'
run_layer > "$tmp/out" 2> "$tmp/err"
[ "$(cat "$tmp/out")" = 'feat/b is rebased, run the standing checks, then restack-layer.sh --push' ] || fail 'pending push output differs'
expect_layer_tip feat/b "$rebased_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
run_layer --push > "$tmp/out" 2> "$tmp/err" || fail "clean push failed: $(cat "$tmp/err")"
expect_layer_pushed

fresh layer-abort
stale_b conflict
expect_layer_conflict feat/b feat/a "$old_b"
git rebase --abort > "$tmp/abort-out" 2> "$tmp/abort-err"
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
expect_layer_conflict feat/b feat/a "$old_b"
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
git rebase --abort > "$tmp/abort-out" 2> "$tmp/abort-err"

fresh layer-base-moved
stale_b clean
run_layer > "$tmp/out" 2> "$tmp/err"
rebased_b=$(git rev-parse feat/b)
expect_layer_tip feat/b "$rebased_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
git checkout --quiet feat/a
printf 'another a change\n' >> a
git add -- a
git commit --quiet -m 'fix: a moves again'
git push --quiet origin feat/a
git checkout --quiet feat/b
expect_refusal 'restack-layer: feat/b is still stale on feat/a, run restack-layer.sh without --push' run_layer --push
expect_layer_tip feat/b "$rebased_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
run_layer > "$tmp/out" 2> "$tmp/err" || fail "second rebase failed: $(cat "$tmp/err")"
[ "$(git rev-parse feat/b)" != "$rebased_b" ] || fail 'second rebase did not move b'
expect_layer_tip feat/b "$(git rev-parse feat/b)" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ "$(git config branch.feat/b.skills-restack-lease)" = "$old_b" ] || fail 'second rebase changed lease'
run_layer --push > "$tmp/out" 2> "$tmp/err" || fail "second rebase push failed: $(cat "$tmp/err")"
expect_layer_pushed

fresh layer-current
git checkout --quiet feat/b
old_b=$(git rev-parse feat/b)
old_c=$(git rev-parse feat/c)
for option in '' --push; do
  run_layer $option > "$tmp/out" 2> "$tmp/err"
  [ "$(cat "$tmp/out")" = 'feat/b already sits on feat/a' ] || fail 'current layer output differs'
  expect_layer_tip feat/b "$old_b" "$old_b"
  expect_layer_tip feat/c "$old_c" "$old_c"
done

printf 'dirty\n' >> b
sed -i.bak 's/^3\t-\t-\t-/3\t-\tDOING\t-/' "$PLANS_DIR/Proj/index.tsv"
for option in '' --push; do
  run_layer $option > "$tmp/out" 2> "$tmp/err"
  [ "$(cat "$tmp/out")" = 'feat/b already sits on feat/a' ] || fail 'current dirty layer output differs'
  expect_layer_tip feat/b "$old_b" "$old_b"
  expect_layer_tip feat/c "$old_c" "$old_c"
done

fresh layer-upper-conflict
git checkout --quiet feat/c
printf 'c change\n' >> round
git add -- round
git commit --quiet -m 'feat: c edits round'
git push --quiet origin feat/c
git checkout --quiet feat/a
old_b=$(git rev-parse feat/b)
old_c=$(git rev-parse feat/c)
git worktree add --quiet "$tmp/layer-held-c" feat/c
held=$(CDPATH= cd "$tmp/layer-held-c" && pwd -P)
snapshot_holder
printf 'a change\n' >> round
reason='fix-round: rebase conflict on feat/c onto feat/b, restack feat/b first, row 2 of Proj, held by no checkout, the round is pushed on feat/a, every layer above it is untouched'
expect_refusal "$reason" run_round
grep -Fxq "$reason" "$tmp/err" || fail 'upper conflict refusal differs'
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
expect_holder_unchanged
git checkout --quiet feat/b
run_layer > "$tmp/out" 2> "$tmp/err" || fail "middle rebase failed: $(cat "$tmp/err")"
rebased_b=$(git rev-parse feat/b)
expect_layer_tip feat/b "$rebased_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
reason="restack-layer: rebase conflict on feat/c onto feat/b, row 3 of Proj, held by $held, feat/b is pushed, every layer above it is untouched"
expect_refusal "$reason" run_layer --push
grep -Fxq "$reason" "$tmp/err" || fail 'held conflict refusal differs'
expect_layer_tip feat/b "$rebased_b" "$rebased_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ -z "$(git config branch.feat/b.skills-restack-lease || true)" ] || fail 'pushed middle lease remains'
expect_holder_unchanged
cd "$held"
expect_layer_conflict feat/c feat/b "$old_c"
expect_layer_tip feat/b "$rebased_b" "$rebased_b"
expect_layer_tip feat/c "$old_c" "$old_c"
resolve_round resolved
rebased_c=$(git rev-parse feat/c)
expect_layer_tip feat/c "$rebased_c" "$old_c"
run_layer --push > "$tmp/out" 2> "$tmp/err" || fail "held push failed: $(cat "$tmp/err")"
[ "$(cat "$tmp/out")" = 'pushed feat/c' ] || fail 'held push output differs'
expect_layer_tip feat/b "$rebased_b" "$rebased_b"
expect_layer_tip feat/c "$rebased_c" "$rebased_c"
git merge-base --is-ancestor feat/b feat/c || fail 'resolved c lacks b'
[ -z "$(git config branch.feat/c.skills-restack-lease || true)" ] || fail 'c lease remains'

fresh layer-no-update-refs
stale_b clean
git config rebase.updateRefs true
git branch bystander feat/b
run_layer > "$tmp/out" 2> "$tmp/err" || fail "rebase with updateRefs failed: $(cat "$tmp/err")"
[ "$(git rev-parse bystander)" = "$old_b" ] || fail 'rebase moved unowned bystander'
expect_layer_tip feat/b "$(git rev-parse feat/b)" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"

fresh layer-ignored-collision
printf 'parent file\n' > collision
git add -- collision
git commit --quiet -m 'feat: add collision'
git push --quiet origin feat/a
old_b=$(git rev-parse feat/b)
old_c=$(git rev-parse feat/c)
git checkout --quiet feat/b
printf 'collision\n' >> .git/info/exclude
printf 'private file\n' > collision
expect_refusal 'restack-layer: an ignored file in this checkout sits where the rebase adds one' run_layer
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ "$(cat collision)" = 'private file' ] || fail 'ignored collision was overwritten'
[ -z "$(git config branch.feat/b.skills-restack-lease || true)" ] || fail 'ignored collision recorded lease'
[ ! -d .git/rebase-merge ] && [ ! -d .git/rebase-apply ] || fail 'ignored collision started rebase'

fresh layer-binary-marker
git checkout --quiet feat/b
printf 'round -diff\n' > .gitattributes
git add -- .gitattributes
git commit --quiet -m 'chore: mark round binary'
git push --quiet origin feat/b
stale_b conflict
expect_layer_conflict feat/b feat/a "$old_b"
resolve_round "$(printf 'resolved\n%s HEAD\nretained' '<<<<<<<')"
rebased_b=$(git rev-parse feat/b)
expect_refusal 'restack-layer: conflict marker left in round' run_layer --push
[ "$(cat "$tmp/err")" = 'restack-layer: conflict marker left in round' ] || fail 'binary marker path differs'
expect_layer_tip feat/b "$rebased_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ "$(git config branch.feat/b.skills-restack-lease)" = "$old_b" ] || fail 'binary marker refusal lost lease'

fresh layer-readme-underline
stale_b clean
run_layer > "$tmp/out" 2> "$tmp/err"
printf 'Heading\n%s\n' '=======' > README
git add -- README
git commit --quiet -m 'docs: add readme'
run_layer --push > "$tmp/out" 2> "$tmp/err" || fail "readme underline refused: $(cat "$tmp/err")"
expect_layer_pushed

fresh layer-fork-point-missing
stale_b clean
git reflog expire --expire=all refs/heads/feat/a
[ -z "$(git merge-base --fork-point feat/a feat/b || true)" ] || fail 'fixture has a fork point'
expect_refusal 'restack-layer: cannot find where feat/b forked from feat/a' run_layer
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ -z "$(git config branch.feat/b.skills-restack-lease || true)" ] || fail 'failed fork point recorded lease'
[ "$(cat "$tmp/err")" = 'restack-layer: cannot find where feat/b forked from feat/a, pass --onto <parent> <old parent tip>' ] || fail 'missing fork recovery instruction'

fresh layer-rebase-hook-failure
stale_b clean
printf '#!/bin/sh\nexit 1\n' > .git/hooks/pre-rebase
chmod +x .git/hooks/pre-rebase
expect_refusal 'restack-layer: cannot rebase feat/b onto feat/a:' run_layer
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ ! -d .git/rebase-merge ] && [ ! -d .git/rebase-apply ] || fail 'hook failure left rebase directory'
[ -z "$(git config branch.feat/b.skills-restack-lease || true)" ] || fail 'hook failure retained new lease'
git config branch.feat/b.skills-restack-lease "$old_b"
expect_refusal 'restack-layer: cannot rebase feat/b onto feat/a:' run_layer
[ "$(git config branch.feat/b.skills-restack-lease)" = "$old_b" ] || fail 'hook failure removed existing lease'

fresh layer-abort-origin-synced
stale_b conflict
expect_layer_conflict feat/b feat/a "$old_b"
git rebase --abort > "$tmp/abort-out" 2> "$tmp/abort-err"
git clone --quiet "$origin" "$tmp/abort-racer" 2>/dev/null
git -C "$tmp/abort-racer" checkout --quiet feat/b
printf 'racer\n' > "$tmp/abort-racer/racer"
git -C "$tmp/abort-racer" add -- racer
git -C "$tmp/abort-racer" commit --quiet -m 'fix: raced after abort'
git -C "$tmp/abort-racer" push --quiet origin feat/b
raced_b=$(git -C "$tmp/abort-racer" rev-parse feat/b)
git fetch --quiet origin feat/b
git reset --quiet --hard "$raced_b"
expect_layer_conflict feat/b feat/a "$raced_b"
expect_layer_tip feat/b "$raced_b" "$raced_b"
expect_layer_tip feat/c "$old_c" "$old_c"
git rebase --abort > "$tmp/abort-out" 2> "$tmp/abort-err"

fresh layer-stale-origin-moved
stale_b clean
run_layer > "$tmp/out" 2> "$tmp/err"
rebased_b=$(git rev-parse feat/b)
git checkout --quiet feat/a
printf 'next\n' >> a
git commit --quiet -am 'fix: move parent again'
git push --quiet origin feat/a
git checkout --quiet feat/b
git clone --quiet "$origin" "$tmp/stale-racer" 2>/dev/null
git -C "$tmp/stale-racer" checkout --quiet feat/b
git -C "$tmp/stale-racer" commit --quiet --allow-empty -m 'fix: raced stale layer'
git -C "$tmp/stale-racer" push --quiet origin feat/b
raced_b=$(git -C "$tmp/stale-racer" rev-parse feat/b)
reason='restack-layer: origin/feat/b moved since the rebase began, nothing pushed; sync feat/b with origin, or drop the restack with git config --unset branch.feat/b.skills-restack-lease'
expect_refusal "$reason" run_layer
[ "$(cat "$tmp/err")" = "$reason" ] || fail 'stale moved origin refusal differs'
expect_layer_tip feat/b "$rebased_b" "$raced_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ "$(git config branch.feat/b.skills-restack-lease)" = "$old_b" ] || fail 'stale moved origin changed lease'

fresh layer-origin-fork-fallback
git checkout --quiet main
printf 'main change\n' > main-change
git add -- main-change
git commit --quiet -m 'feat: advance main'
git push --quiet origin main
git fetch --quiet origin main
git reflog expire --expire=all refs/remotes/origin/main
git checkout --quiet feat/b
git config branch.feat/b.skills-base origin/main
old_b=$(git rev-parse feat/b)
old_c=$(git rev-parse feat/c)
[ -z "$(git merge-base --fork-point origin/main feat/b || true)" ] || fail 'origin fixture has fork point'
run_layer > "$tmp/out" 2> "$tmp/err" || fail "origin fork fallback failed: $(cat "$tmp/err")"
git merge-base --is-ancestor origin/main feat/b || fail 'fallback rebase lacks main'
expect_layer_tip feat/b "$(git rev-parse feat/b)" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ "$(git config branch.feat/b.skills-restack-lease)" = "$old_b" ] || fail 'fallback lease differs'

fresh layer-squash-recovery
git checkout --quiet feat/b
printf 'b change\n' > round
git commit --quiet -am 'feat: b edits round'
git push --quiet origin feat/b
old_a=$(git rev-parse feat/a)
old_b=$(git rev-parse feat/b)
old_c=$(git rev-parse feat/c)
git checkout --quiet main
git merge --squash feat/a > "$tmp/squash-out"
printf 'squashed parent\n' > round
git add -- round
git commit --quiet -m 'feat: squash a'
git push --quiet origin main
git worktree add --quiet "$tmp/squash-held-b" feat/b
held=$(CDPATH= cd "$tmp/squash-held-b" && pwd -P)
snapshot_holder
reason="lease-rebase: rebase conflict on feat/b onto origin/main, row 2 of Proj, held by $held, then restack-layer.sh --onto origin/main $old_a"
expect_refusal "$reason" sh "$script_dir/lease-rebase.sh" origin/main "$old_a" feat/b feat/c
[ "$(cat "$tmp/err")" = "$reason" ] || fail 'squash recovery instruction differs'
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
expect_holder_unchanged
git update-ref refs/remotes/origin/main "$(git rev-parse main^)"
cd "$held"
expect_refusal 'restack-layer: conflict rebasing feat/b onto origin/main, resolve it here, git add, GIT_EDITOR=true git rebase --continue, run the standing checks, then restack-layer.sh --push' run_layer --onto origin/main "$old_a"
[ "$(git rev-parse origin/main)" = "$(git --git-dir="$origin" rev-parse main)" ] || fail 'squash recovery did not fetch parent'
[ "$(git config branch.feat/b.skills-restack-onto)" = "origin/main $old_a" ] || fail 'squash recovery not recorded'
[ "$(git config branch.feat/b.skills-restack-lease)" = "$old_b" ] || fail 'squash lease differs'
[ "$(git config branch.feat/b.skills-base)" = feat/a ] || fail 'conflict changed recorded base'
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
expect_refusal 'restack-layer: unmerged paths in feat/b: round' run_layer
resolve_round resolved
rebased_b=$(git rev-parse feat/b)
expect_refusal 'restack-layer: --onto conflicts with the recorded restack' run_layer --onto feat/a "$old_a"
expect_layer_tip feat/b "$rebased_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
run_layer > "$tmp/out" 2> "$tmp/err" || fail "saved squash recovery failed: $(cat "$tmp/err")"
[ "$(cat "$tmp/out")" = 'feat/b is rebased, run the standing checks, then restack-layer.sh --push' ] || fail 'saved squash recovery output differs'
run_layer --push > "$tmp/out" 2> "$tmp/err" || fail "squash recovery push failed: $(cat "$tmp/err")"
[ "$(cat "$tmp/out")" = "$(printf 'pushed feat/b\nrebased feat/c and pushed')" ] || fail 'squash push output differs'
expect_layer_tip feat/b "$rebased_b" "$rebased_b"
expect_layer_tip feat/c "$(git rev-parse feat/c)" "$(git rev-parse feat/c)"
[ "$(git rev-parse feat/c)" != "$old_c" ] || fail 'squash recovery did not restack c'
git merge-base --is-ancestor origin/main feat/b || fail 'squash recovery lacks main'
git merge-base --is-ancestor feat/b feat/c || fail 'squash recovery c lacks b'
[ "$(git rev-list --count origin/main..feat/b)" = 2 ] || fail 'squash recovery replayed old parent commits'
[ "$(git config branch.feat/b.skills-base)" = origin/main ] || fail 'squash recovery base not saved'
[ -z "$(git config branch.feat/b.skills-restack-onto || true)" ] || fail 'squash recovery onto remains'
[ -z "$(git config branch.feat/b.skills-restack-lease || true)" ] || fail 'squash recovery lease remains'

fresh layer-onto-validation
stale_b clean
expect_refusal 'restack-layer: no such commit: missing-cutoff' run_layer --onto feat/a missing-cutoff
expect_refusal "restack-layer: $(git rev-parse feat/a) is not an ancestor of feat/b" run_layer --onto feat/a "$(git rev-parse feat/a)"
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ -z "$(git config branch.feat/b.skills-restack-lease || true)" ] || fail 'invalid cutoff recorded lease'
[ -z "$(git config branch.feat/b.skills-restack-onto || true)" ] || fail 'invalid cutoff recorded onto'

fresh layer-operation-guards
stale_b clean
for operation in MERGE_HEAD BISECT_LOG rebase-apply rebase-merge; do
  case $operation in
    rebase-apply)
      mkdir .git/rebase-apply
      reason='git am in progress'
      ;;

    rebase-merge)
      mkdir .git/rebase-merge
      reason='rebase in progress with no branch'
      ;;

    *)
      git rev-parse HEAD > ".git/$operation"
      reason="$operation in progress on feat/b"
      ;;
  esac

  expect_refusal "restack-layer: $reason" run_layer
  expect_layer_tip feat/b "$old_b" "$old_b"
  expect_layer_tip feat/c "$old_c" "$old_c"
  [ -z "$(git config branch.feat/b.skills-restack-lease || true)" ] || fail 'operation guard recorded lease'
  rm -rf ".git/$operation"
done

fresh layer-rebase-without-unmerged
stale_b conflict
expect_layer_conflict feat/b feat/a "$old_b"
printf 'resolved\n' > round
git add -- round
[ -z "$(git ls-files -u)" ] || fail 'resolved fixture has unmerged paths'
expect_refusal 'restack-layer: rebase of feat/b still in progress, finish it with GIT_EDITOR=true git rebase --continue' run_layer
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ "$(git config branch.feat/b.skills-restack-lease)" = "$old_b" ] || fail 'paused rebase lost lease'
git rebase --abort > "$tmp/abort-out" 2> "$tmp/abort-err"

fresh layer-active-row
stale_b conflict
git checkout --quiet feat/a
printf 'id\ta\tb\tc\td\te\tf\tbranch\n8\t-\tDONE\t-\t-\t-\t-\tfeat/b\n9\t-\tDROPPED\t-\t-\t-\t-\tfeat/b\n2\t-\tREVIEW\t-\t-\t-\t-\tfeat/b\n1\t-\tREVIEW\t-\t-\t-\t-\tfeat/a\n3\t-\tREVIEW\t-\t-\t-\t-\tfeat/c\n' > "$PLANS_DIR/Proj/index.tsv"
reason='lease-rebase: rebase conflict on feat/b onto feat/a, row 2 of Proj, held by no checkout'
expect_refusal "$reason" sh "$script_dir/lease-rebase.sh" feat/a "$(git merge-base feat/a feat/b)" feat/b feat/c
[ "$(cat "$tmp/err")" = "$reason" ] || fail 'restack selected inactive row'
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"

fresh layer-merge-push
stale_b clean
run_layer > "$tmp/out" 2> "$tmp/err"
git checkout --quiet -b merge-side
printf 'side\n' > side
git add -- side
git commit --quiet -m 'feat: side change'
git checkout --quiet feat/b
git merge --quiet --no-ff -m 'feat: merge side' merge-side
rebased_b=$(git rev-parse feat/b)
expect_refusal 'restack-layer: merge commit in feat/b, rebase it linear' run_layer --push
expect_layer_tip feat/b "$rebased_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ "$(git config branch.feat/b.skills-restack-lease)" = "$old_b" ] || fail 'merge refusal lost lease'

fresh layer-tracked-stale
stale_b clean
printf 'dirty\n' >> b
expect_refusal 'restack-layer: tracked changes' run_layer
expect_layer_tip feat/b "$old_b" "$old_b"
expect_layer_tip feat/c "$old_c" "$old_c"
[ "$(cat b)" = "$(printf 'b1\ndirty')" ] || fail 'tracked change lost'
[ -z "$(git config branch.feat/b.skills-restack-lease || true)" ] || fail 'tracked refusal recorded lease'

cat "$GH_STUB_LOG" >> "$tmp/all.log"
if grep -Eq '^(pr (comment|review|close|merge|edit)|issue comment|api .*(-X|--method|-f |-F |--field|--raw-field|graphql))' "$tmp/all.log"; then
  fail 'review action used gh'
fi

echo ok
