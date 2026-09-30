#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
stub_bin=$(CDPATH= cd "$script_dir/../../../scripts/stubs" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/reviewers.XXXXXX")
trap 'rm -rf "$tmp"' 0

export GH_STUB_DIR="$tmp/gh" GH_STUB_LOG="$tmp/gh.log"
export SKILLS_CONF="$tmp/skills.conf" PLANS_DIR="$tmp/plans"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
PATH="$stub_bin:$PATH"
export PATH

skills=$tmp/skills
mkdir -p "$GH_STUB_DIR" "$skills/playbook/scripts" "$skills/plans/scripts" "$tmp/bin"
playbook_dir=$(CDPATH= cd "$skills/playbook/scripts" && pwd -P)
plans_dir=$(CDPATH= cd "$skills/plans/scripts" && pwd -P)
for file in check-state.sh check-state.graphql reviewers.sh delivery-mode.sh extension-verdict.sh reply.sh resolve.sh threads.graphql reply.graphql resolve.graphql; do
  cp "$script_dir/$file" "$playbook_dir/$file"
done

for file in below.sh chain.sh project.sh unresolved.graphql; do
  cp "$script_dir/../../plans/scripts/$file" "$plans_dir/$file"
done

for name in greptile testbot thirdbot; do
  mkdir -p "$skills/$name"
  printf '%s\n' '---' "name: $name" 'description: Reviewer extension.' \
    'optional: true' 'requires: prs' '---' > "$skills/$name/SKILL.md"
done

cp "$script_dir/../../greptile/reviewer.conf" "$skills/greptile/reviewer.conf"
cat > "$skills/testbot/reviewer.conf" <<'EOF'
NAME=TestBot
LOGINS=testbot testbot[bot]
HANDLES=@testbot
TRIGGER=@testbot review
CHECK=TestBot
EOF
cat > "$skills/thirdbot/reviewer.conf" <<'EOF'
NAME=ThirdBot
LOGINS=thirdbot[bot] thirdbot
HANDLES=@thirdbot
TRIGGER=@thirdbot go
CHECK=ThirdBot
SETTING_BUDGET=1 [0-9]
EOF
printf 'DELIVERY=prs\nWITH=greptile testbot\n' > "$SKILLS_CONF"
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

command -v jq > /dev/null || fail 'jq is required'

actual=$(sh "$playbook_dir/reviewers.sh" NAME)
expected=$(printf 'greptile\tGreptile\ntestbot\tTestBot\nthirdbot\tThirdBot')
[ "$actual" = "$expected" ] || fail "installed names: $actual"
actual=$(sh "$playbook_dir/reviewers.sh" --active NAME)
expected=$(printf 'greptile\tGreptile\ntestbot\tTestBot')
[ "$actual" = "$expected" ] || fail "active names: $actual"
actual=$(sh "$playbook_dir/reviewers.sh" --settings)
expected=$(printf 'greptile\trereviews\t2\t[0-9]\ngreptile\tthreshold\t4\t[1-5]\ngreptile\tcritical-threshold\t5\t[1-5]\nthirdbot\tbudget\t1\t[0-9]')
[ "$actual" = "$expected" ] || fail "settings: $actual"
actual=$(sh "$playbook_dir/reviewers.sh" --active --settings)
expected=$(printf 'greptile\trereviews\t2\t[0-9]\ngreptile\tthreshold\t4\t[1-5]\ngreptile\tcritical-threshold\t5\t[1-5]')
[ "$actual" = "$expected" ] || fail "active settings: $actual"
[ -z "$(sh "$playbook_dir/reviewers.sh" UNDECLARED)" ] || fail 'unknown key printed stdout'
expect_refusal 2 'usage: reviewers.sh' sh "$playbook_dir/reviewers.sh" bad-key

cp "$skills/thirdbot/reviewer.conf" "$tmp/thirdbot.conf"
for defect in missing duplicate login twin botonly trigger malformed setting-key setting-default setting-regex setting-collision; do
  case $defect in
    missing) sed '/^TRIGGER=/d' "$tmp/thirdbot.conf" > "$skills/thirdbot/reviewer.conf" ;;
    duplicate) cat "$tmp/thirdbot.conf" "$tmp/thirdbot.conf" > "$skills/thirdbot/reviewer.conf" ;;
    login) sed 's/^LOGINS=.*/LOGINS=thirdbot-fan!/' "$tmp/thirdbot.conf" > "$skills/thirdbot/reviewer.conf" ;;
    twin) sed 's/^LOGINS=.*/LOGINS=ryuu/' "$tmp/thirdbot.conf" > "$skills/thirdbot/reviewer.conf" ;;
    botonly) sed 's/^LOGINS=.*/LOGINS=thirdbot[bot]/' "$tmp/thirdbot.conf" > "$skills/thirdbot/reviewer.conf" ;;
    trigger) sed 's/^TRIGGER=.*/TRIGGER=LGTM, merging now/' "$tmp/thirdbot.conf" > "$skills/thirdbot/reviewer.conf" ;;
    malformed) printf '%s\n' 'bad line' > "$skills/thirdbot/reviewer.conf" ;;
    setting-key) sed 's/^SETTING_BUDGET=/SETTING_bad=/' "$tmp/thirdbot.conf" > "$skills/thirdbot/reviewer.conf" ;;
    setting-default) sed 's/^SETTING_BUDGET=.*/SETTING_BUDGET=wrong [0-9]/' "$tmp/thirdbot.conf" > "$skills/thirdbot/reviewer.conf" ;;
    setting-regex) sed 's/^SETTING_BUDGET=.*/SETTING_BUDGET=1 [/' "$tmp/thirdbot.conf" > "$skills/thirdbot/reviewer.conf" ;;
    setting-collision) cp "$tmp/thirdbot.conf" "$skills/thirdbot/reviewer.conf"
      printf '%s\n' 'SETTING_X_BUDGET=1 [0-9]' >> "$skills/testbot/reviewer.conf"
      mkdir -p "$skills/testbot-x"
      cp "$skills/testbot/SKILL.md" "$skills/testbot-x/SKILL.md"
      cp "$tmp/thirdbot.conf" "$skills/testbot-x/reviewer.conf"
      ;;
  esac

  expect_refusal 1 'reviewers:' sh "$playbook_dir/reviewers.sh" NAME
  if [ "$defect" = setting-collision ]; then
    grep -Fq 'setting key TESTBOT_X_BUDGET is claimed twice' "$tmp/err" || fail 'setting collision did not collide'
  fi
  expect_refusal 1 'reviewers:' sh "$playbook_dir/reviewers.sh" --active NAME
