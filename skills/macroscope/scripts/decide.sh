#!/bin/sh
set -eu

program='
import os
import re
import sys

settings = dict(line.split("=", 1) for line in os.environ["DECIDE_SETTINGS"].splitlines())

def usage():
  print("usage: decide.sh check=<pending|completed|missing> seen=<yes|no> event=<open|ready|push|trigger> elapsed=<n> age=<n|none> gate=<pending|appear|absent|timeout|no-review|decide> reviewed=<yes|no> reviews=<n> worst=<critical|high|medium|low|none> unanswered=<critical|high|medium|low|none> triggered=<yes|no> approval=<approved|not-approved|pending|none> [critical=<true|false>] [dismissed=<yes|no>]", file=sys.stderr)
  sys.exit(2)

patterns = {
  "check": r"pending|completed|missing",
  "seen": r"yes|no",
  "event": r"open|ready|push|trigger",
  "elapsed": r"[0-9]+",
  "age": r"[0-9]+|none",
  "gate": r"pending|appear|absent|timeout|no-review|decide",
  "reviewed": r"yes|no",
  "reviews": r"[0-9]+",
  "worst": r"critical|high|medium|low|none",
  "unanswered": r"critical|high|medium|low|none",
  "triggered": r"yes|no",
  "approval": r"approved|not-approved|pending|none",
  "critical": r"true|false",
  "dismissed": r"yes|no",
}

facts = {}
for argument in " ".join(sys.argv[1:]).split():
  key, separator, value = argument.partition("=")
  if not separator or key not in patterns or key in facts or not re.fullmatch(patterns[key], value):
    usage()

  facts[key] = value

if not set(patterns).difference({"critical", "dismissed"}) <= facts.keys():
  usage()

order = {"low": 0, "medium": 1, "high": 2, "critical": 3}
floor = settings["threshold"]
if facts.get("critical", "false") == "true" and order[settings["critical-threshold"]] < order[floor]:
  floor = settings["critical-threshold"]

budget_left = int(facts["reviews"]) <= int(settings["rereviews"])

def at_floor(value):
  return value != "none" and order[value] >= order[floor]

def findings():
  if facts.get("dismissed") == "yes":
    return "handback all-dismissed"
  if budget_left:
    return "triage findings"
  return "handback round-cap"

def unavailable(reason):
  if at_floor(facts["unanswered"]):
    return findings()
  return "unavailable " + reason

if facts["gate"] == "pending":
  print("wait check-pending")
elif facts["gate"] == "appear":
  print("wait check-appear")
elif facts["gate"] == "absent":
  print("absent")
elif facts["gate"] in ("timeout", "no-review"):
  print(unavailable(facts["gate"]))
elif at_floor(facts["unanswered"]):
  print(findings())
elif facts["reviewed"] == "no" and facts["triggered"] == "yes":
  print(unavailable("no-review"))
elif facts["reviewed"] == "no":
  print("rereview paused" if budget_left else unavailable("paused"))
elif at_floor(facts["worst"]):
  print(findings())
elif facts["approval"] == "pending":
  print("wait approval-pending")
elif facts["approval"] == "approved":
  print("done approved")
elif facts["approval"] == "none":
  print("done clean")
elif facts.get("critical") == "true":
  print("handback not-approved")
else:
  print("done clean not-approved")
'

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
settings=$("$script_dir/../../playbook/bin/skills" --root "$script_dir/../.." settings macroscope) || exit 1
DECIDE_SETTINGS=$settings python3 -c "$program" "$@"
