#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
playbook_dir=$(CDPATH='' cd "$script_dir/../../playbook/scripts" && pwd -P)
stub_bin=$(CDPATH='' cd "$script_dir/../../../scripts/stubs" && pwd -P)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/macroscope.XXXXXX")
trap 'rm -rf "$tmp"' 0

export GH_STUB_DIR="$tmp/gh" GH_STUB_LOG="$tmp/gh.log"
export SKILLS_CONF="$tmp/skills.conf" REVIEW_NOW=2026-09-30T14:30:00Z
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
PATH="$stub_bin:$PATH"
export PATH
mkdir -p "$GH_STUB_DIR"
printf 'DELIVERY=prs\nWITH=macroscope\n' > "$SKILLS_CONF"
: > "$GH_STUB_LOG"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

stub() {
  key=$(printf '%s' "api graphql -F owner={owner} -F repo={repo} -F number=18 -F query=@$1" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s' "$2" > "$GH_STUB_DIR/$key"
}

fixture() {
  stub "$script_dir/state.graphql" "$1"
  stub "$playbook_dir/check-state.graphql" "$1"
}

read_check() {
  sh "$playbook_dir/check-state.sh" 18 'Macroscope - Correctness Check' '@macroscope-app review' 'macroscopeapp macroscopeapp[bot]'
}

expect_refusal() {
  status=$1
  shift
  actual=0
  "$@" > "$tmp/out" 2> "$tmp/err" || actual=$?
  [ "$actual" -eq "$status" ] || fail "expected exit $status, got $actual"
  [ ! -s "$tmp/out" ] || fail 'refusal wrote stdout'
}

fixture_program='
import json
import sys

case = sys.argv[1]
bot = {"login": "macroscopeapp"}
human = {"login": "developer"}
head = "a" * 40
old = "b" * 40
stamp = "2026-09-30T14:20:00Z"
later = "2026-09-30T14:21:00Z"
medium = "🟡 **Medium** `sample.py:14`\n\nA missing branch."
low = "🔵 **Low** `sample.py:3`\n\nTidy this."

def run(status="COMPLETED", conclusion="SUCCESS", name="Macroscope - Correctness Check", started=stamp):
  return {"__typename": "CheckRun", "name": name, "status": status, "conclusion": conclusion if status == "COMPLETED" else None, "startedAt": started, "completedAt": stamp if status == "COMPLETED" else None, "checkSuite": {"createdAt": stamp}}

def commit(oid, checks):
  return {"commit": {"oid": oid, "committedDate": stamp, "checkSuites": {"nodes": [{"createdAt": stamp}]}, "statusCheckRollup": {"contexts": {"nodes": checks}}}}

def thread(body=medium, resolved=False, last=bot):
  return {"isResolved": resolved, "comments": {"nodes": [{"author": bot, "body": body}]}, "latest": {"nodes": [{"author": last}]}}

approvability = run(name="Macroscope - Approvability Check")
pr = {
  "createdAt": stamp,
  "timelineItems": {"nodes": []},
  "userContentEdits": {"nodes": []},
  "comments": {"nodes": []},
  "reviews": {"nodes": [{"author": bot}]},
  "reviewThreads": {"nodes": []},
  "commits": {"nodes": [commit(head, [approvability, run()])]},
}
checks = pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"]["contexts"]["nodes"]

if case == "medium":
  pr["reviewThreads"]["nodes"].append(thread())
elif case == "low":
  pr["reviewThreads"]["nodes"].append(thread(low))
elif case == "resolved":
  pr["reviewThreads"]["nodes"].append(thread(resolved=True))
elif case == "no-severity":
  pr["reviewThreads"]["nodes"].append(thread("Unlabeled issue."))
elif case == "human-thread":
  pr["reviewThreads"]["nodes"].append({"isResolved": False, "comments": {"nodes": [{"author": human, "body": "Why?"}]}, "latest": {"nodes": [{"author": human}]}})
elif case == "neutral":
  checks[-1]["conclusion"] = "NEUTRAL"
  pr["reviewThreads"]["nodes"].append(thread())
elif case == "old-medium":
  pr["commits"]["nodes"].insert(0, commit(old, [run(conclusion="NEUTRAL")]))
  pr["reviewThreads"]["nodes"].append(thread())
elif case == "budget":
  pr["commits"]["nodes"] = [commit(letter * 40, [run()]) for letter in "bc"] + pr["commits"]["nodes"]
  pr["reviewThreads"]["nodes"].append(thread())
elif case in ("unreviewed", "unreviewed-budget"):
  pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"] = None
  if case == "unreviewed-budget":
    pr["commits"]["nodes"] = [commit(letter * 40, [run()]) for letter in "bcd"] + pr["commits"]["nodes"]
elif case == "skipped":
  checks[-1]["conclusion"] = "SKIPPED"
elif case == "triggered":
  pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"] = None
  pr["comments"]["nodes"].append({"author": human, "body": " @macroscope-app review ", "createdAt": later})
elif case == "triggered-answered":
  pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"] = None
  pr["reviewThreads"]["nodes"].append(thread())
  pr["comments"]["nodes"].append({"author": human, "body": "@macroscope-app review", "createdAt": later})
elif case == "pending":
  checks[-1] = run(status="IN_PROGRESS")
elif case == "full-threads":
  pr["reviewThreads"]["nodes"] = [thread(low, True) for _ in range(100)]
elif case == "absent":
  pr["reviews"]["nodes"] = []
  pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"] = None
elif case in ("not-approved", "not-approved-low"):
  checks[0]["conclusion"] = "NEUTRAL"
  if case == "not-approved-low":
    pr["reviewThreads"]["nodes"].append(thread(low))
elif case == "approval-skipped":
  checks[0]["conclusion"] = "SKIPPED"
elif case == "no-approval":
  del checks[0]
elif case == "approval-pending":
  checks[0] = run(status="IN_PROGRESS", name="Macroscope - Approvability Check", started="2026-09-30T14:25:00Z")
elif case != "clean":
  raise ValueError(case)

print(json.dumps({"data": {"repository": {"pullRequest": pr}}}))
'

case_run() {
  name=$1
  expected=$2
  shift 2
  fixture "$(python3 -c "$fixture_program" "$name")"
  facts=$(sh "$script_dir/state.sh" 18) || fail "$name state failed"
  actual=$(sh "$script_dir/decide.sh" "$(read_check)" "$facts" "$@") || fail "$name decide failed"
  [ "$actual" = "$expected" ] || fail "$name: $actual, facts: $facts"
}

mode=$(sh "$playbook_dir/delivery-mode.sh")
[ "$mode" = "prs
macroscope" ] || fail "delivery mode: $mode"

case_run clean 'done approved'
case_run clean 'done approved' critical=true
case_run not-approved 'done clean not-approved'
case_run not-approved 'handback not-approved' critical=true
case_run not-approved-low 'done clean not-approved'
case_run not-approved-low 'triage findings' critical=true
case_run approval-skipped 'done clean'
case_run approval-skipped 'done clean' critical=true
case_run no-approval 'done clean'
case_run approval-pending 'wait approval-pending'
case_run medium 'triage findings'
case_run low 'done approved'
case_run low 'triage findings' critical=true
case_run resolved 'done approved'
case_run no-severity 'triage findings'
case_run human-thread 'done approved'
case_run neutral 'triage findings'
case_run old-medium 'triage findings'
case_run budget 'handback round-cap'
case_run medium 'handback all-dismissed' dismissed=yes
case_run unreviewed 'rereview paused'
case_run unreviewed-budget 'unavailable paused'
case_run skipped 'rereview paused'
case_run triggered 'unavailable no-review'
case_run triggered-answered 'triage findings'
case_run pending 'wait check-pending'
case_run full-threads 'triage findings'

fixture "$(python3 -c "$fixture_program" medium)"
[ "$(sh "$script_dir/state.sh" 18)" = 'reviewed=yes reviews=1 worst=medium unanswered=medium triggered=no approval=approved' ] || fail 'medium facts differ'

REVIEW_NOW=2026-09-30T14:20:30Z
export REVIEW_NOW
case_run absent 'wait check-appear'
REVIEW_NOW=2026-09-30T14:50:00Z
export REVIEW_NOW
case_run absent 'absent'
case_run pending 'unavailable timeout'
case_run approval-pending 'done clean'
REVIEW_NOW=2026-09-30T14:30:00Z
export REVIEW_NOW

printf 'MACROSCOPE_THRESHOLD=high\n' >> "$SKILLS_CONF"
case_run medium 'done approved'
case_run medium 'triage findings' critical=true
printf 'DELIVERY=prs\nWITH=macroscope\nMACROSCOPE_REREVIEWS=0\n' > "$SKILLS_CONF"
case_run unreviewed 'rereview paused'
case_run medium 'handback round-cap'
printf 'DELIVERY=prs\nWITH=macroscope\n' > "$SKILLS_CONF"

check_state='check=completed seen=yes event=push elapsed=90 age=90 gate=decide'
facts='reviewed=yes reviews=1 worst=medium unanswered=medium triggered=no approval=none'
expect_refusal 2 sh "$script_dir/decide.sh" "$check_state" "$facts" unknown=yes
expect_refusal 2 sh "$script_dir/decide.sh" "$check_state" "$facts" triggered=no
expect_refusal 2 sh "$script_dir/decide.sh" "$check_state" "${facts%worst=medium*}worst=major unanswered=none triggered=no approval=none"
expect_refusal 2 sh "$script_dir/decide.sh" "$check_state" "${facts%approval=none}approval=held"
expect_refusal 2 sh "$script_dir/decide.sh" "$check_state" "${facts% approval=none}"
expect_refusal 2 sh "$script_dir/decide.sh" "$facts"
expect_refusal 2 sh "$script_dir/state.sh" x
expect_refusal 2 sh "$script_dir/state.sh" 18 --unknown

fixture "$(python3 -c "$fixture_program" medium)"
: > "$GH_STUB_LOG"
[ "$(sh "$script_dir/verdict.sh" gate 18)" = 'triage findings' ] || fail 'gate verdict differs'
[ "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')" -eq 2 ] || fail 'gate did not use one read each'
[ "$(sh "$script_dir/verdict.sh" decide 18 feat/topic outcome=fixed)" = 'triage findings' ] || fail 'fixed outcome differs'
[ "$(sh "$script_dir/verdict.sh" decide 18 feat/topic outcome=dismissed)" = 'handback all-dismissed' ] || fail 'dismissed outcome differs'
fixture "$(python3 -c "$fixture_program" low)"
[ "$(sh "$script_dir/verdict.sh" gate 18)" = 'done approved' ] || fail 'noncritical gate differs'
[ "$(sh "$script_dir/verdict.sh" gate 18 critical=true)" = 'triage findings' ] || fail 'critical gate differs'
expect_refusal 2 sh "$script_dir/verdict.sh" gate x
expect_refusal 2 sh "$script_dir/verdict.sh" gate 18 outcome=fixed
expect_refusal 2 sh "$script_dir/verdict.sh" decide 18 feat/topic outcome=other

echo ok
