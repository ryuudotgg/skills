#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/playbook-lease-rebase.XXXXXX")
trap 'rm -rf "$tmp"' 0

export SKILLS_CONF="$tmp/skills.conf"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true

printf 'DELIVERY=prs\n' > "$SKILLS_CONF"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

fresh() {
  case_name=$1
  origin=$tmp/$case_name.git
  printf 'DELIVERY=prs\n' > "$SKILLS_CONF"
  git init --quiet --bare -b main "$origin"
  git clone --quiet "$origin" "$tmp/$case_name" 2>/dev/null
  cd "$tmp/$case_name"
  git config commit.gpgsign false
  git config core.hooksPath "$tmp/$case_name/.git/hooks"
  printf '%s\n' "${2:-base}" > shared
  git add -- shared
  git commit --quiet -m 'chore: initial files'
  git push --quiet origin main
  initial=$(git rev-parse HEAD)
  git checkout --quiet -b a
  printf 'a\n' > a
  git add -- a
  git commit --quiet -m 'feat: a'
  git push --quiet origin a
  old_a=$(git rev-parse a)
  original=main
}

stack() {
  git checkout --quiet -b b
  printf 'b\n' > shared
  git add -- shared
  git commit --quiet -m 'feat: b'
  git push --quiet origin b
  old_b=$(git rev-parse b)
  git checkout --quiet -b c
  printf 'c\n' > c
  git add -- c
  git commit --quiet -m 'feat: c'
  git push --quiet origin c
  old_c=$(git rev-parse c)
  git checkout --quiet "$original"
}

fix_parent() {
  git checkout --quiet a
  printf 'fix\n' >> a
  git add -- a
  git commit --quiet -m 'fix: a'
  git push --quiet origin a
  git checkout --quiet "$original"
}

expect_restored() {
  [ "$(git symbolic-ref --quiet --short HEAD)" = "$original" ] \
    || fail 'original branch was not restored'
  [ ! -d "$(git rev-parse --git-path rebase-merge)" ] || fail 'rebase still in progress'
  [ ! -d "$(git rev-parse --git-path rebase-apply)" ] || fail 'rebase still in progress'
}

expect_clean() {
  expect_restored
  [ -z "$(git status --porcelain)" ] || fail 'tree is not clean'
}

expect_tip() {
  [ "$(git rev-parse "refs/heads/$1")" = "$2" ] || fail "local $1 changed unexpectedly"
  [ "$(git --git-dir="$origin" rev-parse "refs/heads/$1")" = "$3" ] \
    || fail "remote $1 changed unexpectedly"
}

expect_rebased() {
  tip=$(git rev-parse "refs/heads/$1")
  [ "$tip" != "$2" ] || fail "$1 was not rebased"
  expect_tip "$1" "$tip" "$tip"
  [ "$(git rev-parse "$1~$4")" = "$(git rev-parse "$3")" ] \
    || fail "$1 has the wrong parent"
}

rebase_stack() {
  if sh "$script_dir/lease-rebase.sh" "$@" > "$tmp/out" 2> "$tmp/err"; then
    :
  else
    status=$?
    fail "rebase exited $status: $(cat "$tmp/err")"
  fi

  expect_clean
}

refusal() {
  reason=$1
  shift
  if sh "$script_dir/lease-rebase.sh" "$@" > "$tmp/out" 2> "$tmp/err"; then
    fail "succeeded, expected refusal: $reason"
  else
    status=$?
    [ "$status" -eq 1 ] || fail "refusal exited $status instead of 1"
  fi

  grep -Fxq "lease-rebase: $reason" "$tmp/err" || fail "missing refusal: $reason: $(cat "$tmp/err")"
  expect_restored
}

