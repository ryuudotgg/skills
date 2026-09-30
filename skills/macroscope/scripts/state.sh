#!/bin/sh
set -eu

usage() {
  echo 'usage: state.sh <pr>' >&2
  exit 2
}

refuse() {
  printf 'state: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 1 ] || usage
case $1 in
  *[!0-9]*|'') usage ;;
esac

number=$1
script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
reviewers=$script_dir/../../playbook/scripts/reviewers.sh
tab=$(printf '\t')

read_key() {
  rows=$(sh "$reviewers" "$1") || refuse "cannot read reviewer $2"
  printf '%s\n' "$rows" | awk -F "$tab" '$1 == "macroscope" { print $2 }'
}

logins=$(read_key LOGINS logins)
check=$(read_key CHECK checks)
trigger=$(read_key TRIGGER trigger)
[ -n "$logins" ] && [ -n "$check" ] && [ -n "$trigger" ] || refuse 'macroscope is not a declared reviewer'

program='
import datetime as dt
import json
import os
import re
import sys

logins = {value.lower() for value in os.environ["MACROSCOPE_LOGINS"].split()}
check_name = os.environ["MACROSCOPE_CHECK"].lower()
approval_name = "macroscope - approvability check"
cap = int(dict(line.split("=", 1) for line in os.environ["CHECK_LIMITS"].splitlines())["cap"])
trigger = os.environ["MACROSCOPE_TRIGGER"]
severity = re.compile(r"[^\w*]*\*\*(critical|high|medium|low)\*\*", re.I)
rank = {"low": 0, "medium": 1, "high": 2, "critical": 3}

def timestamp(value):
  return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))

def bot(entry):
  return ((entry.get("author") or {}).get("login") or "").lower() in logins

def level(text):
  first = next((line for line in text.splitlines() if line.strip()), "")
  match = severity.match(first)
  return match.group(1).lower() if match else "critical"

pr = json.load(sys.stdin)["data"]["repository"]["pullRequest"]
commits = pr["commits"]["nodes"]
head = commits[-1]["commit"]
suites = head.get("checkSuites") or {"nodes": []}
push = min((timestamp(item["createdAt"]) for item in suites["nodes"]), default=timestamp(head["committedDate"]))
threads = pr["reviewThreads"]["nodes"]
now = timestamp(os.environ["REVIEW_NOW"]) if os.environ.get("REVIEW_NOW") else dt.datetime.now(dt.timezone.utc)
comments = pr["comments"]["nodes"]
triggered = any((item.get("body") or "").strip() == trigger and timestamp(item["createdAt"]) > push for item in comments)
if len(comments) >= 100 and min(timestamp(item["createdAt"]) for item in comments) > push:
  triggered = True

def contexts(commit):
  return ((commit.get("statusCheckRollup") or {}).get("contexts") or {}).get("nodes", [])

def started(run):
  value = run.get("startedAt") or (run.get("checkSuite") or {}).get("createdAt")
  return timestamp(value) if value else dt.datetime.min.replace(tzinfo=dt.timezone.utc)

def newest(commit, name):
  found = [(started(item), index, item) for index, item in enumerate(contexts(commit)) if item["__typename"] == "CheckRun" and name in (item.get("name") or "").lower()]
  return max(found, key=lambda entry: entry[:2])[2] if found else None

def approval():
  latest = newest(head, approval_name)
  if latest is None:
    return "not-approved" if len(contexts(head)) >= 100 else "none"

  if latest.get("status") != "COMPLETED":
    started = latest.get("startedAt") or (latest.get("checkSuite") or {}).get("createdAt")
    return "pending" if started is None or (now - timestamp(started)).total_seconds() < cap else "none"

  return {"SUCCESS": "approved", "SKIPPED": "none", "CANCELLED": "none"}.get(latest.get("conclusion"), "not-approved")

review_commits = set()
for commit in commits:
  latest = newest(commit["commit"], check_name)
  if latest and latest.get("status") == "COMPLETED" and latest.get("conclusion") in ("SUCCESS", "NEUTRAL"):
    review_commits.add(commit["commit"]["oid"])

levels = []
unanswered = []
for thread in threads:
  starter = thread["comments"]["nodes"]
  if not starter or not bot(starter[0]) or thread["isResolved"]:
    continue

  found = level(starter[0].get("body") or "")
  levels.append(found)
  latest = (thread.get("latest") or {"nodes": starter})["nodes"]
  if latest and bot(latest[-1]):
    unanswered.append(found)

if len(threads) >= 100:
  levels.append("critical")
  unanswered.append("critical")

worst = max(levels, key=lambda value: rank[value]) if levels else "none"
open_worst = max(unanswered, key=lambda value: rank[value]) if unanswered else "none"
reviews = max(len(review_commits), 100) if len(commits) >= 100 else len(review_commits)
reviewed = "yes" if head["oid"] in review_commits else "no"
triggered_text = "yes" if triggered else "no"
print(f"reviewed={reviewed} reviews={reviews} worst={worst} unanswered={open_worst} triggered={triggered_text} approval={approval()}")
'

limits=$(sh "$script_dir/../../playbook/scripts/check-state.sh" --limits) || refuse 'cannot read check limits'
response=$(gh api graphql -F 'owner={owner}' -F 'repo={repo}' -F "number=$number" -F "query=@$script_dir/state.graphql") || refuse 'gh failed reading PR review'
result=$(printf '%s' "$response" | CHECK_LIMITS="$limits" MACROSCOPE_LOGINS="$logins" MACROSCOPE_CHECK="$check" MACROSCOPE_TRIGGER="$trigger" python3 -c "$program") || refuse 'cannot parse PR review'
printf '%s\n' "$result"
