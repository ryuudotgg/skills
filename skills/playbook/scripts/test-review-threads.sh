#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
playbook_dir=$script_dir
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

echo ok
