#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
playbook_dir=$(CDPATH='' cd "$script_dir/../../playbook/scripts" && pwd -P)
stub_bin=$(CDPATH='' cd "$script_dir/../../../scripts/stubs" && pwd -P)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/coderabbit.XXXXXX")
trap 'rm -rf "$tmp"' 0

export GH_STUB_DIR="$tmp/gh" GH_STUB_LOG="$tmp/gh.log"
export SKILLS_CONF="$tmp/skills.conf" CODERABBIT_NOW=2026-09-27T16:58:30Z CODERABBIT_POLL=0
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
  "timelineItems": {"nodes": []},
  "comments": {"nodes": []},
  "reviews": {"nodes": []},
  "reviewThreads": {"nodes": []},
  "commits": {"nodes": [{"commit": {
    "oid": head,
    "committedDate": stamp,
    "checkSuites": {"nodes": [{"createdAt": stamp}]},
    "statusCheckRollup": {"contexts": {"nodes": [{
      "__typename": "StatusContext", "context": "CodeRabbit", "state": "SUCCESS", "description": "Review complete"
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

if case == "approved":
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
  pr["reviews"]["nodes"] = [review(old, "", "APPROVED")]
elif case == "empty":
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
    pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"]["contexts"]["nodes"][0].update(state="PENDING")
  if case == "expected":
    pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"]["contexts"]["nodes"][0].update(state="EXPECTED")
  if case in ("old-notice", "open-notice", "notice-pending", "old-wait"):
    body = "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n"
    body += "Please wait **1 minutes and 30 seconds**" if case == "old-wait" else "**Next included review available in 15 minutes.**"
    updated = {"old-notice": "2026-09-27T16:30:00Z", "open-notice": "2026-09-27T16:49:00Z"}.get(case, "2026-09-27T16:58:01Z")
    pr["comments"]["nodes"].append({"author": bot, "body": body, "createdAt": stamp, "updatedAt": updated})
  if case == "absent":
    pr["comments"]["nodes"] = []
elif case in ("trigger-limited", "status-limited", "ready"):
  pr["commits"]["nodes"][-1]["commit"]["statusCheckRollup"]["contexts"]["nodes"][0].update(description="Review rate limited" if case != "ready" else "Review paused")
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
else:
  if case not in ("major", "approved", "trivial", "old-major", "budget", "minor", "empty", "real-line", "no-severity", "outside-major", "outside-minor", "dismissed", "full-threads", "full-reviews", "old-approved", "outside-mismatch"):
    raise ValueError(case)

print(json.dumps({"data": {"repository": {"pullRequest": pr}}}))
'

case_run() {
  name=$1
  expected=$2
  shift 2
  fixture "$(python3 -c "$fixture_program" "$name")"
  facts=$(sh "$script_dir/state.sh" 18) || fail "$name state failed"
  actual=$(sh "$script_dir/decide.sh" "$facts" "$@") || fail "$name decide failed"
  [ "$actual" = "$expected" ] || fail "$name: $actual, facts: $facts"
}

mode=$(sh "$playbook_dir/delivery-mode.sh")
[ "$mode" = "prs
coderabbit" ] || fail "delivery mode: $mode"

case_run major 'triage findings'
case_run approved 'done approved'
case_run trivial 'done clean'
case_run old-major 'triage findings'
case_run budget 'handback round-cap'
case_run minor 'triage findings' critical=true
case_run paused 'rereview paused'
case_run triggered 'handback no-review'
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
case_run ready 'wait grace'
case_run status-limited 'handback rate-limited'
case_run pending 'wait check-pending'
CODERABBIT_NOW=2026-09-27T16:53:00Z
export CODERABBIT_NOW
case_run expected 'wait absent'
case_run absent 'wait absent'
CODERABBIT_NOW=2026-09-27T16:58:30Z
export CODERABBIT_NOW
case_run old-notice 'rereview paused'
case_run open-notice 'handback rate-limited 6'
case_run notice-pending 'wait check-pending'
case_run old-wait 'handback rate-limited 2'
: > "$GH_STUB_LOG"
case_run major 'triage findings'
[ "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')" -eq 1 ] || fail 'state used more than one GraphQL read'
: > "$GH_STUB_LOG"
facts=$(sh "$script_dir/state.sh" 18 --wait) || fail 'terminal wait failed'
[ "$(sh "$script_dir/decide.sh" "$facts")" = 'triage findings' ] || fail 'terminal wait changed verdict'
[ "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')" -eq 1 ] || fail 'terminal wait polled again'

CODERABBIT_NOW=2026-09-27T17:11:01Z
export CODERABBIT_NOW
fixture "$(cat "$script_dir/fixtures/rate-limited.json")"
facts=$(sh "$script_dir/state.sh" 18) || fail 'rate limited state failed'
[ "$(sh "$script_dir/decide.sh" "$facts")" = 'handback rate-limited 2' ] || fail "rate limited remaining window: $facts"
CODERABBIT_NOW=2026-09-27T16:58:30Z
export CODERABBIT_NOW
facts=$(sh "$script_dir/state.sh" 18) || fail 'rate limited state failed'
[ "$(sh "$script_dir/decide.sh" "$facts")" = 'handback rate-limited 15' ] || fail "rate limited limit: $facts"
CODERABBIT_NOW=2026-09-27T17:13:02Z
export CODERABBIT_NOW
facts=$(sh "$script_dir/state.sh" 18) || fail 'expired notice state failed'
[ "$(sh "$script_dir/decide.sh" "$facts")" = 'rereview paused' ] || fail "expired notice: $facts"

CODERABBIT_NOW=2026-09-27T17:20:00Z
export CODERABBIT_NOW
case_run pending 'handback timeout'
case_run status-limited 'rereview paused'
case_run trigger-limited 'rereview paused'
case_run absent 'absent'
case_run expected 'absent'
case_run paused 'rereview paused'
printf 'CODERABBIT_REREVIEWS=0\n' >> "$SKILLS_CONF"
case_run paused-budget 'handback paused'
case_run major 'handback round-cap'

expect_refusal 2 sh "$script_dir/decide.sh" 'approved=yes reviewed=yes check=done limited=no retry=none waited=1 reviews=1 worst=major triggered=no unknown=yes'
expect_refusal 2 sh "$script_dir/decide.sh" 'approved=yes reviewed=yes check=done limited=no retry=none waited=1 reviews=1 worst=major triggered=no triggered=no'
expect_refusal 2 sh "$script_dir/decide.sh" 'approved=yes reviewed=yes check=done limited=no retry=none waited=x reviews=1 worst=major triggered=no'
expect_refusal 2 sh "$script_dir/state.sh" x
expect_refusal 2 sh "$script_dir/state.sh" 18 --unknown

echo ok
