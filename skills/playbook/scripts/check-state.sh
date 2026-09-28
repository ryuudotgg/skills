#!/bin/sh
set -eu

usage() {
  echo 'usage: check-state.sh <pr> <check> <trigger> <logins> | check-state.sh --limits' >&2
  exit 2
}

refuse() {
  printf 'check-state: %s\n' "$*" >&2
  exit 1
}

window=60
cap=1200
if [ "$#" -eq 1 ] && [ "$1" = --limits ]; then
  printf 'window=%s\ncap=%s\n' "$window" "$cap"
  exit 0
fi

[ "$#" -eq 4 ] || usage
case $1 in
  *[!0-9]*|'') usage ;;
esac

for value in "$2" "$3" "$4"; do
  printf '%s\n' "$value" | grep -q '[^[:space:]]' || usage
done

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
program='
import datetime as dt
import json
import os
import sys

check_name, trigger, login_text, window, cap = sys.argv[1:]
check_name = check_name.lower()
logins = {login.lower() for login in login_text.split()}
window, cap = int(window), int(cap)

def timestamp(value):
  return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))

def author_seen(author):
  return ((author or {}).get("login") or "").lower() in logins

def matches(context):
  if context["__typename"] == "StatusContext":
    return context["state"] != "EXPECTED" and check_name in context["context"].lower()
  return check_name in context["name"].lower()

def contexts(commit):
  rollup = commit["statusCheckRollup"]
  return rollup["contexts"]["nodes"] if rollup else []

def start_time(context):
  if context["__typename"] == "StatusContext":
    return timestamp(context["createdAt"])

  if context.get("startedAt"):
    return timestamp(context["startedAt"])

  suite = (context.get("checkSuite") or {}).get("createdAt")
  return max(timestamp(suite), since) if suite else since

def check_time(context):
  if context["__typename"] == "CheckRun" and context["status"] == "COMPLETED" and context.get("completedAt"):
    return timestamp(context["completedAt"])

  return start_time(context)

def pending(context):
  if context["__typename"] == "StatusContext":
    return context["state"] == "PENDING"
  return context["status"] != "COMPLETED"

pr = json.load(sys.stdin)["data"]["repository"]["pullRequest"]
commits = [node["commit"] for node in pr["commits"]["nodes"]]
head = commits[-1]
edits = pr["userContentEdits"]["nodes"]
comments = pr["comments"]["nodes"]
reviews = pr["reviews"]["nodes"]
threads = pr["reviewThreads"]["nodes"]
ready = pr["timelineItems"]["nodes"]
push = min((timestamp(item["createdAt"]) for item in head["checkSuites"]["nodes"]), default=timestamp(head["committedDate"]))
events = [(timestamp(pr["createdAt"]), "open")]
if ready:
  events.append((max(timestamp(item["createdAt"]) for item in ready), "ready"))

events.append((push, "push"))
triggers = [timestamp(item["createdAt"]) for item in comments if (item.get("body") or "").strip() == trigger]
if triggers:
  events.append((max(triggers), "trigger"))

since, event = max(enumerate(events), key=lambda item: (item[1][0], item[0]))[1]
now = timestamp(os.environ["REVIEW_NOW"]) if os.environ.get("REVIEW_NOW") else dt.datetime.now(dt.timezone.utc)
elapsed = max(0, int((now - since).total_seconds()))
all_contexts = [contexts(commit) for commit in commits]
seen = any(matches(context) for page in all_contexts for context in page)
seen = seen or any(author_seen(edit["editor"]) for edit in edits)
seen = seen or any(author_seen(item["author"]) for item in comments + reviews)
seen = seen or any(author_seen(thread["comments"]["nodes"][0]["author"]) for thread in threads if thread["comments"]["nodes"])
# GitHub pages can hide older reviewer activity when the query reaches a page limit.
pages = [(edits, 20), (comments, 100), (reviews, 100), (threads, 100), (commits, 100)]
pages.extend((page, 100) for page in all_contexts)
seen = seen or any(len(page) >= size for page, size in pages)
head_checks = [context for context in all_contexts[-1] if matches(context)]
check = "missing"
age = "none"
if head_checks:
  newest = max(enumerate(head_checks), key=lambda item: (start_time(item[1]), item[0]))[1]
  time = check_time(newest)
  check = "pending" if pending(newest) else "completed"
  if check == "completed" and event == "trigger" and time < since:
    check = "missing"
  else:
    age = max(0, int((now - time).total_seconds()))

if check == "pending":
  gate = "pending" if age < cap else "timeout"
elif check == "missing" and elapsed < window:
  gate = "appear"
elif check == "missing" and not seen:
  gate = "absent"
elif check == "missing" and event == "trigger":
  gate = "no-review"
else:
  gate = "decide"

seen_text = "yes" if seen else "no"
print(f"check={check} seen={seen_text} event={event} elapsed={elapsed} age={age} gate={gate}")
'

response=$(gh api graphql -F 'owner={owner}' -F 'repo={repo}' -F "number=$1" -F "query=@$script_dir/check-state.graphql") || refuse 'gh failed reading PR checks'
result=$(printf '%s' "$response" | python3 -c "$program" "$2" "$3" "$4" "$window" "$cap") || refuse 'cannot parse PR checks'
printf '%s\n' "$result"
