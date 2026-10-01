#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
reviewer_names=$(sh "$script_dir/../../playbook/scripts/reviewers.sh" NAME | awk -F '\t' '
  { names = names (NR > 1 ? " or " : "") $2 }
  END { print names }
')
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

threads() {
  key=$(printf '%s' "api graphql -F owner={owner} -F repo={repo} -F number=$1 -F" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s' "$2" > "$GH_STUB_DIR/$key.prefix"
  printf '%s\n' "$3" > "$GH_STUB_DIR/$key.prefix.exit"
}

fresh() {
  name=$1
  origin=$tmp/$name.git
  repo=$tmp/$name/fixture
  rm -rf "$origin" "$repo" "$PLANS_DIR/fixture" "$GH_STUB_DIR"
  mkdir -p "$GH_STUB_DIR" "$PLANS_DIR/fixture" "$(dirname "$repo")"
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
  } > "$PLANS_DIR/fixture/index.tsv"
  : > "$GH_STUB_LOG"
}

fresh resolved
pr_list feat/a 'OPEN 1' 0
pr_list feat/b 'OPEN 2' 0
threads 1 '' 0
threads 2 '' 0
actual=$(sh "$script_dir/below.sh" fixture feat/b) || fail "resolved layers refused: $(cat "$tmp/err" 2>/dev/null)"
[ -z "$actual" ] || fail "resolved layers printed '$actual'"
! grep -Fq 'pr checks' "$GH_STUB_LOG" || fail 'checks were read'
! grep -Fq 'pulls/' "$GH_STUB_LOG" || fail 'REST comments were read'
[ -z "$(git -C "$repo" for-each-ref refs/heads/feat/new)" ] || fail 'a branch was cut'

fresh unresolved
pr_list feat/a 'OPEN 1' 0
pr_list feat/b 'OPEN 2' 0
threads 1 'https://github.com/o/r/pull/1#discussion_r11' 0
threads 2 '' 0
expect_refusal "below: unresolved $reviewer_names threads below the base" sh "$script_dir/below.sh" fixture feat/b
grep -Fqx "open${tab}1${tab}feat/a${tab}1${tab}https://github.com/o/r/pull/1#discussion_r11" "$tmp/err" \
  || fail "refusal did not name the thread: $(cat "$tmp/err")"
[ -z "$(awk '/^push /' "$GH_STUB_LOG")" ] || fail 'the gate pushed'

fresh trunk
before=$(wc -l < "$GH_STUB_LOG")
actual=$(sh "$script_dir/below.sh" fixture origin/main) || fail 'origin main failed'
[ -z "$actual" ] || fail 'origin main printed output'
[ "$(wc -l < "$GH_STUB_LOG")" = "$before" ] || fail 'origin main logged a call'

fresh merged
pr_list feat/a 'MERGED 5' 0
pr_list feat/b 'OPEN 2' 0
threads 2 '' 0
sh "$script_dir/below.sh" fixture feat/b > "$tmp/out" || fail 'merged layer failed'
! grep -Fq 'number=5' "$GH_STUB_LOG" || fail 'merged layer threads were read'

fresh unowned
expect_refusal 'below: feat/unowned is not an owned branch' sh "$script_dir/below.sh" fixture feat/unowned

fresh closed
pr_list feat/a 'CLOSED 7' 0
expect_refusal 'below: PR for feat/a was closed without merging' sh "$script_dir/below.sh" fixture feat/a

fresh empty
pr_list feat/a '' 0
expect_refusal 'below: feat/a has no PR' sh "$script_dir/below.sh" fixture feat/a

fresh threads-failed
pr_list feat/a 'OPEN 1' 0
threads 1 '' 1
expect_refusal 'below: gh failed reading review threads for feat/a' sh "$script_dir/below.sh" fixture feat/a

git init --quiet -b main "$tmp/other"
git -C "$tmp/other" -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false commit --quiet --allow-empty -m init
git -C "$tmp/other" config branch.feat/scratch.skills-base origin/main
git -C "$tmp/other" branch feat/scratch
git -C "$tmp/other" branch --list > "$tmp/branches.before"
git -C "$tmp/other" config --get-regexp skills-base > "$tmp/config.before"
cp "$GH_STUB_LOG" "$tmp/gh.before"

if (cd "$tmp/other" && sh "$script_dir/below.sh" fixture feat/b > "$tmp/out" 2> "$tmp/err"); then
  fail 'wrong checkout passed below'
fi

grep -Fq 'below: this checkout is other, not a checkout of fixture' "$tmp/err" \
  || fail 'wrong checkout refusal lacks repo and project names'
[ ! -s "$tmp/out" ] || fail 'wrong checkout printed output'
git -C "$tmp/other" branch --list > "$tmp/branches.after"
git -C "$tmp/other" config --get-regexp skills-base > "$tmp/config.after"
cmp -s "$tmp/branches.before" "$tmp/branches.after" || fail 'wrong checkout changed branches'
cmp -s "$tmp/config.before" "$tmp/config.after" || fail 'wrong checkout changed skills-base config'
cmp -s "$tmp/gh.before" "$GH_STUB_LOG" || fail 'wrong checkout called gh'

echo ok
