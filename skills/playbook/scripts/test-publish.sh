#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
stub_bin=$(CDPATH= cd "$script_dir/../../../scripts/stubs" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/playbook-publish.XXXXXX")
trap 'rm -rf "$tmp"' 0

export GH_STUB_DIR="$tmp/gh"
export GH_STUB_LOG="$tmp/gh.log"
export SKILLS_CONF="$tmp/skills.conf"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GH_STUB_BIN="$stub_bin"
PATH="$stub_bin:$PATH"
export PATH

mkdir -p "$GH_STUB_DIR" "$tmp/no-git" "$tmp/stack-bin"
printf 'DELIVERY=prs\n' > "$SKILLS_CONF"
: > "$GH_STUB_LOG"

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

prs() {
  fixture "$2" 0 pr list --head "$1" --state open --json url --jq '.[0].url // empty'
}

expect_refusal() {
  reason=$1
  shift
  if "$@" > "$tmp/out" 2> "$tmp/err"; then
    fail "succeeded, expected refusal: $reason"
  fi

  grep -Fq "publish: $reason" "$tmp/err" || fail "missing refusal: $reason: $(cat "$tmp/err")"
  [ ! -s "$tmp/out" ] || fail 'refusal printed stdout'
}

expect_call() {
  grep -Fxq -- "$*" "$GH_STUB_LOG" || fail "missing gh call: $*"
}

reject_call() {
  if grep -Eq "$1" "$GH_STUB_LOG"; then
    fail "unexpected gh call: $1"
  fi
}

publish() {
  if ! sh "$script_dir/publish.sh" "$@" > "$tmp/out" 2> "$tmp/err"; then
    fail "publish failed: $(cat "$tmp/err")"
  fi

  [ "$(cat "$tmp/out")" = "$url" ] || fail "unexpected stdout: $(cat "$tmp/out")"
}

fresh() {
  case_name=$1
  branch=feat/$case_name
  origin=$tmp/$case_name.git
  url=https://github.com/test/repo/pull/$case_name
  message="feat: $case_name"
  rm -f "$GH_STUB_DIR"/*
  : > "$GH_STUB_LOG"
  printf 'DELIVERY=prs\n' > "$SKILLS_CONF"
  git init --quiet --bare -b main "$origin"
  git clone --quiet "$origin" "$tmp/$case_name" 2>/dev/null
  cd "$tmp/$case_name"
  git config commit.gpgsign false
  git config core.hooksPath "$tmp/$case_name/.git/hooks"
  printf 'a\n' > a
  printf 'b\n' > b
  printf 'unrelated\n' > unrelated
  git add -- a b unrelated
  git commit --quiet -m 'chore: initial files'
  git push --quiet origin main
  initial=$(git rev-parse HEAD)
  git checkout --quiet -b "$branch"
  git config "branch.$branch.skills-base" origin/main
  prs "$branch" ''
}

expect_pushed() {
  [ "$(git --git-dir="$origin" rev-parse "refs/heads/$branch")" = "$(git rev-parse HEAD)" ] \
    || fail "$branch was not pushed at HEAD"
}

expect_unpublished() {
  if git --git-dir="$origin" show-ref --verify --quiet "refs/heads/$branch"; then
    fail "$branch was pushed"
  fi
}

parent_layer() {
  git checkout --quiet -b feat/parent main
  git config branch.feat/parent.skills-base origin/main
  printf 'parent\n' > parent
  git add -- parent
  git commit --quiet -m 'feat: parent'
  git checkout --quiet "$branch"
  git merge --quiet --ff-only feat/parent
  git config "branch.$branch.skills-base" feat/parent
  printf 'changed\n' >> a
}

cat > "$tmp/no-git/git" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$GIT_SHIM_LOG"
exit 1
SH
chmod 755 "$tmp/no-git/git"
export GIT_SHIM_LOG="$tmp/git.log"
: > "$GIT_SHIM_LOG"

for invalid in 'feat: first
second' 'feat: 123456789012345678901234567890123456789012345' 'missing prefix' 'Co-authored-by: a <a@b>' "feat: carriage$(printf '\r')return"; do
  case $invalid in
    'feat: first'*|'feat: carriage'*) reason='multi line message' ;;
    'feat: 123'*) reason='longer than 50 characters' ;;
    *) reason='no Conventional prefix' ;;
  esac

  expect_refusal "$reason" env PATH="$tmp/no-git:$PATH" sh "$script_dir/publish.sh" -m "$invalid" a
  expect_refusal "$reason" env PATH="$tmp/no-git:$PATH" sh "$script_dir/publish.sh" -m 'feat: valid' -t "$invalid" a
  [ ! -s "$GIT_SHIM_LOG" ] || fail 'invalid message called git'
  [ ! -s "$GH_STUB_LOG" ] || fail 'invalid message called gh'
done

fresh hands-off
printf 'DELIVERY=hands-off\n' > "$SKILLS_CONF"
printf 'changed\n' >> a
expect_refusal 'delivery mode is not prs' sh "$script_dir/publish.sh" -m "$message" a
[ "$(git rev-parse HEAD)" = "$initial" ] || fail 'hands-off created a commit'
[ -z "$(git diff --cached --name-only)" ] || fail 'hands-off staged files'
[ ! -s "$GH_STUB_LOG" ] || fail 'hands-off called gh'
expect_unpublished

fresh staged
printf 'changed\n' >> a
printf 'changed\n' >> unrelated
git add -- unrelated
expect_refusal 'already staged outside the file list: unrelated' sh "$script_dir/publish.sh" -m "$message" a
[ "$(git rev-parse HEAD)" = "$initial" ] || fail 'staged refusal created a commit'
[ "$(git diff --cached --name-only)" = unrelated ] || fail 'staged refusal changed the index'
[ ! -s "$GH_STUB_LOG" ] || fail 'staged refusal called gh'
expect_unpublished

fresh altered
printf 'changed\n' >> a
cat > .git/hooks/commit-msg <<'SH'
#!/bin/sh
printf '\nCo-authored-by: hook <hook@example.com>\n' >> "$1"
SH
chmod 755 .git/hooks/commit-msg
expect_refusal 'commit message was altered by a hook or template' sh "$script_dir/publish.sh" -m "$message" a
[ "$(git rev-parse HEAD)" = "$initial" ] || fail 'altered commit was not rolled back'
[ "$(git diff --cached --name-only)" = a ] || fail 'rollback lost staged changes'
[ ! -s "$GH_STUB_LOG" ] || fail 'altered commit called gh'
expect_unpublished

fresh renamed
git mv a a2
expect_refusal 'already staged outside the file list: a' sh "$script_dir/publish.sh" -m "$message" a2
[ "$(git rev-parse HEAD)" = "$initial" ] || fail 'rename refusal created a commit'
[ "$(git diff --cached --no-renames --name-only)" = "$(printf 'a\na2')" ] || fail 'rename refusal changed the index'
[ ! -s "$GH_STUB_LOG" ] || fail 'rename refusal called gh'
expect_unpublished

fresh missing-file
expect_refusal 'no such file: missing' sh "$script_dir/publish.sh" -m "$message" missing
[ "$(git rev-parse HEAD)" = "$initial" ] || fail 'missing file created a commit'
[ ! -s "$GH_STUB_LOG" ] || fail 'missing file called gh'
expect_unpublished

fresh plain
printf 'changed\n' >> a
printf 'changed\n' >> b
printf 'changed\n' >> unrelated
printf 'untracked\n' > untracked
fixture "progress
$url
" 0 pr create --base main --head "$branch" --title "$message" --body ''
publish -m "$message" a b
[ "$(git show --name-only --format= HEAD)" = "$(printf 'a\nb')" ] || fail 'commit contains wrong paths'
[ "$(git diff --name-only)" = unrelated ] || fail 'unrelated modification was lost'
[ -z "$(git diff --cached --name-only)" ] || fail 'unrelated file was staged'
[ "$(git ls-files --others --exclude-standard)" = untracked ] || fail 'untracked file was added'
[ "$(git log -1 --format=%B)" = "$message" ] || fail 'wrong commit message'
expect_pushed
expect_call pr create --base main --head "$branch" --title "$message" --body ''
expect_call stack --version

fresh trunk-with-stack
printf 'changed\n' >> a
fixture 'stack version' 0 stack --version
fixture "$url" 0 pr create --base main --head "$branch" --title "$message" --body ''
publish -m "$message" a
expect_call pr create --base main --head "$branch" --title "$message" --body ''
[ "$(grep '^stack ' "$GH_STUB_LOG")" = 'stack --version' ] || fail 'trunk used stack path'
[ "$(git rev-list --count origin/main..HEAD)" -eq 1 ] || fail 'trunk commit missing'
expect_pushed

fresh unset
git config --unset "branch.$branch.skills-base"
printf 'changed\n' >> a
fixture "$url" 0 pr create --base main --head "$branch" --title "$message" --body ''
publish -m "$message" a
expect_call pr create --base main --head "$branch" --title "$message" --body ''
expect_pushed

fresh layer
parent_layer
fixture "$url" 0 pr create --base feat/parent --head "$branch" --title "$message" --body ''
publish -m "$message" a
[ "$(git rev-list --count feat/parent..HEAD)" -eq 1 ] || fail 'layer commit count changed'
expect_call pr create --base feat/parent --head "$branch" --title "$message" --body ''
expect_pushed

fresh multiple
git commit --quiet --allow-empty -m 'feat: first change'
printf 'changed\n' >> a
expect_refusal 'branch has 2 commits since origin/main, pass -t with a title covering it' \
  sh "$script_dir/publish.sh" -m "$message" a
[ "$(git rev-list --count origin/main..HEAD)" -eq 2 ] || fail 'missing second commit'
[ ! -s "$GH_STUB_LOG" ] || fail 'missing title called gh'
expect_unpublished
title='feat: both changes'
fixture "$url" 0 pr create --base main --head "$branch" --title "$title" --body ''
head=$(git rev-parse HEAD)
publish -m "$message" -t "$title" a
[ "$(git rev-parse HEAD)" = "$head" ] || fail 'title rerun created a commit'
expect_call pr create --base main --head "$branch" --title "$title" --body ''
expect_pushed

fresh retry
printf 'changed\n' >> a
fixture '' 1 pr create --base main --head "$branch" --title "$message" --body ''
expect_refusal 'gh pr create failed' sh "$script_dir/publish.sh" -m "$message" a
expect_pushed
head=$(git rev-parse HEAD)
fixture "$url" 0 pr create --base main --head "$branch" --title "$message" --body ''
: > "$GH_STUB_LOG"
publish -m "$message" a
[ "$(git rev-parse HEAD)" = "$head" ] || fail 'retry created a commit'
[ "$(grep -c '^pr create ' "$GH_STUB_LOG")" -eq 1 ] || fail 'retry did not create exactly one PR'
expect_pushed

fresh existing
printf 'changed\n' >> a
prs "$branch" "$url"
fixture 'edited' 0 pr edit "$url" --title "$message"
publish -m "$message" a
expect_call pr edit "$url" --title "$message"
reject_call '^pr create |^pr edit .* --body '
expect_pushed

fresh deletion-retry
rm a
fixture '' 1 pr create --base main --head "$branch" --title "$message" --body ''
expect_refusal 'gh pr create failed' sh "$script_dir/publish.sh" -m "$message" a
[ "$(git show --name-status --format= HEAD)" = "$(printf 'D\ta')" ] || fail 'deletion was not committed'
expect_pushed
head=$(git rev-parse HEAD)
fixture "$url" 0 pr create --base main --head "$branch" --title "$message" --body ''
: > "$GH_STUB_LOG"
publish -m "$message" a
[ "$(git rev-parse HEAD)" = "$head" ] || fail 'deletion retry created a commit'
[ -z "$(git status --porcelain)" ] || fail 'deletion retry changed git state'
[ "$(grep -c '^pr create ' "$GH_STUB_LOG")" -eq 1 ] || fail 'deletion retry did not create exactly one PR'
expect_pushed

fresh existing-multiple
git commit --quiet --allow-empty -m 'feat: first change'
printf 'changed\n' >> a
prs "$branch" "$url"
title='feat: both changes'
fixture 'edited' 0 pr edit "$url" --title "$title"
publish -m "$message" -t "$title" a
[ "$(git rev-list --count origin/main..HEAD)" -eq 2 ] || fail 'reuse commit count changed'
expect_call pr edit "$url" --title "$title"
reject_call '^pr create |^pr edit .* --body '
expect_pushed

cat > "$tmp/stack-bin/gh" <<'SH'
#!/bin/sh
set -eu
"$GH_STUB_BIN/gh" "$@"
if [ "$*" = 'stack submit --auto --open' ] && [ -n "${PR_AFTER_SUBMIT:-}" ]; then
  key=$(printf '%s' "pr list --head $PR_BRANCH --state open --json url --jq .[0].url // empty" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s' "$PR_AFTER_SUBMIT" > "$GH_STUB_DIR/$key"
fi
SH
chmod 755 "$tmp/stack-bin/gh"

stack_fixtures() {
  fixture 'stack version' 0 stack --version
  fixture "{
  \"branches\": [
    {
      \"name\": \"feat/parent\"
    },
    {
      \"name\": \"$branch\"
    }
  ]
}" 0 stack view --json
  fixture 'registered' 0 stack init --base main feat/parent "$branch"
  fixture 'submitted' 0 stack submit --auto --open
  prs feat/parent https://github.com/test/repo/pull/parent
}

fresh stack
parent_layer
git push --quiet origin feat/parent
parent_head=$(git rev-parse feat/parent)
stack_fixtures
fixture 'edited' 0 pr edit "$url" --title "$message" --body ''
if ! env PATH="$tmp/stack-bin:$PATH" PR_BRANCH="$branch" PR_AFTER_SUBMIT="$url" \
  sh "$script_dir/publish.sh" -m "$message" a > "$tmp/out" 2> "$tmp/err"; then
  fail "stack publish failed: $(cat "$tmp/err")"
fi

[ "$(cat "$tmp/out")" = "$url" ] || fail 'stack stdout is not the PR URL'
[ "$(git rev-list --count feat/parent..HEAD)" -eq 1 ] || fail 'stack commit missing'
[ "$(git --git-dir="$origin" rev-parse feat/parent)" = "$parent_head" ] || fail 'stack changed parent'
expect_unpublished
expect_call stack init --base main feat/parent "$branch"
expect_call stack submit --auto --open
expect_call pr edit "$url" --title "$message" --body ''
reject_call '^pr create '
order=$(grep -E '^stack (init|view|submit) |^pr edit ' "$GH_STUB_LOG")
[ "$order" = "$(printf '%s\n' "stack init --base main feat/parent $branch" 'stack view --json' 'stack submit --auto --open' "pr edit $url --title $message --body ")" ] \
  || fail 'stack calls were out of order'

fresh submit-fails
parent_layer
stack_fixtures
fixture '' 1 stack submit --auto --open
expect_refusal 'gh stack submit failed' sh "$script_dir/publish.sh" -m "$message" a
reject_call '^pr (create|edit) '
expect_call stack submit --auto --open
[ "$(git rev-list --count feat/parent..HEAD)" -eq 1 ] || fail 'submit failure lost commit'
expect_unpublished

fresh registered-parent
parent_layer
stack_fixtures
cat > "$(git rev-parse --git-dir)/gh-stack" <<'JSON'
{
  "schemaVersion": 1,
  "repository": "test/repo",
  "stacks": [
    {
      "trunk": {"branch": "main"},
      "branches": [
        {"branch" :  "feat/parent"}
      ]
    }
  ]
}
JSON
fixture '' 1 stack add "$branch"
expect_refusal 'gh stack add failed' sh "$script_dir/publish.sh" -m "$message" a
expect_call stack add "$branch"
reject_call '^stack (init|view|submit) |^pr (create|edit) '
[ "$(git symbolic-ref --short HEAD)" = "$branch" ] || fail 'failed add left parent checked out'
[ "$(git rev-list --count feat/parent..HEAD)" -eq 1 ] || fail 'failed add lost commit'
expect_unpublished

fresh remote-ahead
parent_layer
git checkout --quiet feat/parent
git commit --quiet --allow-empty -m 'feat: remote parent change'
git push --quiet origin feat/parent
remote_head=$(git rev-parse HEAD)
git checkout --quiet "$branch"
git branch --force feat/parent "$remote_head^"
stack_fixtures
expect_refusal 'origin/feat/parent has commits feat/parent lacks, rebase before publishing' \
  sh "$script_dir/publish.sh" -m "$message" a
expect_call stack init --base main feat/parent "$branch"
expect_call stack view --json
reject_call '^stack submit '
[ "$(git rev-parse origin/feat/parent)" = "$remote_head" ] || fail 'remote parent was not fetched'
[ "$(git --git-dir="$origin" rev-parse feat/parent)" = "$remote_head" ] || fail 'remote parent was overwritten'
reject_call '^pr (create|edit) '
expect_unpublished

fresh descendant-ahead
parent_layer
git add -- a
git commit --quiet -m "$message"
head=$(git rev-parse HEAD)
git checkout --quiet -b feat/child
git commit --quiet --allow-empty -m 'feat: child'
child_head=$(git rev-parse HEAD)
git commit --quiet --allow-empty -m 'feat: remote child change'
git push --quiet origin feat/child
remote_head=$(git rev-parse HEAD)
git checkout --quiet "$branch"
git branch --force feat/child "$child_head"
stack_fixtures
fixture "{
  \"name\": \"unrelated-stack-name\",
  \"branches\": [
    {
      \"name\": \"feat/parent\"
    },
    {
      \"name\": \"$branch\"
    },
    {
      \"name\": \"feat/child\"
    }
  ]
}" 0 stack view --json
expect_refusal 'origin/feat/child has commits feat/child lacks, rebase before publishing' \
  sh "$script_dir/publish.sh" -m "$message" a
expect_call stack init --base main feat/parent "$branch"
expect_call stack view --json
reject_call '^stack submit |^pr (create|edit) |^pr list --head feat/child '
[ "$(git rev-parse HEAD)" = "$head" ] || fail 'descendant refusal changed HEAD'
[ "$(git rev-parse origin/feat/child)" = "$remote_head" ] || fail 'remote child was not fetched'
[ "$(git rev-parse feat/child)" = "$child_head" ] || fail 'local child changed'
[ "$(git --git-dir="$origin" rev-parse feat/child)" = "$remote_head" ] || fail 'remote child was overwritten'
expect_unpublished

fresh reuse
parent_layer
stack_fixtures
printf '{"schemaVersion":1,"repository":"test/repo","stacks":[{"trunk":{"branch":"main"},"branches":[{"branch":"%s"}]}]}\n' "$branch" > "$(git rev-parse --git-dir)/gh-stack"
prs "$branch" "$url"
fixture 'Review bot summary' 0 pr view "$url" --json body --jq .body
fixture 'edited' 0 pr edit "$url" --title "$message"
publish -m "$message" a
expect_call pr edit "$url" --title "$message"
reject_call '^pr create |^stack (init|add) |^pr edit .* --body '
[ "$(git rev-list --count feat/parent..HEAD)" -eq 1 ] || fail 'reuse commit missing'
expect_unpublished

for body_kind in footer template-root template-github template-docs template-different; do
  fresh "$body_kind"
  parent_layer
  stack_fixtures
  prs "$branch" "$url"
  case $body_kind in
    footer) body='Generated by https://github.com/github/gh-stack' ;;

    template-*)
      case $body_kind in
        template-root) template_dir=. ;;
        template-github|template-different) template_dir=.github ;;
        template-docs) template_dir=docs ;;
      esac

      mkdir -p "$template_dir"
      printf '%s\n' '---' 'name: Default' '---' '' '  Describe the change.' '' > "$template_dir/pull-request-template.md"
      body='Describe the change.'
      if [ "$body_kind" = template-github ]; then
        printf 'Root template\n' > PULL_REQUEST_TEMPLATE.md
        mkdir -p docs
        printf 'Docs template\n' > docs/pull_request_template.md
      elif [ "$body_kind" = template-different ]; then
        body='Review bot summary'
      fi
      ;;
  esac

  fixture "$body" 0 pr view "$url" --json body --jq .body
  if [ "$body_kind" = template-different ]; then
    fixture 'edited' 0 pr edit "$url" --title "$message"
    publish -m "$message" a
    expect_call pr edit "$url" --title "$message"
    reject_call '^pr edit .* --body '
  else
    fixture 'edited' 0 pr edit "$url" --title "$message" --body ''
    publish -m "$message" a
    expect_call pr edit "$url" --title "$message" --body ''
  fi

  [ "$(git rev-list --count feat/parent..HEAD)" -eq 1 ] || fail 'template reuse commit missing'
  reject_call '^pr create '
  expect_unpublished
done

fresh init-fails
parent_layer
stack_fixtures
fixture '' 1 stack init --base main feat/parent "$branch"
expect_refusal 'gh stack init failed' sh "$script_dir/publish.sh" -m "$message" a
reject_call '^stack submit |^pr (create|edit) '
expect_unpublished

fresh missing-pr
parent_layer
stack_fixtures
expect_refusal "gh stack submit opened no PR for $branch" sh "$script_dir/publish.sh" -m "$message" a
expect_call stack submit --auto --open
reject_call '^pr (create|edit) '
expect_unpublished

fresh view-fails
parent_layer
stack_fixtures
fixture '' 1 stack view --json
expect_refusal 'gh stack view failed' sh "$script_dir/publish.sh" -m "$message" a
expect_call stack init --base main feat/parent "$branch"
expect_call stack view --json
reject_call '^stack submit |^pr (create|edit) '
[ "$(git rev-list --count feat/parent..HEAD)" -eq 1 ] || fail 'view failure lost commit'
expect_unpublished

echo ok