done
sed '/^SETTING_X_BUDGET=/d' "$skills/testbot/reviewer.conf" > "$tmp/testbot.conf"
cp "$tmp/testbot.conf" "$skills/testbot/reviewer.conf"
rm -rf "$skills/testbot-x"

cp "$tmp/thirdbot.conf" "$skills/thirdbot/reviewer.conf"
printf '# ignored\r\n\r\n' > "$tmp/crlf.conf"
sed 's/$/\r/' "$tmp/thirdbot.conf" >> "$tmp/crlf.conf"
cp "$tmp/crlf.conf" "$skills/thirdbot/reviewer.conf"
actual=$(sh "$playbook_dir/reviewers.sh" NAME)
[ "$actual" = "$(printf 'greptile\tGreptile\ntestbot\tTestBot\nthirdbot\tThirdBot')" ] || fail 'CRLF declarations differ'
cp "$tmp/thirdbot.conf" "$skills/thirdbot/reviewer.conf"

pull=https://github.com/owner/repo/pull/18#discussion_r
comment() {
  printf '{"url":"%s%s","author":%s}' "$pull" "$1" "$2"
}

thread() {
  printf '{"id":"%s","isResolved":%s,"comments":{"nodes":[%s]}}' "$1" "$2" "$3"
}

threads_fixture() {
  fixture "$1" 0 api graphql -F 'owner={owner}' -F 'repo={repo}' -F number=18 -F "query=@$playbook_dir/threads.graphql"
}

