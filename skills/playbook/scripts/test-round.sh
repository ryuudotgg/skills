#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/test-round.XXXXXX")
trap 'rm -rf "$tmp"' 0
skills=$tmp/skills
playbook=$skills/playbook/scripts
mkdir -p "$playbook" "$tmp/bin"
for file in round.sh reviewers.sh settings.sh delivery-mode.sh extension-verdict.sh check-state.sh; do
  cp "$script_dir/$file" "$playbook/$file"
done

export SKILLS_CONF="$tmp/skills.conf" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export ROUND_FIXTURES="$tmp" GH_STUB_LOG="$tmp/gh.log"
PATH="$tmp/bin:$script_dir/../../../scripts/stubs:$PATH"
export PATH

cat > "$tmp/bin/gh" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$GH_STUB_LOG"
exit 1
SH
chmod 755 "$tmp/bin/gh"

for name in a r s; do
  mkdir -p "$skills/$name/scripts"
  printf '%s\n' '---' "name: $name" 'description: Fixture reviewer.' 'optional: true' 'requires: prs' '---' > "$skills/$name/SKILL.md"
  cat > "$skills/$name/reviewer.conf" <<EOF
NAME=$name
LOGINS=$name $name[bot]
HANDLES=@$name
TRIGGER=@$name review
CHECK=$name
EOF
  cat > "$skills/$name/scripts/verdict.sh" <<'SH'
#!/bin/sh
name=$(basename "$(dirname "$(dirname "$0")")")
printf '%s %s\n' "$name" "$*" >> "$ROUND_FIXTURES/calls"
cat "$ROUND_FIXTURES/$name.verdict"
[ ! -f "$ROUND_FIXTURES/$name.fail" ]
SH
  printf 'done\n' > "$tmp/$name.verdict"
done

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

configure() {
  printf 'DELIVERY=prs\nWITH=%s\n' "$1" > "$SKILLS_CONF"
  : > "$tmp/calls"
}

check() {
  expected=$1
  shift
  actual=$(sh "$playbook/round.sh" "$@") || fail "round failed: $*"
  [ "$actual" = "$expected" ] || fail "expected [$expected], got [$actual]"
}

check_pair() {
  first=$1
  second=$2
  combined=$3
  reverse=$4
  printf '%s\n' "$first" > "$tmp/r.verdict"
  printf '%s\n' "$second" > "$tmp/s.verdict"
  configure 'r s'
  check "r $first
s $second
$combined" gate 18

  printf '%s\n' "$second" > "$tmp/r.verdict"
  printf '%s\n' "$first" > "$tmp/s.verdict"
  check "r $second
s $first
$reverse" gate 18
}

check_pair done 'unavailable rate-limited' done done
check_pair absent 'unavailable rate-limited' 'handback s unavailable rate-limited' 'handback r unavailable rate-limited'
check_pair absent absent done done
check_pair triage 'unavailable skipped' triage triage
check_pair triage wait wait wait
check_pair 'handback paid-cap' 'handback round-cap' 'handback r paid-cap, s round-cap' 'handback r round-cap, s paid-cap'

configure 'a r'
printf 'done\n' > "$tmp/a.verdict"
printf 'done\n' > "$tmp/r.verdict"
check 'a done
r done
done' gate 18 --wait critical=true
grep -Fxq 'a gate 18 critical=true' "$tmp/calls" || fail 'a did not receive critical'
grep -Fxq 'r gate 18 critical=true' "$tmp/calls" || fail 'r did not receive critical'
! grep -Fq -- '--wait' "$tmp/calls" || fail 'wait reached a reviewer'

printf 'wait\n' > "$tmp/a.verdict"
check 'a wait
r done
wait' decide 18 feat/topic critical=true
grep -Fxq 'a decide 18 feat/topic critical=true' "$tmp/calls" || fail 'decide gained an outcome'

check 'a wait
r done
wait' decide 18 feat/topic r=dismissed
grep -Fxq 'r decide 18 feat/topic outcome=dismissed' "$tmp/calls" || fail 'outcome did not reach reviewer'
! grep -Fq 'a decide 18 feat/topic outcome=' "$tmp/calls" || fail 'outcome reached another reviewer'

