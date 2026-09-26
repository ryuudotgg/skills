#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
stub_bin=$(CDPATH= cd "$script_dir/../../../scripts/stubs" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/greptile.XXXXXX")
trap 'rm -rf "$tmp"' 0

export GH_STUB_DIR="$tmp/gh" GH_STUB_LOG="$tmp/gh.log"
export GREPTILE_NOW=2026-09-26T00:09:59Z GREPTILE_POLL=0
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
PATH="$stub_bin:$PATH"
export PATH

mkdir -p "$GH_STUB_DIR"
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

expect_refusal() {
  expected_status=$1
  reason=$2
  shift 2
  actual_status=0
  "$@" > "$tmp/out" 2> "$tmp/err" || actual_status=$?
  [ "$actual_status" -eq "$expected_status" ] || fail "expected exit $expected_status, got $actual_status: $reason"
  grep -Fq "$reason" "$tmp/err" || fail "missing refusal: $reason"
  [ ! -s "$tmp/out" ] || fail 'refusal printed stdout'
}

graphql_fixture() {
  fixture "$1" "${2:-0}" api graphql -F 'owner={owner}' -F 'repo={repo}' -F number=18 -F "query=@$script_dir/score.graphql"
}

trigger_fixture() {
  fixture "$1" "${2:-0}" api --paginate 'repos/{owner}/{repo}/issues/18/comments' --jq '.[] | select(.body | test("^\\s*@greptileai\\s*$")) | .created_at'
}

fixture_program='
import json
import sys

bot = {"login": "Greptile-apps"}
human = {"login": "developer"}
pr = {
  "createdAt": "2026-09-26T00:00:00Z",
  "body": "Confidence Score: 1/5\n<!-- greptile_confidence_score:4 -->\nLast reviewed commit: [fix](https://github.com/owner/repo/commit/" + "a" * 40 + ")",
  "userContentEdits": {"nodes": [
    {"editedAt": "2026-09-26T00:06:00Z", "editor": bot},
    {"editedAt": "2026-09-26T00:01:00Z", "editor": bot},
  ]},
  "comments": {"nodes": [
    {"author": bot, "body": "Confidence Score: 2/5", "updatedAt": "2026-09-26T00:03:00Z"},
    {"author": human, "body": "Confidence Score: 0/5", "updatedAt": "2026-09-26T00:09:00Z"},
  ]},
  "reviews": {"nodes": [
    {"author": bot, "body": "Confidence Score: 3/5", "submittedAt": "2026-09-26T00:02:00Z", "commit": {"oid": "b" * 40}},
    {"author": bot, "body": "", "submittedAt": "2026-09-26T00:01:00Z", "commit": {"oid": "d" * 40}},
    {"author": human, "body": "Confidence Score: 0/5", "submittedAt": "2026-09-26T00:09:00Z", "commit": {"oid": "e" * 40}},
  ]},
  "commits": {"nodes": [{"commit": {"oid": "f" * 40, "statusCheckRollup": None}}]},
}

case = sys.argv[1]
if case == "comment-newest":
  pr["comments"]["nodes"][0].update(body="cOnFiDeNcE sCoRe: \n 2 / 5", updatedAt="2026-09-26T00:08:00Z")
elif case == "review-newest":
  pr["reviews"]["nodes"][0].update(body="greptile_confidence_score:5", submittedAt="2026-09-26T00:08:00Z", commit={"oid": "c" * 40})
elif case == "human-edit":
  pr["userContentEdits"]["nodes"].insert(0, {"editedAt": "2026-09-26T00:09:00Z", "editor": human})
elif case in ("skip-review", "skip-comment", "skip-review-before-score", "skip-comment-before-score"):
  time = "2026-09-26T00:05:00Z" if case.endswith("before-score") else "2026-09-26T00:08:00Z"
  entry = {"author": bot, "body": "Review was skipped due to billing limits."}
  if case.startswith("skip-review"):
    entry.update(submittedAt=time, commit={"oid": "c" * 40})
    pr["reviews"]["nodes"].append(entry)
  else:
    entry.update(updatedAt=time)
    pr["comments"]["nodes"].append(entry)
elif case in ("running", "completed"):
  status = "IN_PROGRESS" if case == "running" else "COMPLETED"
  pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = {"contexts": {"nodes": [
    {"__typename": "CheckRun", "name": "Greptile Review", "status": status},
    {"__typename": "CheckRun", "name": "build", "status": "IN_PROGRESS"},
    {"__typename": "StatusContext"},
  ]}}
elif case == "body-fallback":
  pr["reviews"]["nodes"] = []
elif case == "no-reviewed":
  pr["reviews"]["nodes"] = []
  pr["body"] = "greptile_confidence_score:4"
elif case == "body-sha-without-bot-edit":
  pr["reviews"]["nodes"] = []
  pr["userContentEdits"]["nodes"] = [{"editedAt": "2026-09-26T00:09:00Z", "editor": human}]
elif case == "no-bot-edit":
  pr["userContentEdits"]["nodes"] = [{"editedAt": "2026-09-26T00:09:00Z", "editor": human}]
elif case == "no-score":
  pr["body"] = "No score"
  pr["comments"]["nodes"] = []
  pr["reviews"]["nodes"] = []
elif case == "old-skip":
  pr["reviews"]["nodes"][0]["body"] = "Review was skipped"
elif case == "zero-score":
  pr["body"] = "Confidence Score: 0/5"
elif case != "body-edits-newest-first":
  raise ValueError(case)

print(json.dumps({"data": {"repository": {"pullRequest": pr}}}))
'

score_case() {
  case_name=$1
  expected=$2
  triggers=$3
  shift 3
  graphql_fixture "$(python3 -c "$fixture_program" "$case_name")"
  trigger_fixture "$triggers"
  actual=$(sh "$script_dir/score.sh" 18 "$@") || fail "$case_name failed"
  [ "$actual" = "$expected" ] || fail "$case_name: $actual"
}

[ "$(grep -Fc 'userContentEdits(first: 20)' "$script_dir/score.graphql")" -eq 1 ] || fail 'body edit query must read newest edits'

a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
c=cccccccccccccccccccccccccccccccccccccccc

score_case body-edits-newest-first "score=4 paid=0 running=no skipped=no waited=9 reviewed=$a" ''
[ "$(cat "$GH_STUB_LOG")" = "$(printf '%s\n%s' \
  "api graphql -F owner={owner} -F repo={repo} -F number=18 -F query=@$script_dir/score.graphql" \
  'api --paginate repos/{owner}/{repo}/issues/18/comments --jq .[] | select(.body | test("^\\s*@greptileai\\s*$")) | .created_at')" ] || fail 'score calls differ'

score_case comment-newest "score=2 paid=0 running=no skipped=no waited=9 reviewed=$a" ''
score_case review-newest "score=5 paid=0 running=no skipped=no waited=9 reviewed=$c" ''
score_case human-edit "score=none paid=1 running=no skipped=no waited=2 reviewed=$a" '2026-09-26T00:07:00Z'
score_case body-edits-newest-first "score=none paid=3 running=no skipped=no waited=2 reviewed=$a" '2026-09-26T00:05:00Z
2026-09-26T00:07:00Z
2026-09-26T00:04:00Z'
score_case body-edits-newest-first "score=none paid=1 running=no skipped=no waited=3 reviewed=$a" '2026-09-26T00:06:00Z'
score_case skip-review "score=4 paid=0 running=no skipped=yes waited=9 reviewed=$c" ''
score_case skip-comment "score=4 paid=0 running=no skipped=yes waited=9 reviewed=$a" ''
score_case skip-review-before-score "score=4 paid=0 running=no skipped=no waited=9 reviewed=$a" ''
score_case skip-comment-before-score "score=4 paid=0 running=no skipped=no waited=9 reviewed=$a" ''
score_case old-skip "score=4 paid=1 running=no skipped=no waited=5 reviewed=$a" '2026-09-26T00:04:00Z'
score_case running "score=4 paid=0 running=yes skipped=no waited=9 reviewed=$a" ''
score_case completed "score=4 paid=0 running=no skipped=no waited=9 reviewed=$a" ''
score_case body-fallback "score=4 paid=0 running=no skipped=no waited=9 reviewed=$a" ''
score_case body-sha-without-bot-edit 'score=2 paid=0 running=no skipped=no waited=9 reviewed=none' ''
score_case no-reviewed 'score=4 paid=0 running=no skipped=no waited=9 reviewed=none' ''
score_case no-bot-edit "score=2 paid=0 running=no skipped=no waited=9 reviewed=$b" ''
score_case zero-score "score=0 paid=0 running=no skipped=no waited=9 reviewed=$b" ''
score_case body-edits-newest-first "score=none paid=1 running=no skipped=no waited=0 reviewed=$a" '2026-09-26T00:11:00Z'

: > "$GH_STUB_LOG"
score_case body-edits-newest-first "score=4 paid=0 running=no skipped=no waited=9 reviewed=$a" '' --wait
[ "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')" -eq 2 ] || fail 'wait polled after a score'
score_case skip-review "score=none paid=1 running=no skipped=yes waited=2 reviewed=$c" '2026-09-26T00:07:00Z' --wait

GREPTILE_NOW=2026-09-26T00:10:00Z
export GREPTILE_NOW
score_case no-score 'score=none paid=0 running=no skipped=no waited=10 reviewed=none' '' --wait
score_case running "score=4 paid=0 running=yes skipped=no waited=10 reviewed=$a" '' --wait

graphql_fixture 'partial response' 1
expect_refusal 1 'score: gh failed reading PR review' sh "$script_dir/score.sh" 18
graphql_fixture "$(python3 -c "$fixture_program" body-edits-newest-first)"
trigger_fixture 'partial triggers' 1
expect_refusal 1 'score: gh failed reading triggers' sh "$script_dir/score.sh" 18
expect_refusal 2 'usage: score.sh' sh "$script_dir/score.sh" x
expect_refusal 2 'usage: score.sh' sh "$script_dir/score.sh"
expect_refusal 2 'usage: score.sh' sh "$script_dir/score.sh" 18 --unknown
expect_refusal 2 'usage: score.sh' sh "$script_dir/score.sh" 18 --wait extra

mkdir "$tmp/repo"
cd "$tmp/repo"
git init --quiet -b main
git config commit.gpgsign false
printf 'base\n' > shared
printf '\000base\n' > binary
git add -- shared binary
git commit --quiet -m 'chore: base'
git checkout --quiet -b feature
git config branch.feature.skills-base main
printf 'feature\n' >> shared
git add -- shared
git commit --quiet -m 'feat: feature'
reviewed=$(git rev-parse HEAD)

facts_case() {
  actual=$(sh "$script_dir/fix-facts.sh" "$reviewed" "${2:-feature}") || fail 'fix facts failed'
  [ "$actual" = "$1" ] || fail "fix facts: expected $1, got $actual"
}

: > "$GH_STUB_LOG"
facts_case 'commits=0 lines=0 added=0 moved=no'

git checkout --quiet main
printf 'parent moved\n' > parent
git add -- parent
git commit --quiet -m 'feat: parent'
git checkout --quiet feature
git rebase --quiet main
facts_case 'commits=0 lines=0 added=0 moved=yes'

printf 'fix\n' >> shared
git add -- shared
git commit --quiet -m 'fix: small'
facts_case 'commits=1 lines=1 added=0 moved=yes'

reviewed=$(git rev-parse HEAD)
printf 'new\n' > 'new file'
git add -- 'new file'
git commit --quiet -m 'fix: add file'
facts_case 'commits=1 lines=1 added=1 moved=yes'

reviewed=$(git rev-parse HEAD)
python3 -c 'print("line\n" * 30, end="")' >> shared
git add -- shared
git commit --quiet -m 'fix: thirty lines'
facts_case 'commits=1 lines=30 added=0 moved=yes'

reviewed=$(git rev-parse HEAD)
printf '\000changed\n' > binary
git add -- binary
git commit --quiet -m 'fix: binary'
facts_case 'commits=1 lines=30 added=0 moved=yes'

reviewed=$(git rev-parse HEAD)
printf 'first\n' > repeated
git add -- repeated
git commit --quiet -m 'fix: first addition'
git rm --quiet repeated
git commit --quiet -m 'fix: remove file'
printf 'second\n' > repeated
git add -- repeated
git commit --quiet -m 'fix: second addition'
facts_case 'commits=3 lines=3 added=1 moved=yes'

git config --unset branch.feature.skills-base
git update-ref refs/remotes/origin/main main
git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
facts_case 'commits=3 lines=3 added=1 moved=yes'
git symbolic-ref --delete refs/remotes/origin/HEAD
expect_refusal 1 'fix-facts: cannot resolve origin/HEAD' sh "$script_dir/fix-facts.sh" "$reviewed" feature
git config branch.feature.skills-base missing-base
expect_refusal 1 'fix-facts: cannot resolve origin/HEAD' sh "$script_dir/fix-facts.sh" "$reviewed" feature
git config branch.feature.skills-base main
expect_refusal 1 'fix-facts: reviewed is not a commit' sh "$script_dir/fix-facts.sh" missing-commit feature
blob=$(git rev-parse HEAD:shared)
expect_refusal 1 'fix-facts: reviewed is not a commit' sh "$script_dir/fix-facts.sh" "$blob" feature
git checkout --quiet --detach
facts_case 'commits=3 lines=3 added=1 moved=yes'
expect_refusal 1 'fix-facts: branch is not a local branch' sh "$script_dir/fix-facts.sh" "$reviewed" missing-branch
expect_refusal 1 'fix-facts: branch is not a local branch' sh "$script_dir/fix-facts.sh" "$reviewed" origin/main
expect_refusal 2 'usage: fix-facts.sh' sh "$script_dir/fix-facts.sh" "$reviewed"
expect_refusal 2 'usage: fix-facts.sh' sh "$script_dir/fix-facts.sh"
expect_refusal 2 'usage: fix-facts.sh' sh "$script_dir/fix-facts.sh" "$reviewed" feature extra

mkdir "$tmp/stack"
cd "$tmp/stack"
git init --quiet -b main
git config commit.gpgsign false
printf 'base\n' > shared
git add -- shared
git commit --quiet -m 'chore: base'
git update-ref refs/remotes/origin/main main
git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
git checkout --quiet -b layer-1
git config branch.layer-1.skills-base main
printf 'parent\n' > parent
git add -- parent
git commit --quiet -m 'feat: parent'
parent_reviewed=$(git rev-parse layer-1)
git checkout --quiet -b layer-2
git config branch.layer-2.skills-base layer-1
printf 'child\n' > child
git add -- child
git commit --quiet -m 'feat: child'
child_reviewed=$(git rev-parse layer-2)
git checkout --quiet layer-1
printf 'fixed\n' >> parent
git add -- parent
git commit --quiet -m 'fix: parent'
git rebase --quiet --onto layer-1 "$parent_reviewed" layer-2
git checkout --quiet layer-1
reviewed=$parent_reviewed
facts_case 'commits=1 lines=1 added=0 moved=yes' layer-1
reviewed=$child_reviewed
facts_case 'commits=0 lines=0 added=0 moved=yes' layer-2
[ "$(git branch --show-current)" = layer-1 ] || fail 'fix facts changed checkout'

git checkout --quiet main
git merge --quiet --squash layer-1 > "$tmp/squash.out"
git commit --quiet -m 'feat: squash parent'
git update-ref refs/remotes/origin/main main
git rebase --quiet --onto main layer-1 layer-2
facts_case 'commits=0 lines=0 added=0 moved=yes' layer-2

git branch --quiet -D layer-1
facts_case 'commits=0 lines=0 added=0 moved=yes' layer-2
[ ! -s "$GH_STUB_LOG" ] || fail 'fix facts called gh'

set -f
while IFS='|' read -r args expected; do
  if [ "$expected" = usage ]; then
    expect_refusal 2 'usage: decide.sh' sh "$script_dir/decide.sh" $args
    continue
  fi

  actual=$(sh "$script_dir/decide.sh" $args) || fail "decision failed: $args"
  [ "$actual" = "$expected" ] || fail "decision: expected $expected, got $actual"
done <<'TABLE'
score=none paid=2 running=yes skipped=yes waited=10 reviewed=none|handback skipped
score=4 paid=0 running=yes skipped=no waited=9 reviewed=none|wait check-running
score=4 paid=0 running=yes skipped=no waited=10 reviewed=none|handback timeout
score=none paid=0 running=no skipped=no waited=9 reviewed=none|wait no-score
score=none paid=0 running=no skipped=no waited=10 reviewed=none|handback timeout
score=3 paid=0 running=no skipped=no waited=0 reviewed=none|handback no-reviewed-commit
score=4 paid=2 running=no skipped=no waited=0 reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|triage scored
score=4 paid=2 running=no skipped=no waited=0 reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa commits=1 lines=30 added=0 moved=yes|done large-fix
score=4 paid=2 running=no skipped=no waited=0 reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa commits=1 lines=29 added=0 moved=yes|done threshold
score=3 paid=2 running=no skipped=no waited=0 reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa commits=0 lines=0 added=0 moved=yes|handback paid-cap
score=3 paid=1 running=no skipped=no waited=0 reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa commits=0 lines=0 added=0 moved=yes|handback rebase-only
score=3 paid=1 running=no skipped=no waited=0 reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa commits=0 lines=0 added=0 moved=no|handback all-dismissed
score=3 paid=1 running=no skipped=no waited=0 reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa commits=1 lines=1 added=0 moved=yes|rereview below-threshold
score=4 paid=1 running=no skipped=no waited=0 reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa commits=1 lines=1 added=0 moved=yes critical=true|rereview below-threshold
score=5 paid=1 running=no skipped=no waited=0 reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa commits=1 lines=1 added=0 moved=yes critical=true|done threshold
score=4 paid=0 running=no skipped=no waited=0 reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa commits=1 lines=1 added=1 moved=yes critical=false|done large-fix
score=4 paid=0 running=no skipped=no waited=0 reviewed=none unknown=true|usage
score=4 paid=0 running=no skipped=no waited=0 reviewed=none commits=1|usage
paid=0 running=no skipped=no waited=0 reviewed=none|usage
score=6 paid=0 running=no skipped=no waited=0 reviewed=none|usage
score=4 paid=-1 running=no skipped=no waited=0 reviewed=none|usage
score=4 paid=0 running=maybe skipped=no waited=0 reviewed=none|usage
score=4 paid=0 running=no skipped=maybe waited=0 reviewed=none|usage
score=4 paid=0 running=no skipped=no waited=1.5 reviewed=none|usage
score=4 paid=0 running=no skipped=no waited=0 reviewed=abc|usage
score=4 paid=0 running=no skipped=no waited=0 reviewed=none critical=yes|usage
score=4 paid=0 running=no skipped=no waited=0 reviewed=none commits=1 lines=-1 added=0 moved=yes|usage
score=4 paid=0 running=no skipped=no waited=0 reviewed=none commits=1 lines=1 added=0 moved=maybe|usage
score=4 paid=0 running=no skipped=no waited=0 reviewed=none score=3|usage
score=4 paid=0 running=no skipped=no waited=0 reviewed=none malformed|usage
TABLE

quoted=$(sh "$script_dir/decide.sh" 'score=3 paid=1 running=no skipped=no waited=0 reviewed=none') \
  || fail 'decision rejected a quoted score line'

[ "$quoted" = 'handback no-reviewed-commit' ] || fail "quoted decision: got $quoted"
[ ! -s "$GH_STUB_LOG" ] || fail 'decision called gh'
echo ok