reply_fixture() {
  key=$(printf '%s' "api graphql -F query=@$playbook_dir/reply.graphql -f id=T1" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s' "$1" > "$GH_STUB_DIR/$key.prefix"
  printf '0\n' > "$GH_STUB_DIR/$key.prefix.exit"
}

threads_fixture "{\"data\":{\"repository\":{\"pullRequest\":{\"reviewThreads\":{\"nodes\":[
$(thread T1 false "$(comment 10 '{"login":"testbot"}'),$(comment 11 '{"login":"greptile-apps"}')"),
$(thread T2 false "$(comment 20 '{"login":"testbot"}'),$(comment 21 '{"login":"developer"}')"),
$(thread T3 false "$(comment 30 '{"login":"thirdbot"}')"),
$(thread T4 false "$(comment 40 '{"login":"TESTBOT[bot]"}'),$(comment 41 '{"login":"Greptile-Apps[bot]"}')"),
$(thread T5 false "$(comment 50 '{"login":"testbot"}'),$(comment 51 null)"),
$(thread T6 false "$(comment 60 '{"login":"testbot-fan"}')"),
$(thread T7 false "$(comment 70 '{"login":"testbot"}'),$(comment 71 '{"login":"testbot-fan"}')")
]}}}}}"
printf 'Fixed the lookup.\n' > "$tmp/body"
reply_fixture "${pull}12"
fixture true 0 api graphql -F "query=@$playbook_dir/resolve.graphql" -f id=T1 --jq .data.resolveReviewThread.thread.isResolved
fixture true 0 api graphql -F "query=@$playbook_dir/resolve.graphql" -f id=T4 --jq .data.resolveReviewThread.thread.isResolved

actual=$(sh "$playbook_dir/reply.sh" 18 "${pull}10" "$tmp/body") || fail 'mixed reviewer reply failed'
[ "$actual" = "replied ${pull}12
resolved ${pull}10" ] || fail "reply: $actual"

for id in 20 30 50 60 70; do
  : > "$GH_STUB_LOG"
  expect_refusal 1 "${pull}$id is not in a thread only Greptile or TestBot has written in" \
    sh "$playbook_dir/reply.sh" 18 "${pull}$id" "$tmp/body"
  ! grep -Eq '(reply|resolve)\.graphql' "$GH_STUB_LOG" || fail 'reply wrote before refusing'
done

printf 'This lands in the Hooks batch (plan 090).\n' > "$tmp/plan"
: > "$GH_STUB_LOG"
expect_refusal 1 'names a plan id' sh "$playbook_dir/reply.sh" 18 "${pull}10" "$tmp/plan"
[ ! -s "$GH_STUB_LOG" ] || fail 'plan id called gh'

printf 'Fixed, @ThirdBot take a look.\n' > "$tmp/mention"
: > "$GH_STUB_LOG"
expect_refusal 1 'mentions @thirdbot, which summons ThirdBot' sh "$playbook_dir/reply.sh" 18 "${pull}10" "$tmp/mention"
[ ! -s "$GH_STUB_LOG" ] || fail 'mention called gh'

: > "$GH_STUB_LOG"
actual=$(sh "$playbook_dir/resolve.sh" 18 "${pull}10" "${pull}20" "${pull}40" "${pull}50" "${pull}70") || fail 'resolve failed'
[ "$actual" = "resolved ${pull}10
left-open ${pull}20 reply-from=developer
resolved ${pull}40
left-open ${pull}50 reply-from=ghost
left-open ${pull}70 reply-from=testbot-fan" ] || fail "resolve: $actual"
! grep -Eq 'id=T[257]' "$GH_STUB_LOG" || fail 'resolve closed a human thread'

: > "$GH_STUB_LOG"
expect_refusal 1 'Greptile or TestBot did not start' sh "$playbook_dir/resolve.sh" 18 "${pull}30"
expect_refusal 1 'Greptile or TestBot did not start' sh "$playbook_dir/resolve.sh" 18 "${pull}60"
! grep -Fq resolve.graphql "$GH_STUB_LOG" || fail 'resolve wrote before refusing'

sed '/^TRIGGER=/d' "$tmp/thirdbot.conf" > "$skills/thirdbot/reviewer.conf"
: > "$GH_STUB_LOG"
expect_refusal 1 'cannot read reviewer declarations' sh "$playbook_dir/reply.sh" 18 "${pull}10" "$tmp/body"
expect_refusal 1 'cannot read reviewer declarations' sh "$playbook_dir/resolve.sh" 18 "${pull}10"
[ ! -s "$GH_STUB_LOG" ] || fail 'unreadable declarations called gh'
cp "$tmp/thirdbot.conf" "$skills/thirdbot/reviewer.conf"

printf 'DELIVERY=hands-off\nWITH=greptile testbot\n' > "$SKILLS_CONF"
[ -z "$(sh "$playbook_dir/reviewers.sh" --active NAME)" ] || fail 'hands-off reviewers active'
for script in reply resolve; do
  if [ "$script" = reply ]; then
    expect_refusal 1 'greptile is not active in prs mode' sh "$playbook_dir/$script.sh" 18 "${pull}10" "$tmp/body"
  else
    expect_refusal 1 'greptile is not active in prs mode' sh "$playbook_dir/$script.sh" 18 "${pull}10"
  fi

  for name in testbot thirdbot; do
    grep -Fq "$name is not active in prs mode" "$tmp/err" || fail "missing inactive reviewer: $name"
  done
done

[ ! -s "$GH_STUB_LOG" ] || fail 'inactive reviewers called gh'
printf 'DELIVERY=prs\nWITH=greptile testbot\n' > "$SKILLS_CONF"

mkdir -p "$PLANS_DIR/Proj" "$tmp/Proj"
printf 'id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote\n1\ta\tREVIEW\tP1\tS\t-\t-\tfeat/a\t2026-09-27\t-\n' > "$PLANS_DIR/Proj/index.tsv"
git init --quiet -b main "$tmp/Proj"
git -C "$tmp/Proj" config branch.feat/a.skills-base origin/main
export BELOW_FIXTURE="$tmp/below.json"
printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[%s,%s,%s,%s]}}}}}\n' \
  "$(thread B1 false "$(comment 60 '{"login":"testbot"}')")" \
  "$(thread B2 false "$(comment 61 '{"login":"developer"}')")" \
  "$(thread B3 false "$(comment 62 '{"login":"thirdbot-fan"}')")" \
  "$(thread B4 true "$(comment 63 '{"login":"testbot"}')")" > "$BELOW_FIXTURE"