status=0
sh "$playbook/round.sh" decide 18 feat/topic s=fixed > "$tmp/out" 2> "$tmp/err" || status=$?
[ "$status" -eq 2 ] && [ ! -s "$tmp/out" ] || fail 'inactive outcome was accepted'

status=0
sh "$playbook/round.sh" decide 18 r=fixed > "$tmp/out" 2> "$tmp/err" || status=$?
[ "$status" -eq 2 ] && [ ! -s "$tmp/out" ] || fail 'missing branch was accepted'

printf 'broken verdict\n' > "$tmp/r.verdict"
check 'a wait
r handback refused
handback r refused' gate 18
printf 'unavailable\n' > "$tmp/r.verdict"
check 'a wait
r handback refused
handback r refused' gate 18
printf 'done\nmore\n' > "$tmp/r.verdict"
check 'a wait
r handback refused
handback r refused' gate 18
printf 'done\n' > "$tmp/r.verdict"
: > "$tmp/r.fail"
check 'a wait
r handback refused
handback r refused' gate 18
rm "$tmp/r.fail"
mv "$skills/r/scripts/verdict.sh" "$tmp/r-script"
check 'a wait
r handback refused
handback r refused' gate 18
sh "$playbook/round.sh" gate 18 2>&1 >/dev/null | grep -Fxq 'round: r has no scripts/verdict.sh' || fail 'missing verdict had no note'
mv "$tmp/r-script" "$skills/r/scripts/verdict.sh"

cat > "$tmp/bin/sleep" <<'SH'
#!/bin/sh
set -eu
printf '%s\n' "$1" >> "$ROUND_SLEPT"
cp "$ROUND_NEXT" "$ROUND_TARGET"
SH
chmod 755 "$tmp/bin/sleep"
export ROUND_TARGET="$tmp/a.verdict" ROUND_NEXT="$tmp/next.verdict" ROUND_SLEPT="$tmp/slept"

configure 'a r'
printf 'wait check-pending\n' > "$tmp/a.verdict"
printf 'done\n' > "$tmp/next.verdict"
: > "$ROUND_SLEPT"
check 'a done
r done
done' gate 18 --wait critical=true
[ "$(wc -l < "$ROUND_SLEPT" | tr -d ' ')" -eq 1 ] || fail 'waiting gate did not sleep once'
[ "$(grep -c '^a gate 18 critical=true$' "$tmp/calls")" -eq 2 ] || fail 'waiting gate did not call a twice'
[ "$(grep -c '^r gate 18 critical=true$' "$tmp/calls")" -eq 2 ] || fail 'waiting gate did not call r twice'

for poll in 7 0 soon ''; do
  expected=$poll
  case $poll in 7) ;; *) expected=30 ;; esac
  configure 'a r'
  printf 'wait check-pending\n' > "$tmp/a.verdict"
  : > "$ROUND_SLEPT"
  ROUND_POLL=$poll sh "$playbook/round.sh" gate 18 --wait > /dev/null 2>&1 || fail "poll $poll round failed"
  [ "$(cat "$ROUND_SLEPT")" = "$expected" ] || fail "poll [$poll] slept [$(cat "$ROUND_SLEPT")], expected $expected"
done

configure 'a r'
printf 'wait check-pending\n' > "$tmp/a.verdict"
: > "$ROUND_SLEPT"
check 'a wait check-pending
r done
wait' gate 18
[ ! -s "$ROUND_SLEPT" ] || fail 'plain gate slept'
check 'a wait check-pending
r done
wait' decide 18 feat/topic
[ ! -s "$ROUND_SLEPT" ] || fail 'decide slept on pending'

configure 'a r'
printf 'wait check-appear\n' > "$tmp/a.verdict"
printf 'rereview below-threshold\n' > "$tmp/next.verdict"
: > "$ROUND_SLEPT"
check 'a rereview below-threshold
r done
rereview' decide 18 feat/topic a=fixed critical=true
[ "$(wc -l < "$ROUND_SLEPT" | tr -d ' ')" -eq 1 ] || fail 'decide did not sleep once on appear'
[ "$(grep -c '^a decide 18 feat/topic outcome=fixed critical=true$' "$tmp/calls")" -eq 2 ] || fail 'decide lost outcome or critical on a pass'
[ "$(grep -c '^r decide 18 feat/topic critical=true$' "$tmp/calls")" -eq 2 ] || fail 'decide did not call r twice'

