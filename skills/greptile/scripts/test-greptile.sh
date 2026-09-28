#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
playbook_dir=$(CDPATH= cd "$script_dir/../../playbook/scripts" && pwd -P)
stub_bin=$(CDPATH= cd "$script_dir/../../../scripts/stubs" && pwd -P)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/greptile.XXXXXX")
trap 'rm -rf "$tmp"' 0

export GH_STUB_DIR="$tmp/gh" GH_STUB_LOG="$tmp/gh.log"
export REVIEW_NOW=2026-09-26T00:09:59Z
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export SKILLS_CONF="$tmp/skills.conf"
printf 'DELIVERY=prs\nWITH=greptile\n' > "$SKILLS_CONF"
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

check_fixture() {
  fixture "$1" "${2:-0}" api graphql -F 'owner={owner}' -F 'repo={repo}' -F number=18 -F "query=@$playbook_dir/check-state.graphql"
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
elif case in ("running", "running-older", "completed"):
  status = "IN_PROGRESS" if case.startswith("running") else "COMPLETED"
  pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = {"contexts": {"nodes": [
    {"__typename": "CheckRun", "name": "Greptile Review", "status": status},
    {"__typename": "CheckRun", "name": "build", "status": "IN_PROGRESS"},
    {"__typename": "StatusContext", "context": "CodeRabbit", "state": "SUCCESS", "description": "Review completed"},
  ]}}
  if case == "running-older":
    pr["commits"]["nodes"].append({"commit": {"oid": "e" * 40, "statusCheckRollup": None}})
elif case in ("required-older", "required-newest"):
  def greptile_check(title):
    return {"statusCheckRollup": {"contexts": {"nodes": [{"__typename": "CheckRun", "name": "Greptile Review", "status": "COMPLETED", "title": title}]}}}

  pr["commits"]["nodes"] = [
    {"commit": {"oid": "1" * 40, **greptile_check("Base review: Confidence 3/5 : below your required 4/5")}},
    {"commit": {"oid": "2" * 40, **greptile_check("Base review")}},
  ]
  if case == "required-newest":
    pr["commits"]["nodes"].append({"commit": {"oid": "3" * 40, **greptile_check("Confidence 4/5 : below your required 5/5")}})
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
elif case in ("absent", "absent-recent", "absent-human", "absent-build", "absent-full", "check-only", "check-running"):
  pr["createdAt"] = "2026-09-26T00:08:00Z" if case == "absent-recent" else "2026-09-26T00:04:00Z"
  pr["body"] = ""
  pr["userContentEdits"]["nodes"] = []
  pr["comments"]["nodes"] = []
  pr["reviews"]["nodes"] = []
  if case == "absent-human":
    pr["comments"]["nodes"] = [{"author": {"login": "greptile-fan"}, "body": "", "updatedAt": "2026-09-26T00:08:00Z"}]
  if case == "absent-full":
    pr["comments"]["nodes"] = [{"author": human, "body": "", "updatedAt": "2026-09-26T00:08:00Z"}] * 100
  if case in ("absent-build", "check-only", "check-running"):
    name = "build" if case == "absent-build" else "GREPTILE REVIEW"
    status = "IN_PROGRESS" if case == "check-running" else "COMPLETED"
    pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = {"contexts": {"nodes": [
      {"__typename": "CheckRun", "name": name, "status": status},
    ]}}
  if case == "check-running":
    pr["createdAt"] = "2026-09-26T00:00:00Z"
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

score_case body-edits-newest-first "score=4 paid=0 running=no skipped=no reviewed=$a required=none" ''
[ "$(cat "$GH_STUB_LOG")" = "$(printf '%s\n%s' \
  "api graphql -F owner={owner} -F repo={repo} -F number=18 -F query=@$script_dir/score.graphql" \
  'api --paginate repos/{owner}/{repo}/issues/18/comments --jq .[] | select(.body | test("^\\s*@greptileai\\s*$")) | .created_at')" ] || fail 'score calls differ'

score_case comment-newest "score=2 paid=0 running=no skipped=no reviewed=$a required=none" ''
score_case review-newest "score=5 paid=0 running=no skipped=no reviewed=$c required=none" ''
score_case human-edit "score=none paid=1 running=no skipped=no reviewed=$a required=none" '2026-09-26T00:07:00Z'
score_case body-edits-newest-first "score=none paid=3 running=no skipped=no reviewed=$a required=none" '2026-09-26T00:05:00Z
2026-09-26T00:07:00Z
2026-09-26T00:04:00Z'
score_case body-edits-newest-first "score=none paid=1 running=no skipped=no reviewed=$a required=none" '2026-09-26T00:06:00Z'
score_case skip-review "score=4 paid=0 running=no skipped=yes reviewed=$c required=none" ''
score_case skip-comment "score=4 paid=0 running=no skipped=yes reviewed=$a required=none" ''
score_case skip-review-before-score "score=4 paid=0 running=no skipped=no reviewed=$a required=none" ''
score_case skip-comment-before-score "score=4 paid=0 running=no skipped=no reviewed=$a required=none" ''
score_case old-skip "score=4 paid=1 running=no skipped=no reviewed=$a required=none" '2026-09-26T00:04:00Z'
score_case running "score=4 paid=0 running=yes skipped=no reviewed=$a required=none" ''
score_case running-older "score=4 paid=0 running=yes skipped=no reviewed=$a required=none" ''
score_case completed "score=4 paid=0 running=no skipped=no reviewed=$a required=none" ''
score_case required-older "score=4 paid=0 running=no skipped=no reviewed=$a required=4" ''
score_case required-newest "score=4 paid=0 running=no skipped=no reviewed=$a required=5" ''
score_case body-fallback "score=4 paid=0 running=no skipped=no reviewed=$a required=none" ''
score_case body-sha-without-bot-edit 'score=2 paid=0 running=no skipped=no reviewed=none required=none' ''
score_case no-reviewed 'score=4 paid=0 running=no skipped=no reviewed=none required=none' ''
score_case no-bot-edit "score=2 paid=0 running=no skipped=no reviewed=$b required=none" ''
score_case zero-score "score=0 paid=0 running=no skipped=no reviewed=$b required=none" ''
score_case body-edits-newest-first "score=none paid=1 running=no skipped=no reviewed=$a required=none" '2026-09-26T00:11:00Z'

: > "$GH_STUB_LOG"
score_case body-edits-newest-first "score=4 paid=0 running=no skipped=no reviewed=$a required=none" ''
[ "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')" -eq 2 ] || fail 'score reader queried again'
score_case skip-review "score=none paid=1 running=no skipped=yes reviewed=$c required=none" '2026-09-26T00:07:00Z'

: > "$GH_STUB_LOG"
score_case absent 'score=none paid=0 running=no skipped=no reviewed=none required=none' ''
[ "$(cat "$GH_STUB_LOG")" = "$(printf '%s\n%s' \
  "api graphql -F owner={owner} -F repo={repo} -F number=18 -F query=@$script_dir/score.graphql" \
  'api --paginate repos/{owner}/{repo}/issues/18/comments --jq .[] | select(.body | test("^\\s*@greptileai\\s*$")) | .created_at')" ] || fail 'absent score read changed gh calls'
score_case absent-recent 'score=none paid=0 running=no skipped=no reviewed=none required=none' ''
score_case absent-human 'score=none paid=0 running=no skipped=no reviewed=none required=none' ''
score_case absent-build 'score=none paid=0 running=no skipped=no reviewed=none required=none' ''
score_case absent-full 'score=none paid=0 running=no skipped=no reviewed=none required=none' ''
score_case check-only 'score=none paid=0 running=no skipped=no reviewed=none required=none' ''
score_case no-score 'score=none paid=0 running=no skipped=no reviewed=none required=none' ''
score_case check-running 'score=none paid=0 running=yes skipped=no reviewed=none required=none' ''

graphql_fixture 'partial response' 1
expect_refusal 1 'score: gh failed reading PR review' sh "$script_dir/score.sh" 18
graphql_fixture "$(python3 -c "$fixture_program" body-edits-newest-first)"
trigger_fixture 'partial triggers' 1
expect_refusal 1 'score: gh failed reading triggers' sh "$script_dir/score.sh" 18
expect_refusal 2 'usage: score.sh' sh "$script_dir/score.sh" x
expect_refusal 2 'usage: score.sh' sh "$script_dir/score.sh"
expect_refusal 2 'usage: score.sh' sh "$script_dir/score.sh" 18 --unknown
expect_refusal 2 'usage: score.sh' sh "$script_dir/score.sh" 18 --unknown extra

export SKILLS_CONF="$tmp/skills.conf"
printf 'DELIVERY=prs\nWITH=greptile\n' > "$SKILLS_CONF"
pull=https://github.com/owner/repo/pull/18#discussion_r
bot='{"login": "greptile-apps"}'
human='{"login": "developer"}'

threads_fixture() {
  fixture "$1" "${2:-0}" api graphql -F 'owner={owner}' -F 'repo={repo}' -F number=18 -F "query=@$playbook_dir/threads.graphql"
}

mutation_fixture() {
  fixture "$1" "${3:-0}" api graphql -F "query=@$playbook_dir/resolve.graphql" -f "id=$2" --jq .data.resolveReviewThread.thread.isResolved
}

thread() {
  printf '{"id": "%s", "isResolved": %s, "comments": {"nodes": [%s]}}' "$1" "$2" "$3"
}

comment() {
  printf '{"url": "%s%s", "author": %s}' "$pull" "$1" "$2"
}

threads_fixture "{\"data\": {\"repository\": {\"pullRequest\": {\"reviewThreads\": {\"nodes\": [
$(thread T1 false "$(comment 10 "$bot"), $(comment 11 "$bot")"),
$(thread T2 true "$(comment 20 "$bot")"),
$(thread T3 false "$(comment 30 "$bot"), $(comment 31 "$human")"),
$(thread T4 false "$(comment 40 "$human"), $(comment 41 "$bot")"),
$(thread T5 false "$(comment 50 "$bot"), $(comment 51 null)")
]}}}}}"
mutation_fixture true T1

