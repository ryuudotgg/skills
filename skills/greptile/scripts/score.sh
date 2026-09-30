#!/bin/sh
set -eu

usage() {
  echo 'usage: score.sh <pr>' >&2
  exit 2
}

refuse() {
  printf 'score: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 1 ] || usage
case $1 in
  *[!0-9]*|'') usage ;;
esac

number=$1
script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
reviewers=$script_dir/../../playbook/scripts/reviewers.sh
check_rows=$(sh "$reviewers" CHECK) || refuse 'cannot read reviewer checks'
login_rows=$(sh "$reviewers" LOGINS) || refuse 'cannot read reviewer logins'
tab=$(printf '\t')
check=$(printf '%s\n' "$check_rows" | awk -F "$tab" '$1 == "greptile" { print $2 }')
logins=$(printf '%s\n' "$login_rows" | awk -F "$tab" '$1 == "greptile" { print $2 }')
[ -n "$check" ] && [ -n "$logins" ] || refuse 'greptile is not a declared reviewer'
limits=$(sh "$script_dir/../../playbook/scripts/check-state.sh" --limits) || refuse 'cannot read check limits'
cap=$(printf '%s\n' "$limits" | sed -n 's/^cap=//p')

program='
import datetime as dt
import json
import os
import re
import sys

def timestamp(value):
  return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)

def greptile(author):
  return (author or {}).get("login", "").lower() in logins

def score(body):
  match = re.search(r"greptile_confidence_score:(\d)", body)
  if match is None:
    match = re.search(r"confidence score:\s*(\d)\s*/\s*5", body, re.I)

  return match.group(1) if match else None

pr = json.load(sys.stdin)["data"]["repository"]["pullRequest"]
logins = {login.lower() for login in os.environ["GREPTILE_LOGINS"].split()}
check_name = os.environ["GREPTILE_CHECK"].lower()
triggers = [timestamp(line) for line in sys.argv[1].splitlines()]
since = max(triggers) if triggers else timestamp(pr["createdAt"])
candidates = []
edits = [timestamp(edit["editedAt"]) for edit in pr["userContentEdits"]["nodes"] if greptile(edit["editor"])]
body_score = score(pr["body"])
if edits and max(edits) > since and body_score is not None:
  candidates.append((max(edits), "body", body_score))

skips = []
reviewed_candidates = []
match = re.search(r"Last reviewed commit[^\n]*commit/([0-9a-fA-F]{40})(?![0-9a-fA-F])", pr["body"])
if edits and match:
  reviewed_candidates.append((max(edits), match.group(1)))

for source, connection, time_key in (("comment", "comments", "updatedAt"), ("review", "reviews", "submittedAt")):
  for entry in pr[connection]["nodes"]:
    if not greptile(entry["author"]):
      continue

    if not entry[time_key]:
      continue

    time = timestamp(entry[time_key])
    if source == "review" and (entry["body"] or "").strip():
      reviewed_candidates.append((time, entry["commit"]["oid"]))

    if time <= since:
      continue

    value = score(entry["body"])
    if value is not None:
      candidates.append((time, source, value))

    if re.search("review was skipped", entry["body"], re.I):
      skips.append(time)

reviewed = max(reviewed_candidates, key=lambda entry: entry[0])[1] if reviewed_candidates else "none"
newest_score = max(candidates, key=lambda entry: entry[0]) if candidates else None
skipped = bool(skips) and (newest_score is None or max(skips) > newest_score[0])

now = timestamp(os.environ["REVIEW_NOW"]) if os.environ.get("REVIEW_NOW") else dt.datetime.now(dt.timezone.utc)
cap = int(os.environ["GREPTILE_CAP"])
running = False
required = "none"
commits = pr["commits"]["nodes"]
for entry in commits:
  rollup = entry["commit"]["statusCheckRollup"]
  if rollup is None:
    continue

  for check in rollup["contexts"]["nodes"]:
    if check["__typename"] != "CheckRun" or check_name not in check["name"].lower():
      continue

    started = check.get("startedAt") or (check.get("checkSuite") or {}).get("createdAt")
    if check["status"] != "COMPLETED" and (not started or (now - timestamp(started)).total_seconds() < cap):
      running = True

    stated = re.search(r"required\s+([0-5])\s*/\s*5", check.get("title") or "", re.I)
    if stated:
      required = stated.group(1)

value = newest_score[2] if newest_score else "none"
running_text = "yes" if running else "no"
skipped_text = "yes" if skipped else "no"
print(f"score={value} paid={len(triggers)} running={running_text} skipped={skipped_text} reviewed={reviewed} required={required}")
'

response=$(gh api graphql -F 'owner={owner}' -F 'repo={repo}' -F "number=$number" -F "query=@$script_dir/score.graphql") \
  || refuse 'gh failed reading PR review'
triggers=$(gh api --paginate "repos/{owner}/{repo}/issues/$number/comments" --jq '.[] | select(.body | test("^\\s*@greptileai\\s*$")) | .created_at') \
  || refuse 'gh failed reading triggers'
result=$(printf '%s' "$response" | GREPTILE_CAP="$cap" GREPTILE_CHECK="$check" GREPTILE_LOGINS="$logins" python3 -c "$program" "$triggers") || refuse 'cannot parse PR review'
printf '%s\n' "$result"