limits=$(sh "$playbook/check-state.sh" --limits)
window=$(printf '%s\n' "$limits" | sed -n 's/^window=//p')
cap=$(printf '%s\n' "$limits" | sed -n 's/^cap=//p')
export ROUND_DEADLINE=$((10000 + window + cap))
cat > "$tmp/bin/date" <<'SH'
#!/bin/sh
set -eu
[ "$*" = +%s ] || exit 1
if [ -s "$ROUND_SLEPT" ]; then
  printf '%s\n' "$ROUND_DEADLINE"
else
  printf '10000\n'
fi
SH
chmod 755 "$tmp/bin/date"
configure 'a r'
printf 'wait check-appear\n' > "$tmp/a.verdict"
printf 'wait check-appear\n' > "$tmp/next.verdict"
: > "$ROUND_SLEPT"
check 'a wait check-appear
r done
wait' decide 18 feat/topic
[ "$(wc -l < "$ROUND_SLEPT" | tr -d ' ')" -eq 1 ] || fail 'deadline did not sleep once'
[ "$(wc -l < "$tmp/calls" | tr -d ' ')" -eq 2 ] || fail 'deadline read another pass'
rm "$tmp/bin/date"

configure ''
: > "$GH_STUB_LOG"
check done gate 18
[ ! -s "$GH_STUB_LOG" ] || fail 'empty round called gh'

configure r
printf 'malformed\n' >> "$skills/r/reviewer.conf"
status=0
sh "$playbook/round.sh" gate 18 > "$tmp/out" 2> "$tmp/err" || status=$?
[ "$status" -eq 1 ] && [ ! -s "$tmp/out" ] || fail 'malformed declaration was accepted'

repo=$(CDPATH='' cd "$script_dir/../../.." && pwd -P)
export GH_STUB_DIR="$tmp/real-gh" GH_STUB_LOG="$tmp/real-gh.log"
export ROUND_NEXT_DIR="$tmp/next-gh" ROUND_SLEPT="$tmp/real-slept"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
mkdir -p "$GH_STUB_DIR" "$ROUND_NEXT_DIR"
PATH="$repo/scripts/stubs:$tmp/bin:$PATH"
export PATH
printf 'DELIVERY=prs\nWITH=greptile coderabbit\n' > "$SKILLS_CONF"

cat > "$tmp/bin/sleep" <<'SH'
#!/bin/sh
set -eu
printf '%s\n' "$1" >> "$ROUND_SLEPT"
for fixture in "$ROUND_NEXT_DIR"/*; do
  [ -f "$fixture" ] || continue
  cp "$fixture" "$GH_STUB_DIR/${fixture##*/}"
done
SH
chmod 755 "$tmp/bin/sleep"