expect_refusal() {
  local_before=$(git for-each-ref --format='%(refname) %(objectname)' refs/heads/)
  remote_before=$(git --git-dir="$origin" for-each-ref --format='%(refname) %(objectname)' refs/heads/)
  tree_before=$(git status --porcelain)
  refusal "$@"
  [ ! -s "$tmp/out" ] || fail 'refusal printed stdout'
  [ "$(git for-each-ref --format='%(refname) %(objectname)' refs/heads/)" = "$local_before" ] \
    || fail 'refusal changed local branches'
  [ "$(git --git-dir="$origin" for-each-ref --format='%(refname) %(objectname)' refs/heads/)" = "$remote_before" ] \
    || fail 'refusal changed remote branches'
  [ "$(git status --porcelain)" = "$tree_before" ] || fail 'refusal changed the tree'
}

fresh chain
stack
fix_parent
new_a=$(git rev-parse a)
rebase_stack a "$old_a" b c
expect_rebased b "$old_b" a 1
expect_rebased c "$old_c" b 1
expect_tip a "$new_a" "$new_a"
[ "$(cat "$tmp/out")" = "$(printf '%s\n' "b $old_b $(git rev-parse b)" "c $old_c $(git rev-parse c)")" ] \
  || fail 'chain output differs'

fresh update_refs
stack
git config rebase.updateRefs true
git branch bystander "$old_b"
fix_parent
rebase_stack a "$old_a" b c
[ "$(git rev-parse bystander)" = "$old_b" ] || fail 'rebase moved an unlisted branch'

fresh on_listed_branch
stack
fix_parent
original=b
git checkout --quiet b
rebase_stack a "$old_a" b c
expect_rebased b "$old_b" a 1
expect_rebased c "$old_c" b 1

fresh untracked_collision
stack
fix_parent
printf 'stray\n' > c
expect_refusal 'dirty tree' a "$old_a" b c
rm c

fresh lease_race
stack
fix_parent
git clone --quiet "$origin" "$tmp/racer" 2>/dev/null
cat > .git/hooks/pre-push <<HOOK
#!/bin/sh
case \$(cat) in
  *refs/heads/c*)
    cd "$tmp/racer"
    git checkout --quiet c
    printf 'race\\n' >> c
    git commit --quiet -am 'fix: race'
    git push --quiet origin c
    ;;
esac
HOOK
chmod +x .git/hooks/pre-push
refusal "lease push rejected for c, reset to $old_c" a "$old_a" b c
raced=$(git -C "$tmp/racer" rev-parse c)
expect_tip c "$old_c" "$raced"
grep -q "^b $old_b " "$tmp/out" || fail 'finished layer b was not reported'

fresh context "$(printf 'context\none\ntwo\nbase\nfour\nfive\nsix')"
git checkout --quiet -b b
printf 'context\none\ntwo\nb first\nfour\nfive\nsix\n' > shared
git add -- shared
git commit --quiet -m 'feat: first b change'
printf 'context\none\ntwo\nb second\nfour\nfive\nsix\n' > shared
git add -- shared
git commit --quiet -m 'feat: second b change'
git push --quiet origin b
old_b=$(git rev-parse b)
git checkout --quiet -b c
printf 'c\n' > c
git add -- c
git commit --quiet -m 'feat: c'
git push --quiet origin c
old_c=$(git rev-parse c)
git checkout --quiet a
printf 'fixed context\none\ntwo\nbase\nfour\nfive\nsix\n' > shared
git add -- shared
git commit --quiet -m 'fix: b context'
git push --quiet origin a
git rebase --quiet --onto a "$old_a" b > "$tmp/plain-out" 2> "$tmp/plain-err" \
  || fail "context fixture could not rebase b: $(cat "$tmp/plain-err")"
if git rebase --quiet b c > "$tmp/plain-out" 2> "$tmp/plain-err"; then
  fail 'plain rebase did not conflict'
fi

git rebase --abort > "$tmp/plain-out" 2> "$tmp/plain-err"
git checkout --quiet b
git reset --quiet --hard "$old_b"
git checkout --quiet "$original"
rebase_stack a "$old_a" b c
expect_rebased b "$old_b" a 2
expect_rebased c "$old_c" b 1
[ "$(git show c:shared)" = "$(printf 'fixed context\none\ntwo\nb second\nfour\nfive\nsix')" ] \
  || fail 'context fix was lost'