: > "$GH_STUB_LOG"
actual=$(sh "$playbook_dir/resolve.sh" 18 "${pull}10" "${pull}11" "${pull}20" "${pull}30" "${pull}50") || fail 'resolve failed'
[ "$actual" = "resolved ${pull}10
resolved ${pull}11
already-resolved ${pull}20
left-open ${pull}30 reply-from=developer
left-open ${pull}50 reply-from=ghost" ] || fail "resolve: $actual"

[ "$(cat "$GH_STUB_LOG")" = "$(printf '%s\n%s' \
  "api graphql -F owner={owner} -F repo={repo} -F number=18 -F query=@$playbook_dir/threads.graphql" \
  "api graphql -F query=@$playbook_dir/resolve.graphql -f id=T1 --jq .data.resolveReviewThread.thread.isResolved")" ] \
  || fail 'resolve calls differ'

: > "$GH_STUB_LOG"
expect_refusal 1 "resolve: ${pull}41 is in a thread Greptile did not start" sh "$playbook_dir/resolve.sh" 18 "${pull}10" "${pull}41"
expect_refusal 1 "resolve: ${pull}99 is not in a review thread on PR 18" sh "$playbook_dir/resolve.sh" 18 "${pull}10" "${pull}99"
! grep -Fq resolve.graphql "$GH_STUB_LOG" || fail 'resolve wrote before refusing'

mutation_fixture false T1
expect_refusal 1 "resolve: ${pull}10 did not resolve" sh "$playbook_dir/resolve.sh" 18 "${pull}10"
mutation_fixture '' T1 1
expect_refusal 1 "resolve: gh failed resolving ${pull}10" sh "$playbook_dir/resolve.sh" 18 "${pull}10"
threads_fixture '{"data": null}'
expect_refusal 1 'resolve: cannot read review threads' sh "$playbook_dir/resolve.sh" 18 "${pull}10"
threads_fixture 'partial response' 1
expect_refusal 1 'resolve: gh failed reading review threads' sh "$playbook_dir/resolve.sh" 18 "${pull}10"

threads_fixture "{\"data\": {\"repository\": {\"pullRequest\": {\"reviewThreads\": {\"nodes\": [
$(thread T1 false "$(comment 10 "$bot"), $(comment 11 "$bot")"),
$(thread T2 true "$(comment 20 "$bot")"),
$(thread T3 false "$(comment 30 "$bot"), $(comment 31 "$human")"),
$(thread T4 false "$(comment 40 "$human"), $(comment 41 "$bot")")
]}}}}}"