real_fixture() {
  destination=$1
  response=$2
  shift 2
  key=$(printf '%s' "$*" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s' "$response" > "$destination/$key"
}

real_fixtures() {
  destination=$1
  response=$2
  real_fixture "$destination" "$response" api graphql -F 'owner={owner}' -F 'repo={repo}' -F number=18 -F "query=@$script_dir/check-state.graphql"
  real_fixture "$destination" "$response" api graphql -F 'owner={owner}' -F 'repo={repo}' -F number=18 -F "query=@$repo/skills/greptile/scripts/score.graphql"
  real_fixture "$destination" "$response" api graphql -F 'owner={owner}' -F 'repo={repo}' -F number=18 -F "query=@$repo/skills/coderabbit/scripts/state.graphql"
  real_fixture "$destination" '' api --paginate 'repos/{owner}/{repo}/issues/18/comments' --jq '.[] | select(.body | test("^\\s*@greptileai\\s*$")) | .created_at'
}

real_reset() {
  : > "$GH_STUB_LOG"
  : > "$ROUND_SLEPT"
  rm -f "$ROUND_NEXT_DIR"/*
}

real_reads() {
  passes=$1
  [ "$(grep -c 'check-state.graphql$' "$GH_STUB_LOG")" -eq "$((passes * 2))" ] || fail "check state reads differ for $passes passes"
  [ "$(grep -c 'score.graphql$' "$GH_STUB_LOG")" -eq "$passes" ] || fail "score reads differ for $passes passes"
  [ "$(grep -c '/state.graphql$' "$GH_STUB_LOG")" -eq "$passes" ] || fail "CodeRabbit state reads differ for $passes passes"
}

real_case() {
  name=$1
  expected=$2
  shift 2
  actual=$(sh "$repo/skills/playbook/scripts/round.sh" "$@") || fail "$name round failed"
  printf '%s\n' "$actual" > "$tmp/real-output"
  [ "$actual" = "$expected" ] || fail "$name: expected [$expected], got [$actual]"
}

real_program='
import datetime as dt
import json
import sys

case, reviewed, head, limited_path = sys.argv[1:]
now = dt.datetime.fromisoformat("2026-09-28T12:00:00+00:00")

def stamp(age):
  return (now - dt.timedelta(seconds=age)).strftime("%Y-%m-%dT%H:%M:%SZ")

def greptile(age, pending=False):
  return {"__typename": "CheckRun", "name": "Greptile Review", "status": "IN_PROGRESS" if pending else "COMPLETED", "startedAt": stamp(age), "completedAt": None if pending else stamp(age), "checkSuite": {"createdAt": stamp(age)}, "title": "Base review: Confidence 3/5, below your required 4/5"}

def coderabbit(age):
  return {"__typename": "StatusContext", "context": "CodeRabbit", "state": "SUCCESS", "description": "Review completed", "createdAt": stamp(age)}

def commit(oid, age, checks):
  return {"commit": {"oid": oid, "committedDate": stamp(age), "checkSuites": {"nodes": [{"createdAt": stamp(age)}]}, "statusCheckRollup": {"contexts": {"nodes": checks}}}}

pr = {
  "createdAt": stamp(3600),
  "body": "",
  "timelineItems": {"nodes": []},
  "userContentEdits": {"nodes": []},
  "comments": {"nodes": []},
  "reviews": {"nodes": []},
  "reviewThreads": {"nodes": []},
  "commits": {"nodes": [commit(head, 90, [])]},
}

if case in ("gate-pending", "gate-completed"):
  checks = [greptile(30, case == "gate-pending"), coderabbit(90)]
  pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"]["contexts"]["nodes"] = checks
  if case == "gate-completed":
    pr["body"] = "Confidence Score: 3/5\nLast reviewed commit: [fix](https://github.com/owner/repo/commit/" + head + ")"
    pr["userContentEdits"]["nodes"] = [{"editedAt": stamp(20), "editor": {"login": "greptile-apps"}}]
elif case == "limited":
  pr = json.load(open(limited_path))["data"]["repository"]["pullRequest"]
  pr["body"] = ""
  pr["userContentEdits"] = {"nodes": []}
  for node in pr["commits"]["nodes"]:
    for context in node["commit"]["statusCheckRollup"]["contexts"]["nodes"]:
      context.setdefault("createdAt", node["commit"]["committedDate"])
elif case.startswith("decide-"):
  pr["body"] = "Confidence Score: 3/5\nLast reviewed commit: [fix](https://github.com/owner/repo/commit/" + reviewed + ")"
  pr["userContentEdits"]["nodes"] = [{"editedAt": stamp(1700), "editor": {"login": "greptile-apps"}}]
  pr["commits"]["nodes"] = [commit(reviewed, 1800, [greptile(1700)]), commit(head, 10, [coderabbit(10)])]
  tip = pr["commits"]["nodes"][-1]["commit"]
  if case == "decide-expired":
    tip.update(committedDate=stamp(90), checkSuites={"nodes": [{"createdAt": stamp(90)}]})
  elif case == "decide-pending":
    tip["statusCheckRollup"]["contexts"]["nodes"].append(greptile(5, True))
  elif case == "decide-completed":
    tip["statusCheckRollup"]["contexts"]["nodes"].append(greptile(5))
    pr["body"] = "Confidence Score: 4/5\nLast reviewed commit: [fix](https://github.com/owner/repo/commit/" + head + ")"
    pr["userContentEdits"]["nodes"] = [{"editedAt": stamp(4), "editor": {"login": "greptile-apps"}}]
  elif case != "decide-start":
    raise ValueError(case)
else:
  raise ValueError(case)

print(json.dumps({"data": {"repository": {"pullRequest": pr}}}))
'

real_response() {
  python3 -c "$real_program" "$1" "$2" "$3" "$repo/skills/coderabbit/scripts/fixtures/rate-limited.json"
}

export REVIEW_NOW=2026-09-28T12:00:00Z
real_reset
real_fixtures "$GH_STUB_DIR" "$(real_response gate-pending none aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)"
real_fixtures "$ROUND_NEXT_DIR" "$(real_response gate-completed none aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)"
real_case 'pending gate' 'coderabbit done clean
greptile triage scored
triage' gate 18 --wait
[ "$(wc -l < "$ROUND_SLEPT" | tr -d ' ')" -eq 1 ] || fail 'pending gate did not sleep once'
real_reads 2

export REVIEW_NOW=2026-09-27T17:11:01Z
real_reset
real_fixtures "$GH_STUB_DIR" "$(real_response limited none aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)"
real_case 'limited handback' 'coderabbit unavailable rate-limited 2
greptile absent
handback coderabbit unavailable rate-limited 2' gate 18 --wait
[ ! -s "$ROUND_SLEPT" ] || fail 'limited handback slept'
real_reads 1

export REVIEW_NOW=2026-09-28T12:00:00Z
mkdir "$tmp/real-repo"
(
  cd "$tmp/real-repo"
  git init --quiet -b main
  git config commit.gpgsign false
  printf 'base\n' > shared
  git add -- shared
  git commit --quiet -m 'chore: base'
  git checkout --quiet -b feature
  git config branch.feature.skills-base main
  printf 'feature\n' >> shared
  git add -- shared
  git commit --quiet -m 'feat: feature'
  git rev-parse HEAD > "$tmp/real-reviewed"
  printf 'fix\n' >> shared
  git add -- shared
  git commit --quiet -m 'fix: small'
  git rev-parse HEAD > "$tmp/real-head"
)
real_reviewed=$(cat "$tmp/real-reviewed")
real_head=$(cat "$tmp/real-head")

for next in expired pending completed; do
  real_reset
  real_fixtures "$GH_STUB_DIR" "$(real_response decide-start "$real_reviewed" "$real_head")"
  real_fixtures "$ROUND_NEXT_DIR" "$(real_response "decide-$next" "$real_reviewed" "$real_head")"
  case $next in
    expired) expected='coderabbit done clean
greptile rereview below-threshold
rereview' ;;
    pending) expected='coderabbit done clean
greptile wait check-pending
wait' ;;
    completed) expected='coderabbit done clean
greptile triage scored
triage' ;;
  esac

  (cd "$tmp/real-repo" && real_case "decide $next" "$expected" decide 18 feature greptile=fixed)
  [ "$(wc -l < "$ROUND_SLEPT" | tr -d ' ')" -eq 1 ] || fail "decide $next did not sleep once"
  real_reads 2
  if [ "$next" != expired ]; then
    ! grep -Fq rereview "$tmp/real-output" || fail "decide $next rereviewed"
  fi
done

cat > "$tmp/bin/date" <<'SH'
#!/bin/sh
set -eu
[ "$*" = +%s ] || exit 1
if [ -s "$ROUND_SLEPT" ]; then
  printf '10000000000\n'
else
  printf '10000\n'
fi
SH
chmod 755 "$tmp/bin/date"
unset ROUND_POLL
real_reset
real_fixtures "$GH_STUB_DIR" "$(real_response decide-start "$real_reviewed" "$real_head")"
real_fixtures "$ROUND_NEXT_DIR" "$(real_response decide-expired "$real_reviewed" "$real_head")"
(cd "$tmp/real-repo" && real_case 'first decide pass' 'coderabbit done clean
greptile wait check-appear
wait' decide 18 feature greptile=fixed)
[ "$(wc -l < "$ROUND_SLEPT" | tr -d ' ')" -eq 1 ] || fail 'first decide pass did not sleep once'
real_reads 1
rm "$tmp/bin/date"

! grep -rF -e sleep -e --wait "$repo/skills/greptile" "$repo/skills/coderabbit" > "$tmp/reviewer-waits" || fail "reviewer scripts still wait: $(cat "$tmp/reviewer-waits")"

echo ok
