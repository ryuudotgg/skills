#!/bin/sh
set -eu

usage() {
  echo 'usage: score.sh <pr> [--wait]' >&2
  exit 2
}

refuse() {
  printf 'score: %s\n' "$*" >&2
  exit 1
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
case $1 in
  *[!0-9]*|'') usage ;;
esac

[ "$#" -eq 1 ] || [ "$2" = --wait ] || usage
number=$1
script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
reviewers=$script_dir/../../playbook/scripts/reviewers.sh
check_rows=$(sh "$reviewers" CHECK) || refuse 'cannot read reviewer checks'
login_rows=$(sh "$reviewers" LOGINS) || refuse 'cannot read reviewer logins'
tab=$(printf '\t')
check=$(printf '%s\n' "$check_rows" | awk -F "$tab" '$1 == "greptile" { print $2 }')
logins=$(printf '%s\n' "$login_rows" | awk -F "$tab" '$1 == "greptile" { print $2 }')
[ -n "$check" ] && [ -n "$logins" ] || refuse 'greptile is not a declared reviewer'

grace=
if [ "$#" -eq 2 ]; then
  settings=$(sh "$script_dir/../../playbook/scripts/settings.sh" greptile) || refuse 'cannot read reviewer settings'
  grace=$(printf '%s\n' "$settings" | sed -n 's/^grace-minutes=//p')
fi

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
present = bool(edits)
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

    present = True
    if not entry[time_key]:
      continue

    time = timestamp(entry[time_key])
    if source == "review":
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

running = False
required = "none"
commits = pr["commits"]["nodes"]
for index, entry in enumerate(commits):
  rollup = entry["commit"]["statusCheckRollup"]
  if rollup is None:
    continue

  for check in rollup["contexts"]["nodes"]:
    if check["__typename"] != "CheckRun" or check_name not in check["name"].lower():
      continue

    present = True
    if index == len(commits) - 1 and check["status"] != "COMPLETED":
      running = True

    stated = re.search(r"required\s+([0-5])\s*/\s*5", check.get("title") or "", re.I)
    if stated:
      required = stated.group(1)

# The page sizes mirror score.graphql. A full page may hide the reviewer, so it never reads as absent.
contexts = [entry["commit"]["statusCheckRollup"]["contexts"]["nodes"] for entry in commits if entry["commit"]["statusCheckRollup"]]
pages = [(pr["userContentEdits"]["nodes"], 20), (pr["comments"]["nodes"], 100), (pr["reviews"]["nodes"], 100), (commits, 100)]
pages += [(nodes, 100) for nodes in contexts]
if any(len(nodes) >= size for nodes, size in pages):
  present = True

now =timestamp(os.environ["GREPTILE_NOW"]) if "GREPTILE_NOW" in os.environ else dt.datetime.now(dt.timezone.utc)
waited = max(0, int((now - since).total_seconds() // 60))
value = newest_score[2] if newest_score else "none"
running_text = "yes" if running else "no"
skipped_text = "yes" if skipped else "no"
presence_text = "" if present else " present=no"
print(f"score={value} paid={len(triggers)} running={running_text} skipped={skipped_text} waited={waited} reviewed={reviewed} required={required}{presence_text}")
'

while :; do
  response=$(gh api graphql -F 'owner={owner}' -F 'repo={repo}' -F "number=$number" -F "query=@$script_dir/score.graphql") \
    || refuse 'gh failed reading PR review'
  triggers=$(gh api --paginate "repos/{owner}/{repo}/issues/$number/comments" --jq '.[] | select(.body | test("^\\s*@greptileai\\s*$")) | .created_at') \
    || refuse 'gh failed reading triggers'
  result=$(printf '%s' "$response" | GREPTILE_CHECK="$check" GREPTILE_LOGINS="$logins" python3 -c "$program" "$triggers")
  [ "$#" -eq 2 ] || break

  waited=${result#* waited=}
  waited=${waited%% *}
  case $result in
    *' present=no') [ "$waited" -lt "$grace" ] || break ;;
  esac

  [ "$waited" -lt 10 ] || break

  case $result in
    *' running=no '* )
      case $result in
        *' skipped=yes '*) break ;;
        score=none\ *) ;;
        *) break ;;
      esac
      ;;
  esac

  sleep "${GREPTILE_POLL:-30}"
done

printf '%s\n' "$result"