cat > "$tmp/bin/gh" <<'SH'
#!/bin/sh
set -eu

printf '%s\n' "$*" >> "$GH_STUB_LOG"
case "$1 $2" in
  'pr list') printf 'OPEN 1\n' ;;

  'api graphql')
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --jq ]; then
        shift
        exec jq -r "$1" "$BELOW_FIXTURE"
      fi

      shift
    done

    exit 1
    ;;

  *) exit 1 ;;
esac
SH
chmod 755 "$tmp/bin/gh"
PATH="$tmp/bin:$PATH"
export PATH
cd "$tmp/Proj"

expect_refusal 1 'unresolved Greptile or TestBot or ThirdBot threads below the base' sh "$plans_dir/below.sh" Proj feat/a
grep -Fq "${pull}60" "$tmp/err" || fail 'missing testbot thread'
! grep -Eq 'discussion_r6[123]' "$tmp/err" || fail 'below included another thread'
[ "$(tail -n 1 "$tmp/err")" = 'below: unresolved Greptile or TestBot or ThirdBot threads below the base' ] || fail 'below refusal names differ'

sed '/^TRIGGER=/d' "$tmp/thirdbot.conf" > "$skills/thirdbot/reviewer.conf"
: > "$GH_STUB_LOG"
expect_refusal 1 'cannot read reviewer declarations' sh "$plans_dir/below.sh" Proj feat/a
[ ! -s "$GH_STUB_LOG" ] || fail 'below queried with unreadable declarations'

for name in greptile testbot thirdbot; do
  rm "$skills/$name/reviewer.conf"
done

expect_refusal 1 'no reviewer is installed' sh "$playbook_dir/reply.sh" 18 "${pull}10" "$tmp/body"
expect_refusal 1 'no reviewer is installed' sh "$playbook_dir/resolve.sh" 18 "${pull}10"
[ ! -s "$GH_STUB_LOG" ] || fail 'missing reviewers called gh'
actual=$(sh "$plans_dir/below.sh" Proj feat/a) || fail 'below failed without reviewers'
[ -z "$actual" ] || fail 'below printed stdout without reviewers'
grep -Fq 'pr list' "$GH_STUB_LOG" || fail 'below skipped PR state'
! grep -Fq 'api graphql' "$GH_STUB_LOG" || fail 'below queried threads without reviewers'

