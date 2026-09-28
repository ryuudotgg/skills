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
  printf '%s\n' "$rows" | awk -F "$tab" '$1 == "coderabbit" { print $2 }'
}

logins=$(read_key LOGINS logins)
check=$(read_key CHECK checks)
trigger=$(read_key TRIGGER trigger)
outside=$(read_key OUTSIDE_DIFF heading)
[ -n "$logins" ] && [ -n "$check" ] && [ -n "$trigger" ] && [ -n "$outside" ] || refuse 'coderabbit is not a declared reviewer'

program='
import datetime as dt
import json
import math
import os
import re
import sys

logins = {value.lower() for value in os.environ["CODERABBIT_LOGINS"].split()}
check_name = os.environ["CODERABBIT_CHECK"].lower()
trigger = os.environ["CODERABBIT_TRIGGER"]
outside = os.environ["CODERABBIT_OUTSIDE"]
severity = re.compile(r"(🔴|🟠|🟡|🔵|⚪)\s*(Critical|Major|Minor|Trivial)", re.I)
rank = {"trivial": 0, "minor": 1, "major": 2, "critical": 3}
status_outcomes = (
  ("review completed", "completed"),
  ("review approved", "completed"),
  ("review skipped: automatic reviews are disabled", "disabled"),
  ("review skipped: bot user not eligible for review", "ineligible"),
)

def timestamp(value):
  return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))

def bot(entry):
  return ((entry.get("author") or {}).get("login") or "").lower() in logins

def level(text):
  match = severity.search(text)
  return match.group(2).lower() if match else "critical"

def outside_levels(body):
  lines = body.splitlines()
  levels = []
  for index, line in enumerate(lines):
    if outside not in line:
      continue

    block = [line]
    for next_line in lines[index + 1:]:
      if not next_line.lstrip().startswith(">"):
        break
      block.append(next_line)

    heading = re.search(r"\(([0-9]+)\)", line)
    text = "\n".join(block)
    chunks = re.split(r"<!--\s*cr-comment:", text)
    for chunk in chunks[:-1]:
      levels.append(level(chunk))

    if heading is None or len(chunks) - 1 != int(heading.group(1)):
      levels.append("critical")

  return levels

def notice_seconds(body):
  match = re.search(r"Next included review available in\s*([^\n]+)|Please wait\s*\*\*(.*?)\*\*", body, re.I | re.S)
  if not match:
    return None

  phrase = next(value for value in match.groups() if value is not None)
  units = {"second": 1, "minute": 60, "hour": 3600}
  pairs = re.findall(r"([0-9]+)\s*(seconds?|minutes?|hours?)", phrase, re.I)
  return sum(int(number) * units[unit.lower().rstrip("s")] for number, unit in pairs) if pairs else None

pr = json.load(sys.stdin)["data"]["repository"]["pullRequest"]
commits = pr["commits"]["nodes"]
head = commits[-1]["commit"]
head_oid = head["oid"]
suites = head.get("checkSuites") or {"nodes": []}
push = min((timestamp(item["createdAt"]) for item in suites["nodes"]), default=timestamp(head["committedDate"]))
comments = pr["comments"]["nodes"]
reviews = pr["reviews"]["nodes"]
threads = pr["reviewThreads"]["nodes"]
triggers = [timestamp(item["createdAt"]) for item in comments if (item.get("body") or "").strip() == trigger]
now = timestamp(os.environ["REVIEW_NOW"]) if os.environ.get("REVIEW_NOW") else dt.datetime.now(dt.timezone.utc)

head_outcome = None
check_limited = False
review_commits = set()
for commit in commits:
  rollup = commit["commit"].get("statusCheckRollup") or {}
  contexts = (rollup.get("contexts") or {}).get("nodes", [])
  last_check = None
  for item in contexts:
    name = item.get("context") if item["__typename"] == "StatusContext" else item.get("name")
    if not name or check_name not in name.lower():
      continue

    last_check = item

  if last_check:
    description = last_check.get("description") if last_check["__typename"] == "StatusContext" else last_check.get("title")
    description = (description or "").strip().lower()
    outcome = next((value for prefix, value in status_outcomes if description.startswith(prefix)), None)
    if outcome == "completed":
      review_commits.add(commit["commit"]["oid"])

    if commit["commit"]["oid"] == head_oid:
      head_outcome = outcome
      check_limited = "rate limited" in description

head_reviewed = head_outcome == "completed"
approved = False
levels = []
unanswered = []
for item in reviews:
  if not bot(item):
    continue

  oid = (item.get("commit") or {}).get("oid")
  counts = item.get("state") == "APPROVED" or bool((item.get("body") or "").strip())
  if counts and oid:
    review_commits.add(oid)

  if oid == head_oid and counts:
    head_reviewed = True
    levels.extend(outside_levels(item.get("body") or ""))
    approved = item.get("state") == "APPROVED"

for thread in threads:
  starter = thread["comments"]["nodes"]
  if not starter or not bot(starter[0]):
    continue

  if not thread["isResolved"]:
    first = next((line for line in (starter[0].get("body") or "").splitlines() if line.strip()), "")
    levels.append(level(first))
    latest = (thread.get("latest") or {"nodes": starter})["nodes"]
    if latest and bot(latest[-1]):
      unanswered.append(level(first))

notices = [item for item in comments if bot(item) and "rate limited by coderabbit.ai" in (item.get("body") or "").lower()]
notice = max(notices, key=lambda item: timestamp(item["updatedAt"])) if notices else None
seconds = notice_seconds(notice["body"]) if notice else None
remaining = (timestamp(notice["updatedAt"]) + dt.timedelta(seconds=seconds) - now).total_seconds() if seconds is not None else None
triggered = any(value > push and (notice is None or value > timestamp(notice["updatedAt"])) for value in triggers)
fresh = notice is not None and (remaining is not None or timestamp(notice["updatedAt"]) > push)
limited = (check_limited or fresh) and (remaining is None or remaining > 0)
retry = str(math.ceil(remaining / 60)) if limited and remaining is not None else "none"

if len(threads) >= 100:
  levels.append("critical")
  unanswered.append("critical")

reviews_count = len(reviews) if len(reviews) >= 100 else len(review_commits)

worst = max(levels, key=lambda value: rank[value]) if levels else "none"
open_worst = max(unanswered, key=lambda value: rank[value]) if unanswered else "none"
skipped = f" skipped={head_outcome}" if head_outcome in ("disabled", "ineligible") else ""
approved_text = "yes" if approved else "no"
reviewed_text = "yes" if head_reviewed else "no"
limited_text = "yes" if limited else "no"
triggered_text = "yes" if triggered else "no"
print(f"approved={approved_text} reviewed={reviewed_text} limited={limited_text} retry={retry} reviews={reviews_count} worst={worst} unanswered={open_worst} triggered={triggered_text}{skipped}")
'

response=$(gh api graphql -F 'owner={owner}' -F 'repo={repo}' -F "number=$number" -F "query=@$script_dir/state.graphql") || refuse 'gh failed reading PR review'
result=$(printf '%s' "$response" | CODERABBIT_LOGINS="$logins" CODERABBIT_CHECK="$check" CODERABBIT_TRIGGER="$trigger" CODERABBIT_OUTSIDE="$outside" python3 -c "$program") || refuse 'cannot parse PR review'
printf '%s\n' "$result"
