#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
playbook_dir=$(CDPATH='' cd "$script_dir/../../playbook/scripts" && pwd -P)
stub_bin=$(CDPATH='' cd "$script_dir/../../../scripts/stubs" && pwd -P)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/coderabbit.XXXXXX")
trap 'rm -rf "$tmp"' 0

export GH_STUB_DIR="$tmp/gh" GH_STUB_LOG="$tmp/gh.log"
export SKILLS_CONF="$tmp/skills.conf" REVIEW_NOW=2026-09-27T16:58:30Z
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
PATH="$stub_bin:$PATH"
export PATH
mkdir -p "$GH_STUB_DIR"
printf 'DELIVERY=prs\nWITH=coderabbit\n' > "$SKILLS_CONF"
: > "$GH_STUB_LOG"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

fixture() {
  key=$(printf '%s' "api graphql -F owner={owner} -F repo={repo} -F number=18 -F query=@$script_dir/state.graphql" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s' "$1" > "$GH_STUB_DIR/$key"
  key=$(printf '%s' "api graphql -F owner={owner} -F repo={repo} -F number=18 -F query=@$playbook_dir/check-state.graphql" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s' "$1" | python3 -c '
import json
import sys

data = json.load(sys.stdin)
pr = data["data"]["repository"]["pullRequest"]
pr.setdefault("userContentEdits", {"nodes": []})
for node in pr["commits"]["nodes"]:
  commit = node["commit"]
  for context in (commit["statusCheckRollup"] or {"contexts": {"nodes": []}})["contexts"]["nodes"]:
    context.setdefault("createdAt", commit["committedDate"])

print(json.dumps(data))
' > "$GH_STUB_DIR/$key"
}

read_check() {
  sh "$playbook_dir/check-state.sh" 18 CodeRabbit '@coderabbitai review' 'coderabbitai coderabbitai[bot]'
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
bot = {"login": "coderabbitai"}
head = "a" * 40
old = "b" * 40
stamp = "2026-09-27T16:50:00Z"
major = "_🟠 Major_ Find a missing branch."
minor = "_🟡 Minor_ Check the name."
trivial = "_🔵 Trivial_ Tidy this."
real_line = "_🧭 Sample Category_ | _🟡 Minor_ | _⚡ Quick win_"
pr = {
  "createdAt": stamp,
  "userContentEdits": {"nodes": []},
  "timelineItems": {"nodes": []},
  "comments": {"nodes": []},
  "reviews": {"nodes": []},
  "reviewThreads": {"nodes": []},
  "commits": {"nodes": [{"commit": {
    "oid": head,
    "committedDate": stamp,
    "checkSuites": {"nodes": [{"createdAt": stamp}]},
    "statusCheckRollup": {"contexts": {"nodes": [{
      "__typename": "StatusContext", "context": "CodeRabbit", "state": "SUCCESS", "description": "Review completed", "createdAt": stamp
    }]}}
  }}]}
}

def review(oid=head, body="Reviewed this commit.", state="COMMENTED"):
  return {"author": bot, "state": state, "body": body, "commit": {"oid": oid}}

def thread(body=major, resolved=False, oid=head):
  return {"isResolved": resolved, "comments": {"nodes": [{"author": bot, "body": body, "originalCommit": {"oid": oid}}]}}

if case in ("major", "approved", "trivial", "old-major", "budget", "minor", "empty", "real-line", "no-severity", "outside-major", "outside-minor", "dismissed", "full-threads", "full-reviews", "old-approved", "outside-mismatch"):
  pr["reviews"]["nodes"].append(review())

if case in ("major", "budget", "minor", "real-line", "no-severity", "dismissed"):
  body = {"minor": minor, "real-line": real_line, "no-severity": "Unlabeled issue."}.get(case, major)
  pr["reviewThreads"]["nodes"].append(thread(body))

if case == "approved-then-review":
  pr["reviewThreads"]["nodes"].append(thread())
  pr["reviews"]["nodes"] = [review(state="APPROVED", body=""), review(body="Found a new issue.")]
elif case == "approved":
  pr["reviewThreads"]["nodes"].append(thread(resolved=True))
  pr["reviews"]["nodes"].append(review(state="APPROVED", body=""))
elif case == "trivial":
  pr["reviewThreads"]["nodes"].append(thread(trivial))
elif case == "old-major":
  pr["reviewThreads"]["nodes"].append(thread(oid=old))
  pr["commits"]["nodes"].insert(0, {"commit": {
    "oid": old, "committedDate": stamp, "checkSuites": {"nodes": []}, "statusCheckRollup": None
  }})
elif case == "budget":
  for letter in "bcd":
    pr["reviews"]["nodes"].append(review(letter * 40))
elif case == "old-approved":
  pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"] = None
  pr["reviews"]["nodes"] = [review(old, "", "APPROVED")]
elif case == "empty":
  pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"] = None
  pr["reviews"]["nodes"] = [review(body="")]
elif case in ("outside-major", "outside-minor"):
  word = "Major" if case == "outside-major" else "Minor"
  icon = "🟠" if case == "outside-major" else "🟡"
  body = f"""> [!CAUTION]
> Some comments are outside the diff.
> **⚠️ Outside diff range comments (1)**
> <details>
> <summary><em>{icon} {word}</em> · <code>sample.py:8</code></summary><blockquote>
> An invented finding.
> <details>
> <summary>Supported by static analysis</summary>
> </details>
> <!-- cr-comment:v1:synthetic -->
> </blockquote></details>"""
  pr["reviews"]["nodes"] = [review(body=body)]
elif case == "full-threads":
  pr["reviewThreads"]["nodes"] = [thread(trivial, True) for _ in range(100)]
elif case == "full-reviews":
  pr["reviewThreads"]["nodes"] = [thread()]
  pr["reviews"]["nodes"] += [review(body="") for _ in range(99)]
elif case in ("paused", "paused-budget", "triggered", "pending", "expected", "absent", "old-notice", "open-notice", "notice-pending", "old-wait"):
  pr["reviews"]["nodes"] = []
  if case in ("paused", "paused-budget", "triggered", "absent", "old-notice", "open-notice"):
    pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"] = None
  if case == "triggered":
    pr["comments"]["nodes"].append({"author": bot, "body": "Walkthrough.", "createdAt": stamp, "updatedAt": stamp})
    pr["comments"]["nodes"].append({"author": {"login": "developer"}, "body": " @coderabbitai review ", "createdAt": "2026-09-27T16:51:00Z", "updatedAt": "2026-09-27T16:51:00Z"})
  if case in ("paused", "paused-budget"):
    pr["comments"]["nodes"].append({"author": bot, "body": "Review paused.", "createdAt": stamp, "updatedAt": stamp})
  if case == "paused-budget":
    pr["reviews"]["nodes"].append(review(old))
  if case == "pending" or case == "notice-pending":
    pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"]["contexts"]["nodes"][0].update(state="PENDING", description="Review in progress")
  if case == "expected":
    pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"]["contexts"]["nodes"][0].update(state="EXPECTED")
  if case == "old-wait":
    pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"]["contexts"]["nodes"][0]["description"] = "Review rate limited"
  if case in ("old-notice", "open-notice", "notice-pending", "old-wait"):
    body = "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n"
    body += "Please wait **1 minutes and 30 seconds**" if case == "old-wait" else "**Next included review available in 15 minutes.**"
    updated = {"old-notice": "2026-09-27T16:30:00Z", "open-notice": "2026-09-27T16:49:00Z"}.get(case, "2026-09-27T16:58:01Z")
    pr["comments"]["nodes"].append({"author": bot, "body": body, "createdAt": stamp, "updatedAt": updated})
  if case == "absent":
    pr["comments"]["nodes"] = []
elif case in ("trigger-limited", "status-limited", "limited-old-major", "limited-answered-major", "ready"):
  pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"]["contexts"]["nodes"][0].update(description="Review rate limited" if case != "ready" else "Review skipped: automatic reviews are disabled")
  if case in ("limited-old-major", "limited-answered-major"):
    pr["commits"]["nodes"].insert(0, {"commit": {
      "oid": old, "committedDate": stamp, "checkSuites": {"nodes": []}, "statusCheckRollup": None
    }})
    pr["reviewThreads"]["nodes"].append(thread(oid=old))
  if case == "limited-answered-major":
    pr["reviewThreads"]["nodes"][-1]["latest"] = {"nodes": [{"author": {"login": "developer"}}]}
  if case == "trigger-limited":
    pr["comments"]["nodes"].append({"author": {"login": "developer"}, "body": "@coderabbitai review", "createdAt": "2026-09-27T16:51:00Z", "updatedAt": "2026-09-27T16:51:00Z"})
    pr["comments"]["nodes"].append({"author": bot, "body": "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n**Next included review available in 5 minutes.**", "createdAt": stamp, "updatedAt": "2026-09-27T16:51:10Z"})
  if case == "ready":
    pr["timelineItems"]["nodes"].append({"createdAt": "2026-09-27T16:56:00Z"})
elif case == "outside-mismatch":
  body = """> **⚠️ Outside diff range comments (2)**
> <details>
> <summary><em>🔵 Trivial</em> · <code>sample.py:3</code></summary><blockquote>
> An invented finding.
> <!-- cr-comment:v1:synthetic -->
> </blockquote></details>"""
  pr["reviews"]["nodes"] = [review(body=body)]
elif case in ("completed-head", "completed-old-major", "approved-status", "skipped-disabled", "skipped-disabled-budget", "skipped-ineligible", "completed-budget", "completed-and-review"):
  descriptions = {
    "approved-status": "Review approved",
    "skipped-disabled": "Review skipped: automatic reviews are disabled",
    "skipped-disabled-budget": "Review skipped: automatic reviews are disabled",
    "skipped-ineligible": "Review skipped: bot user not eligible for review",
  }

  description = descriptions.get(case, "Review completed")
  pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"]["contexts"]["nodes"][0]["description"] = description
  pr["comments"]["nodes"].append({"author": bot, "body": "Walkthrough.", "createdAt": stamp, "updatedAt": stamp})

  if case == "completed-old-major":
    pr["commits"]["nodes"].insert(0, {"commit": {
      "oid": old, "committedDate": stamp, "checkSuites": {"nodes": []}, "statusCheckRollup": None
    }})

    pr["reviewThreads"]["nodes"].append(thread(oid=old))
  elif case == "completed-budget":
    for letter in "bcd":
      pr["reviews"]["nodes"].append(review(letter * 40))

    pr["reviewThreads"]["nodes"].append(thread())
  elif case == "completed-and-review":
    pr["reviews"]["nodes"].append(review())

    for letter in "bc":
      pr["reviews"]["nodes"].append(review(letter * 40))

    pr["reviewThreads"]["nodes"].append(thread())
  elif case == "skipped-disabled-budget":
    pr["reviews"]["nodes"].append(review(old))
else:
  if case not in ("major", "approved", "trivial", "old-major", "budget", "minor", "empty", "real-line", "no-severity", "outside-major", "outside-minor", "dismissed", "full-threads", "full-reviews", "old-approved", "outside-mismatch", "approved-then-review"):
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
coderabbit" ] || fail "delivery mode: $mode"

case_run major 'triage findings'
case_run approved 'done approved'
case_run approved-then-review 'triage findings'
case_run trivial 'done clean'
case_run old-major 'triage findings'
case_run budget 'handback round-cap'
case_run minor 'triage findings' critical=true
case_run paused 'rereview paused'
case_run triggered 'unavailable no-review'
case_run dismissed 'handback all-dismissed' dismissed=yes
case_run full-threads 'triage findings'
case_run full-reviews 'handback round-cap'
case_run old-approved 'rereview paused'
case_run empty 'rereview paused'
case_run real-line 'done clean'
case_run no-severity 'triage findings'
case_run outside-major 'triage findings'
case_run outside-minor 'done clean'
case_run outside-mismatch 'triage findings'
case_run ready 'rereview paused'
case_run status-limited 'unavailable rate-limited'
case_run limited-old-major 'triage findings'
case_run limited-answered-major 'unavailable rate-limited'
case_run pending 'wait check-pending'
case_run completed-head 'done clean'
: > "$GH_STUB_LOG"
[ "$(sh "$script_dir/verdict.sh" gate 18)" = 'done clean' ] || fail 'completed head gate differs'
[ "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')" -eq 2 ] || fail 'completed head gate posted or polled'
[ "$(cat "$GH_STUB_LOG")" = "$(printf '%s\n%s' "api graphql -F owner={owner} -F repo={repo} -F number=18 -F query=@$playbook_dir/check-state.graphql" "api graphql -F owner={owner} -F repo={repo} -F number=18 -F query=@$script_dir/state.graphql")" ] || fail 'completed head gate did not read GraphQL'
case_run completed-old-major 'triage findings'
case_run approved-status 'done clean'
case_run skipped-disabled 'rereview paused'
case_run skipped-ineligible 'unavailable skipped'
case_run completed-budget 'handback round-cap'
case_run completed-and-review 'triage findings'
REVIEW_NOW=2026-09-27T16:50:30Z
export REVIEW_NOW
case_run expected 'wait check-appear'
case_run absent 'wait check-appear'
REVIEW_NOW=2026-09-27T16:58:30Z
export REVIEW_NOW
case_run old-notice 'rereview paused'
case_run open-notice 'unavailable rate-limited 6'
case_run notice-pending 'wait check-pending'
case_run old-wait 'unavailable rate-limited 2'
: > "$GH_STUB_LOG"
case_run major 'triage findings'
[ "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')" -eq 2 ] || fail 'state and check did not use one read each'
: > "$GH_STUB_LOG"
facts=$(sh "$script_dir/state.sh" 18) || fail 'terminal state failed'
[ "$(sh "$script_dir/decide.sh" "$(read_check)" "$facts")" = 'triage findings' ] || fail 'terminal state changed verdict'
[ "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')" -eq 2 ] || fail 'terminal state queried again'

REVIEW_NOW=2026-09-27T17:11:01Z
export REVIEW_NOW
fixture "$(cat "$script_dir/fixtures/rate-limited.json")"
facts=$(sh "$script_dir/state.sh" 18) || fail 'rate limited state failed'
[ "$(sh "$script_dir/decide.sh" "$(read_check)" "$facts")" = 'unavailable rate-limited 2' ] || fail "rate limited remaining window: $facts"
REVIEW_NOW=2026-09-27T16:58:30Z
export REVIEW_NOW
facts=$(sh "$script_dir/state.sh" 18) || fail 'rate limited state failed'
[ "$(sh "$script_dir/decide.sh" "$(read_check)" "$facts")" = 'unavailable rate-limited 15' ] || fail "rate limited limit: $facts"
REVIEW_NOW=2026-09-27T17:13:02Z
export REVIEW_NOW
facts=$(sh "$script_dir/state.sh" 18) || fail 'expired notice state failed'
[ "$(sh "$script_dir/decide.sh" "$(read_check)" "$facts")" = 'rereview paused' ] || fail "expired notice: $facts"

REVIEW_NOW=2026-09-27T17:20:00Z
export REVIEW_NOW
case_run pending 'unavailable timeout'
case_run status-limited 'rereview paused'
case_run trigger-limited 'unavailable no-review'
case_run absent 'absent'
case_run expected 'absent'
case_run paused 'rereview paused'
printf 'CODERABBIT_REREVIEWS=0\n' >> "$SKILLS_CONF"
case_run skipped-disabled-budget 'unavailable paused'
case_run skipped-ineligible 'unavailable skipped'
case_run paused-budget 'unavailable paused'
case_run major 'handback round-cap'

check_state='check=completed seen=yes event=push elapsed=90 age=90 gate=decide'
facts='approved=yes reviewed=yes limited=no retry=none reviews=1 worst=major unanswered=major triggered=no'
expect_refusal 2 sh "$script_dir/decide.sh" "$check_state" "$facts" unknown=yes
expect_refusal 2 sh "$script_dir/decide.sh" "$check_state" "$facts" triggered=no
expect_refusal 2 sh "$script_dir/decide.sh" "${check_state%gate=decide}gate=unknown" "$facts"
expect_refusal 2 sh "$script_dir/decide.sh" "$facts"
expect_refusal 2 sh "$script_dir/state.sh" 18 --unknown
expect_refusal 2 sh "$script_dir/state.sh" x
expect_refusal 2 sh "$script_dir/state.sh" 18 --unknown

printf 'DELIVERY=prs\nWITH=coderabbit\n' > "$SKILLS_CONF"
fixture "$(python3 -c "$fixture_program" major)"
[ "$(sh "$script_dir/verdict.sh" gate 18)" = 'triage findings' ] || fail 'gate verdict differs'
[ "$(sh "$script_dir/verdict.sh" gate 18 critical=true)" = 'triage findings' ] || fail 'critical gate verdict differs'
[ "$(sh "$script_dir/verdict.sh" decide 18 feat/topic)" = 'triage findings' ] || fail 'decide without outcome differs'
[ "$(sh "$script_dir/verdict.sh" decide 18 feat/topic outcome=fixed)" = 'triage findings' ] || fail 'fixed outcome differs'
[ "$(sh "$script_dir/verdict.sh" decide 18 feat/topic outcome=dismissed)" = 'handback all-dismissed' ] || fail 'dismissed outcome differs'
fixture "$(python3 -c "$fixture_program" minor)"
[ "$(sh "$script_dir/verdict.sh" gate 18)" = 'done clean' ] || fail 'noncritical gate differs'
[ "$(sh "$script_dir/verdict.sh" gate 18 critical=true)" = 'triage findings' ] || fail 'critical gate differs'
expect_refusal 2 sh "$script_dir/verdict.sh" gate x
expect_refusal 2 sh "$script_dir/verdict.sh" gate 18 outcome=fixed
expect_refusal 2 sh "$script_dir/verdict.sh" decide 18 feat/topic outcome=other

export REVIEW_NOW=2026-09-28T12:00:00Z
printf 'DELIVERY=prs\nWITH=coderabbit\n' > "$SKILLS_CONF"
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
elif case in ("seen-push", "older-pending"):
  pr["commits"]["nodes"].insert(0, commit("b", 1800, [context(1700, case == "older-pending")]))
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
  response=$(python3 -c "$acceptance_program" "$name" coderabbit)
  fixture "$response"
  actual=$(sh "$script_dir/verdict.sh" gate 18) || fail "$name gate failed"
  [ "$actual" = "$expected" ] || fail "$name gate: expected $expected, got $actual"
}

acceptance_case pending 'wait check-pending'
acceptance_case appear 'wait check-appear'
response=$(python3 -c "$acceptance_program" appear coderabbit)
fixture "$response"
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
acceptance_case seen-push 'rereview paused'
acceptance_case expected absent
acceptance_case full-reviews 'unavailable paused'
for name in body-seen thread-seen full-edits full-comments full-threads full-commits full-contexts; do
  acceptance_case "$name" 'rereview paused'
done

for gate in timeout no-review; do
  check_state="check=missing seen=yes event=trigger elapsed=1500 age=none gate=$gate"
  facts='approved=no reviewed=no limited=no retry=none reviews=0 worst=major unanswered=major triggered=yes'
  [ "$(sh "$script_dir/decide.sh" "$check_state" "$facts")" = 'triage findings' ] || fail "$gate hid findings"
  facts='approved=no reviewed=no limited=yes retry=2 reviews=0 worst=none unanswered=none triggered=yes'
  [ "$(sh "$script_dir/decide.sh" "$check_state" "$facts")" = 'unavailable rate-limited 2' ] || fail "$gate lost rate limit"
done

echo ok