mkdir -p "$skills/coderabbit"
cp "$script_dir/../../coderabbit/reviewer.conf" "$skills/coderabbit/reviewer.conf"
cp "$script_dir/../../coderabbit/SKILL.md" "$skills/coderabbit/SKILL.md"
printf 'DELIVERY=prs\nWITH=coderabbit\n' > "$SKILLS_CONF"
PATH="$stub_bin:$PATH"
export PATH
threads_fixture "{\"data\":{\"repository\":{\"pullRequest\":{\"reviewThreads\":{\"nodes\":[
$(thread T1 false "$(comment 10 '{"login":"coderabbitai"}'),$(comment 11 '{"login":"coderabbitai[bot]"}')"),
$(thread T2 false "$(comment 20 '{"login":"coderabbitai"}'),$(comment 21 '{"login":"developer"}')")
]}}}}}"
reply_fixture "${pull}12"
fixture true 0 api graphql -F "query=@$playbook_dir/resolve.graphql" -f id=T1 --jq .data.resolveReviewThread.thread.isResolved
: > "$GH_STUB_LOG"
actual=$(sh "$playbook_dir/reply.sh" 18 "${pull}10" "$tmp/body") || fail 'coderabbit reply failed'
[ "$actual" = "replied ${pull}12
resolved ${pull}10" ] || fail "coderabbit reply: $actual"
grep -Fq "query=@$playbook_dir/reply.graphql" "$GH_STUB_LOG" || fail 'coderabbit reply did not post'
grep -Fq "query=@$playbook_dir/resolve.graphql" "$GH_STUB_LOG" || fail 'coderabbit reply did not resolve'
: > "$GH_STUB_LOG"
expect_refusal 1 "${pull}20 is not in a thread only CodeRabbit has written in" sh "$playbook_dir/reply.sh" 18 "${pull}20" "$tmp/body"
! grep -Eq '(reply|resolve)\.graphql' "$GH_STUB_LOG" || fail 'coderabbit human thread was changed'

: > "$GH_STUB_LOG"
limits=$(sh "$playbook_dir/check-state.sh" --limits)
[ "$(printf '%s\n' "$limits" | cut -d = -f 1)" = "$(printf 'window\ncap')" ] || fail 'check limits keys differ'
[ ! -s "$GH_STUB_LOG" ] || fail 'limits queried GitHub'
expect_refusal 2 'usage: check-state.sh' sh "$playbook_dir/check-state.sh" x CHECK TRIGGER LOGINS
expect_refusal 2 'usage: check-state.sh' sh "$playbook_dir/check-state.sh" 18 CHECK TRIGGER one two
expect_refusal 2 'usage: check-state.sh' sh "$playbook_dir/check-state.sh" 18 '' TRIGGER LOGINS
fixture '' 1 api graphql -F 'owner={owner}' -F 'repo={repo}' -F number=18 -F "query=@$playbook_dir/check-state.graphql"
expect_refusal 1 'check-state: gh failed reading PR checks' sh "$playbook_dir/check-state.sh" 18 CHECK TRIGGER LOGINS
fixture '{"data":null}' 0 api graphql -F 'owner={owner}' -F 'repo={repo}' -F number=18 -F "query=@$playbook_dir/check-state.graphql"
expect_refusal 1 'check-state: cannot parse PR checks' sh "$playbook_dir/check-state.sh" 18 CHECK TRIGGER LOGINS

response=$(python3 -c '
import json

stamp = "2026-09-28T12:00:00Z"
pr = {
  "createdAt": stamp,
  "timelineItems": {"nodes": [{"createdAt": stamp}]},
  "userContentEdits": {"nodes": []},
  "comments": {"nodes": [{"author": {"login": "developer"}, "body": " @greptileai ", "createdAt": stamp}]},
  "reviews": {"nodes": []},
  "reviewThreads": {"nodes": []},
  "commits": {"nodes": [{"commit": {
    "oid": "a" * 40,
    "committedDate": stamp,
    "checkSuites": {"nodes": []},
    "statusCheckRollup": {"contexts": {"nodes": [{"__typename": "CheckRun", "name": "Greptile Review", "status": "QUEUED", "startedAt": None, "completedAt": None, "checkSuite": {"createdAt": stamp}}]}},
  }}]},
}
print(json.dumps({"data": {"repository": {"pullRequest": pr}}}))
')
fixture "$response" 0 api graphql -F 'owner={owner}' -F 'repo={repo}' -F number=18 -F "query=@$playbook_dir/check-state.graphql"
: > "$GH_STUB_LOG"
actual=$(REVIEW_NOW=2026-09-28T12:00:30Z sh "$playbook_dir/check-state.sh" 18 rEvIeW '@greptileai' 'greptile-apps greptile-apps[bot]')
[ "$actual" = 'check=pending seen=yes event=trigger elapsed=30 age=30 gate=pending' ] || fail "shared reader facts: $actual"
[ "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')" -eq 1 ] || fail 'shared reader queried more than once'

echo ok