[ "$(cat "$tmp/out")" = "$(printf '%s\n' "b $old_b $(git rev-parse b)" "c $old_c $(git rev-parse c)")" ] \
  || fail 'context output differs'

fresh squash
stack
git merge --quiet --squash a > "$tmp/merge-out" 2> "$tmp/merge-err"
git commit --quiet -m 'feat: squash a'
git push --quiet origin main
git fetch --quiet origin
new_main=$(git rev-parse origin/main)
rebase_stack origin/main "$old_a" b
expect_rebased b "$old_b" origin/main 1
expect_tip main "$new_main" "$new_main"
if git merge-base --is-ancestor "$old_a" b; then
  fail 'squash retained the original a commit'
fi

[ "$(cat "$tmp/out")" = "b $old_b $(git rev-parse b)" ] || fail 'squash output differs'

fresh conflict
stack
git checkout --quiet a
printf 'conflicting fix\n' > shared
git add -- shared
git commit --quiet -m 'fix: shared line'
git push --quiet origin a
git checkout --quiet "$original"
expect_refusal 'rebase conflict on b onto a' a "$old_a" b
expect_tip b "$old_b" "$old_b"
expect_clean

fresh remote-ahead
stack
fix_parent
git clone --quiet "$origin" "$tmp/operator"
git -C "$tmp/operator" checkout --quiet b
printf 'operator\n' > "$tmp/operator/operator"
git -C "$tmp/operator" add -- operator
git -C "$tmp/operator" commit --quiet -m 'feat: operator change'
git -C "$tmp/operator" push --quiet origin b
remote_b=$(git -C "$tmp/operator" rev-parse b)
expect_refusal 'origin/b has commits b lacks' a "$old_a" b c
expect_tip b "$old_b" "$remote_b"
expect_clean

fresh hands-off
stack
printf 'DELIVERY=hands-off\n' > "$SKILLS_CONF"
expect_refusal 'delivery mode is not prs' a "$old_a" b
expect_clean

fresh trunk
stack
fix_parent
expect_refusal 'cannot rebase the default branch main' a "$old_a" b main
expect_clean

fresh dirty
stack
printf 'dirty\n' >> shared
expect_refusal 'dirty tree' a "$old_a" b
[ "$(cat shared)" = "$(printf 'base\ndirty')" ] || fail 'dirty edit was lost'
git checkout -- shared
expect_clean

fresh unpublished
stack
fix_parent
git branch unpublished c
expect_refusal 'unpublished is not on origin' a "$old_a" b unpublished
expect_clean

fresh worktree
stack
fix_parent
other=$tmp/other-worktree
git worktree add --quiet "$other" c
other=$(CDPATH= cd "$other" && pwd -P)
expect_refusal "c is checked out in $other" a "$old_a" b c
[ -z "$(git -C "$other" status --porcelain)" ] || fail 'other worktree changed'
expect_clean

fresh partial
git checkout --quiet -b b
printf 'b\n' > b
git add -- b
git commit --quiet -m 'feat: b'
git push --quiet origin b
old_b=$(git rev-parse b)
git checkout --quiet -b c
printf 'c\n' > shared
git add -- shared
git commit --quiet -m 'feat: c'
git push --quiet origin c
old_c=$(git rev-parse c)
git checkout --quiet a
printf 'conflicting fix\n' > shared
git add -- shared
git commit --quiet -m 'fix: shared line'
git push --quiet origin a
git checkout --quiet "$original"
refusal 'rebase conflict on c onto b' a "$old_a" b c
expect_rebased b "$old_b" a 1
expect_tip c "$old_c" "$old_c"
[ "$(cat "$tmp/out")" = "b $old_b $(git rev-parse b)" ] || fail 'completed layer was not reported'
expect_clean

echo ok