reply_fixture() {
  key=$(printf '%s' "api graphql -F query=@$playbook_dir/reply.graphql -f id=T1" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s' "$1" > "$GH_STUB_DIR/$key.prefix"
  printf '%s\n' "${2:-0}" > "$GH_STUB_DIR/$key.prefix.exit"
}

printf 'The guard runs before the write, see abc1234.\n' > "$tmp/body"
reply_fixture "${pull}12"
mutation_fixture true T1

: > "$GH_STUB_LOG"
actual=$(sh "$playbook_dir/reply.sh" 18 "${pull}11" "$tmp/body") || fail 'reply failed'
[ "$actual" = "replied ${pull}12
resolved ${pull}11" ] || fail "reply: $actual"

[ "$(cat "$GH_STUB_LOG")" = "$(printf '%s\n%s\n%s' \
  "api graphql -F owner={owner} -F repo={repo} -F number=18 -F query=@$playbook_dir/threads.graphql" \
  "api graphql -F query=@$playbook_dir/reply.graphql -f id=T1 -F body=@$tmp/body --jq .data.addPullRequestReviewThreadReply.comment.url" \
  "api graphql -F query=@$playbook_dir/resolve.graphql -f id=T1 --jq .data.resolveReviewThread.thread.isResolved")" ] \
  || fail 'reply calls differ'

: > "$GH_STUB_LOG"
expect_refusal 1 "reply: ${pull}20 is in a resolved thread" sh "$playbook_dir/reply.sh" 18 "${pull}20" "$tmp/body"
expect_refusal 1 "reply: ${pull}30 is not in a thread only Greptile has written in" sh "$playbook_dir/reply.sh" 18 "${pull}30" "$tmp/body"
expect_refusal 1 "reply: ${pull}41 is not in a thread only Greptile has written in" sh "$playbook_dir/reply.sh" 18 "${pull}41" "$tmp/body"
expect_refusal 1 "reply: ${pull}99 is not in a review thread on PR 18" sh "$playbook_dir/reply.sh" 18 "${pull}99" "$tmp/body"
! grep -Fq reply.graphql "$GH_STUB_LOG" || fail 'reply wrote before refusing'

printf 'Fixed, @GreptileAI take another look.\n' > "$tmp/mention"
printf ' \n\n' > "$tmp/blank"
: > "$GH_STUB_LOG"
expect_refusal 1 'reply: the reply body mentions @greptile' sh "$playbook_dir/reply.sh" 18 "${pull}10" "$tmp/mention"
expect_refusal 1 'reply: the reply body is empty' sh "$playbook_dir/reply.sh" 18 "${pull}10" "$tmp/blank"
expect_refusal 2 'usage: reply.sh' sh "$playbook_dir/reply.sh" 18 "${pull}10" "$tmp/missing"
expect_refusal 2 'usage: reply.sh' sh "$playbook_dir/reply.sh" 18 "${pull}10"
expect_refusal 2 'usage: reply.sh' sh "$playbook_dir/reply.sh" 18 https://github.com/owner/repo/pull/19#discussion_r10 "$tmp/body"
expect_refusal 2 'usage: reply.sh' sh "$playbook_dir/reply.sh" x "${pull}10" "$tmp/body"
[ ! -s "$GH_STUB_LOG" ] || fail 'reply called gh on a bad body or usage'

reply_fixture '' 1
expect_refusal 1 "reply: gh failed replying to ${pull}10" sh "$playbook_dir/reply.sh" 18 "${pull}10" "$tmp/body"
reply_fixture "${pull}12"
mutation_fixture false T1
status=0
sh "$playbook_dir/reply.sh" 18 "${pull}10" "$tmp/body" > "$tmp/out" 2> "$tmp/err" || status=$?
[ "$status" -eq 1 ] && [ "$(cat "$tmp/out")" = "replied ${pull}12" ] \
  && grep -Fq "reply: ${pull}10 did not resolve" "$tmp/err" || fail 'reply hid a failed resolve'

: > "$GH_STUB_LOG"
printf 'DELIVERY=prs\n' > "$SKILLS_CONF"
expect_refusal 1 'resolve: greptile is not active in prs mode' sh "$playbook_dir/resolve.sh" 18 "${pull}10"
printf 'DELIVERY=hands-off\nWITH=greptile\n' > "$SKILLS_CONF"
expect_refusal 1 'resolve: greptile is not active in prs mode' sh "$playbook_dir/resolve.sh" 18 "${pull}10"
expect_refusal 2 'usage: resolve.sh' sh "$playbook_dir/resolve.sh" 18
expect_refusal 2 'usage: resolve.sh' sh "$playbook_dir/resolve.sh" x "${pull}10"
expect_refusal 2 'usage: resolve.sh' sh "$playbook_dir/resolve.sh" 18 https://github.com/owner/repo/pull/19#discussion_r10
expect_refusal 2 'usage: resolve.sh' sh "$playbook_dir/resolve.sh" 18 "${pull}1x"
expect_refusal 2 'usage: resolve.sh' sh "$playbook_dir/resolve.sh" 18 "${pull}"
expect_refusal 1 'reply: greptile is not active in prs mode' sh "$playbook_dir/reply.sh" 18 "${pull}10" "$tmp/body"
[ ! -s "$GH_STUB_LOG" ] || fail 'resolve or reply called gh without greptile active'
printf 'DELIVERY=prs\nWITH=greptile\n' > "$SKILLS_CONF"

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
adapter_reviewed=$reviewed

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

check_state="check=completed seen=yes event=push elapsed=90 age=90 gate=decide"
set -f
while IFS='|' read -r args expected; do
  if [ "$expected" = usage ]; then
    expect_refusal 2 'usage: decide.sh' sh "$script_dir/decide.sh" "$check_state" $args
    continue
  fi

  actual=$(sh "$script_dir/decide.sh" "$check_state" $args) || fail "decision failed: $args"
  [ "$actual" = "$expected" ] || fail "decision: expected $expected, got $actual"
done <<'TABLE'
score=none paid=2 running=yes skipped=yes reviewed=none required=none|unavailable skipped
score=none paid=0 running=yes skipped=no reviewed=none required=none|wait check-pending
score=none paid=0 running=no skipped=no reviewed=none required=none|handback no-score
score=3 paid=0 running=no skipped=no reviewed=none required=none|handback no-reviewed-commit
score=4 paid=2 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=none|triage scored
score=4 paid=2 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=none commits=1 lines=30 added=0 moved=yes|done large-fix
score=4 paid=2 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=none commits=1 lines=29 added=0 moved=yes|done threshold
score=3 paid=2 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=none commits=0 lines=0 added=0 moved=yes|handback paid-cap
score=3 paid=1 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=none commits=0 lines=0 added=0 moved=yes|handback rebase-only
score=3 paid=1 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=none commits=0 lines=0 added=0 moved=no|handback all-dismissed
score=3 paid=1 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=none commits=1 lines=1 added=0 moved=yes|rereview below-threshold
score=4 paid=1 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=none commits=1 lines=1 added=0 moved=yes critical=true|rereview below-threshold
score=5 paid=1 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=none commits=1 lines=1 added=0 moved=yes critical=true|done threshold
score=4 paid=0 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=none commits=1 lines=1 added=1 moved=yes critical=false|done large-fix
score=3 paid=0 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=3 commits=1 lines=1 added=0 moved=yes|done threshold
score=4 paid=0 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=5 commits=1 lines=1 added=0 moved=yes|rereview below-threshold
score=5 paid=0 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=5 commits=1 lines=1 added=0 moved=yes|done threshold
score=3 paid=0 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=4 commits=1 lines=1 added=0 moved=yes|rereview below-threshold
score=4 paid=0 running=no skipped=no reviewed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa required=3 commits=1 lines=1 added=0 moved=yes critical=true|rereview below-threshold
score=4 paid=0 running=no skipped=no reviewed=none unknown=true|usage
score=4 paid=0 running=no skipped=no reviewed=none commits=1|usage
paid=0 running=no skipped=no reviewed=none|usage
score=6 paid=0 running=no skipped=no reviewed=none|usage
score=4 paid=-1 running=no skipped=no reviewed=none|usage
score=4 paid=0 running=maybe skipped=no reviewed=none|usage
score=4 paid=0 running=no skipped=maybe reviewed=none|usage
score=4 paid=0 running=no skipped=no reviewed=none required=bad|usage
score=4 paid=0 running=no skipped=no reviewed=abc|usage
score=4 paid=0 running=no skipped=no reviewed=none critical=yes|usage
score=4 paid=0 running=no skipped=no reviewed=none commits=1 lines=-1 added=0 moved=yes|usage
score=4 paid=0 running=no skipped=no reviewed=none commits=1 lines=1 added=0 moved=maybe|usage
score=4 paid=0 running=no skipped=no reviewed=none score=3|usage
score=4 paid=0 running=no skipped=no reviewed=none malformed|usage
score=4 paid=0 running=no skipped=no reviewed=none|usage
score=4 paid=0 running=no skipped=no reviewed=none required=6|usage
score=none paid=0 running=no skipped=no reviewed=none required=none present=maybe|usage
score=none paid=0 running=no skipped=no reviewed=none required=none gate=decide|usage
TABLE

quoted=$(sh "$script_dir/decide.sh" "$check_state" 'score=3 paid=1 running=no skipped=no reviewed=none required=none') \
  || fail 'decision rejected a quoted score line'

[ "$quoted" = 'handback no-reviewed-commit' ] || fail "quoted decision: got $quoted"
decision="score=3 paid=2 running=no skipped=no reviewed=$a required=none commits=1 lines=5 added=0 moved=yes"
[ "$(sh "$script_dir/decide.sh" "$check_state" $decision)" = 'handback paid-cap' ] || fail 'base paid cap'
printf 'GREPTILE_REREVIEWS=3\n' >> "$SKILLS_CONF"
[ "$(sh "$script_dir/decide.sh" "$check_state" $decision)" = 'rereview below-threshold' ] || fail 'configured paid cap'
printf 'DELIVERY=prs\nWITH=greptile\nGREPTILE_THRESHOLD=3\n' > "$SKILLS_CONF"
[ "$(sh "$script_dir/decide.sh" "$check_state" $decision)" = 'done threshold' ] || fail 'configured threshold'
printf 'DELIVERY=prs\nWITH=greptile\nGREPTILE_CRITICAL_THRESHOLD=4\n' > "$SKILLS_CONF"
decision="score=4 paid=2 running=no skipped=no reviewed=$a required=none commits=1 lines=5 added=0 moved=yes critical=true"
[ "$(sh "$script_dir/decide.sh" "$check_state" $decision)" = 'done threshold' ] || fail 'configured critical threshold'
printf 'DELIVERY=prs\nWITH=greptile\n' > "$SKILLS_CONF"
[ ! -s "$GH_STUB_LOG" ] || fail 'decision called gh'

check_fixture "$(python3 -c "$fixture_program" body-edits-newest-first | python3 -c '
import json
import sys

data = json.load(sys.stdin)
pr = data["data"]["repository"]["pullRequest"]
pr["timelineItems"] = {"nodes": []}
pr["reviewThreads"] = {"nodes": []}
for item in pr["comments"]["nodes"]:
  item["createdAt"] = item["updatedAt"]

for node in pr["commits"]["nodes"]:
  node["commit"].update(committedDate=pr["createdAt"], checkSuites={"nodes": []})

print(json.dumps(data))
')"
graphql_fixture "$(python3 -c "$fixture_program" body-edits-newest-first)"
trigger_fixture ''
[ "$(sh "$script_dir/verdict.sh" gate 18)" = 'triage scored' ] || fail 'gate verdict differs'
[ "$(sh "$script_dir/verdict.sh" gate 18 critical=true)" = 'triage scored' ] || fail 'critical gate verdict differs'
[ "$(sh "$script_dir/verdict.sh" decide 18 main)" = 'triage scored' ] || fail 'decide without outcome differs'

graphql_fixture "$(python3 -c "$fixture_program" no-reviewed)"
[ "$(sh "$script_dir/verdict.sh" decide 18 main outcome=fixed)" = 'handback no-reviewed-commit' ] || fail 'fixed without reviewed commit differs'
[ "$(sh "$script_dir/verdict.sh" decide 18 main outcome=dismissed)" = 'handback no-reviewed-commit' ] || fail 'dismissed without reviewed commit differs'

cd "$tmp/repo"
graphql_fixture "$(python3 -c "$fixture_program" body-edits-newest-first | sed "s/$a/$adapter_reviewed/g")"
[ "$(sh "$script_dir/verdict.sh" decide 18 feature critical=true outcome=fixed)" = 'rereview below-threshold' ] || fail 'fixed outcome did not read fix facts'
[ "$(sh "$script_dir/verdict.sh" decide 18 feature critical=true outcome=dismissed)" = 'handback all-dismissed' ] || fail 'dismissed outcome counted another fix'
feature_tip=$(git rev-parse feature)
graphql_fixture "$(python3 -c "$fixture_program" body-edits-newest-first | sed "s/$a/$feature_tip/g")"
[ "$(sh "$script_dir/verdict.sh" decide 18 feature outcome=fixed)" = 'triage scored' ] || fail 'review of the fixed tip was not triaged'
expect_refusal 1 'verdict: branch is not a local branch' sh "$script_dir/verdict.sh" decide 18 missing outcome=fixed
expect_refusal 2 'usage: verdict.sh' sh "$script_dir/verdict.sh" gate x
expect_refusal 2 'usage: verdict.sh' sh "$script_dir/verdict.sh" gate 18 outcome=fixed
expect_refusal 2 'usage: verdict.sh' sh "$script_dir/verdict.sh" decide 18 main outcome=other
export REVIEW_NOW=2026-09-28T12:00:00Z
printf 'DELIVERY=prs\nWITH=greptile\n' > "$SKILLS_CONF"
acceptance_program='
import datetime as dt
import json
import sys

case = sys.argv[1]
name = sys.argv[2]
bot = {"login": "greptile-apps" if name == "greptile" else "coderabbitai"}
trigger = "@greptileai" if name == "greptile" else "@coderabbitai review"
now = dt.datetime.fromisoformat("2026-09-28T12:00:00+00:00")

def stamp(age):
  return (now - dt.timedelta(seconds=age)).strftime("%Y-%m-%dT%H:%M:%SZ")

def context(age, pending=False):
  if name == "greptile":
    return {"__typename": "CheckRun", "name": "Greptile Review", "status": "IN_PROGRESS" if pending else "COMPLETED", "startedAt": stamp(age), "completedAt": None if pending else stamp(age), "checkSuite": {"createdAt": stamp(age)}, "title": "Base review: Confidence 3/5, below your required 4/5"}
  return {"__typename": "StatusContext", "context": "CodeRabbit", "state": "PENDING" if pending else "SUCCESS", "description": "Review in progress" if pending else "Review completed", "createdAt": stamp(age)}

def commit(oid, age, checks):
  return {"commit": {"oid": oid * 40, "committedDate": stamp(age), "checkSuites": {"nodes": [{"createdAt": stamp(age)}]}, "statusCheckRollup": {"contexts": {"nodes": checks}}}}

pr = {
  "createdAt": stamp(3600),
  "body": "",
  "timelineItems": {"nodes": []},
  "userContentEdits": {"nodes": []},
  "comments": {"nodes": []},
  "reviews": {"nodes": []},
  "reviewThreads": {"nodes": []},
  "commits": {"nodes": [commit("a", 90, [])]},
}
head = pr["commits"]["nodes"][-1]["commit"]
if case in ("pending", "timeout", "pending-boundary", "queued", "newest-time", "tie-time"):
  age = {"timeout": 1500, "pending-boundary": 1200, "queued": 1500}.get(case, 30)
  head.update(committedDate=stamp(1800), checkSuites={"nodes": [{"createdAt": stamp(1800)}]})
  checks = [context(age, True)]
  if case == "queued":
    checks[0].update(status="QUEUED", startedAt=None)
  if case == "newest-time":
    checks.append(context(100))
  if case == "tie-time":
    checks.insert(0, context(age))
  head["statusCheckRollup"]["contexts"]["nodes"] = checks
elif case in ("appear", "appear-boundary", "future", "push-suite"):
  age = {"appear": 30, "appear-boundary": 60, "future": -30, "push-suite": 30}[case]
  head["committedDate"] = stamp(age if case != "push-suite" else 1800)
  head["checkSuites"]["nodes"] = [{"createdAt": stamp(age)}]
elif case in ("trigger", "trigger-old", "trigger-boundary", "trigger-tie"):
  age = 60 if case == "trigger-boundary" else 90
  pr["comments"]["nodes"] = [
    {"author": bot, "body": "Walkthrough.", "createdAt": stamp(1800), "updatedAt": stamp(1800)},
    {"author": {"login": "developer"}, "body": " " + trigger + " ", "createdAt": stamp(age), "updatedAt": stamp(age)},
  ]
  if case != "trigger-tie":
    head["committedDate"] = stamp(1800)
    head["checkSuites"]["nodes"] = [{"createdAt": stamp(1800)}]
  if case == "trigger-old":
    head["statusCheckRollup"]["contexts"]["nodes"] = [context(1800)]
elif case in ("queued-rerun", "overtaken"):
  head.update(committedDate=stamp(1800), checkSuites={"nodes": [{"createdAt": stamp(1800)}]})
  if case == "queued-rerun":
    pr["comments"]["nodes"] = [{"author": {"login": "developer"}, "body": trigger, "createdAt": stamp(30), "updatedAt": stamp(30)}]
    run = context(1500, True)
    run.update(status="QUEUED", startedAt=None)
    head["statusCheckRollup"]["contexts"]["nodes"] = [run]
  else:
    older = context(600)
    older["completedAt"] = stamp(10)
    head["statusCheckRollup"]["contexts"]["nodes"] = [older, context(300, True)]
elif case in ("seen-push", "older-pending", "older-pending-fresh"):
  pr["commits"]["nodes"].insert(0, commit("b", 1800, [context(100 if case == "older-pending-fresh" else 1700, case != "seen-push")]))
  if case == "seen-push" and name == "greptile":
    pr["reviews"]["nodes"] = [{"author": bot, "body": "Confidence Score: 3/5", "submittedAt": stamp(1700), "commit": {"oid": "b" * 40}}]
elif case in ("ready", "open"):
  if case == "ready":
    pr["timelineItems"]["nodes"] = [{"createdAt": stamp(30)}]
  else:
    pr["createdAt"] = stamp(30)
elif case in ("completed", "no-score-fresh", "no-score-boundary"):
  age = {"completed": 90, "no-score-fresh": 30, "no-score-boundary": 60}[case]
  head["statusCheckRollup"]["contexts"]["nodes"] = [context(age)]
elif case in ("body-seen", "thread-seen", "full-edits", "full-comments", "full-reviews", "full-threads", "full-commits", "full-contexts", "full-suites", "human-only", "expected"):
  human = {"login": "developer"}
  if case == "body-seen":
    pr["userContentEdits"]["nodes"] = [{"editor": {"login": bot["login"].upper() + "[bot]"}, "editedAt": stamp(1800)}]
  if case == "thread-seen":
    pr["reviewThreads"]["nodes"] = [{"isResolved": True, "comments": {"nodes": [{"author": bot, "body": "Finding.", "originalCommit": {"oid": "a" * 40}}]}}]
  if case == "human-only":
    pr["comments"]["nodes"] = [{"author": {"login": bot["login"] + "-fan"}, "body": "Hi", "createdAt": stamp(1800), "updatedAt": stamp(1800)}]
  if case == "expected":
    head["statusCheckRollup"]["contexts"]["nodes"] = [{"__typename": "StatusContext", "context": "CodeRabbit", "state": "EXPECTED", "createdAt": stamp(90), "description": None}]
  if case == "full-edits":
    pr["userContentEdits"]["nodes"] = [{"editor": human, "editedAt": stamp(1800)}] * 20
  if case == "full-comments":
    pr["comments"]["nodes"] = [{"author": human, "body": "Hi", "createdAt": stamp(1800), "updatedAt": stamp(1800)}] * 100
  if case == "full-reviews":
    pr["reviews"]["nodes"] = [{"author": human, "body": "", "state": "COMMENTED", "submittedAt": stamp(1800), "commit": {"oid": "a" * 40}}] * 100
  if case == "full-threads":
    pr["reviewThreads"]["nodes"] = [{"isResolved": True, "comments": {"nodes": [{"author": human, "body": "Hi"}]}}] * 100
  if case == "full-commits":
    pr["commits"]["nodes"] = [commit("b", 1800, [])] * 99 + pr["commits"]["nodes"]
  if case == "full-contexts":
    head["statusCheckRollup"]["contexts"]["nodes"] = [{"__typename": "CheckRun", "name": "build", "status": "COMPLETED", "completedAt": stamp(90), "title": "build"}] * 100
  if case == "full-suites":
    head["checkSuites"]["nodes"] *= 100
elif case != "absent":
  raise ValueError(case)

print(json.dumps({"data": {"repository": {"pullRequest": pr}}}))
'

acceptance_case() {
  name=$1
  expected=$2
  response=$(python3 -c "$acceptance_program" "$name" greptile)
  graphql_fixture "$response"
  check_fixture "$response"
  trigger_fixture "$(printf '%s' "$response" | python3 -c '
import json
import sys

pr = json.load(sys.stdin)["data"]["repository"]["pullRequest"]
print("\n".join(item["createdAt"] for item in pr["comments"]["nodes"] if item["body"].strip() == "@greptileai"))
')"
  actual=$(sh "$script_dir/verdict.sh" gate 18) || fail "$name gate failed"
  [ "$actual" = "$expected" ] || fail "$name gate: expected $expected, got $actual"
}

acceptance_case pending 'wait check-pending'
acceptance_case appear 'wait check-appear'
response=$(python3 -c "$acceptance_program" appear greptile)
graphql_fixture "$response"
check_fixture "$response"
trigger_fixture ''
: > "$GH_STUB_LOG"
[ "$(sh "$script_dir/verdict.sh" decide 18 main)" = 'wait check-appear' ] || fail 'appear decide differs'
[ "$(grep -c check-state.graphql "$GH_STUB_LOG")" -eq 1 ] || fail 'appear decide read check state more than once'
acceptance_case absent absent
acceptance_case trigger 'unavailable no-review'
acceptance_case trigger-old 'unavailable no-review'
acceptance_case timeout 'unavailable timeout'
acceptance_case pending-boundary 'unavailable timeout'
acceptance_case appear-boundary absent
acceptance_case trigger-boundary 'unavailable no-review'
acceptance_case trigger-tie 'unavailable no-review'
acceptance_case future 'wait check-appear'
acceptance_case push-suite 'wait check-appear'
acceptance_case newest-time 'wait check-pending'
acceptance_case tie-time 'wait check-pending'
acceptance_case ready 'wait check-appear'
acceptance_case open 'wait check-appear'
acceptance_case human-only absent
acceptance_case full-suites absent
acceptance_case queued 'unavailable timeout'
acceptance_case older-pending 'handback no-score'
acceptance_case older-pending-fresh 'wait check-pending'
acceptance_case queued-rerun 'wait check-pending'
acceptance_case overtaken 'wait check-pending'
acceptance_case no-score-fresh 'wait no-score'
acceptance_case no-score-boundary 'handback no-score'
acceptance_case seen-push 'triage scored'
check_state=$(sh "$playbook_dir/check-state.sh" 18 'Greptile Review' '@greptileai' 'greptile-apps greptile-apps[bot]')
score=$(sh "$script_dir/score.sh" 18)
[ "$(sh "$script_dir/decide.sh" "$check_state" "$score" 'commits=1 lines=5 added=0 moved=yes')" = 'rereview below-threshold' ] || fail 'seen push with small fix'
for name in body-seen thread-seen full-edits full-comments full-reviews full-threads full-commits full-contexts; do
  acceptance_case "$name" 'handback no-score'
done

echo ok
