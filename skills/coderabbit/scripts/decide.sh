#!/bin/sh
set -eu

program='
import os
import re
import sys

settings = dict(line.split("=", 1) for line in os.environ["DECIDE_SETTINGS"].splitlines())
limits = dict(line.split("=", 1) for line in os.environ["CHECK_LIMITS"].splitlines())

def usage():
  print("usage: decide.sh check=<pending|completed|missing> seen=<yes|no> event=<open|ready|push|trigger> elapsed=<n> age=<n|none> gate=<pending|appear|absent|timeout|no-review|decide> approved=<yes|no> reviewed=<yes|no> limited=<yes|no> retry=<n|none> reviews=<n> worst=<critical|major|minor|trivial|none> unanswered=<critical|major|minor|trivial|none> triggered=<yes|no> [critical=<true|false>] [dismissed=<yes|no>] [skipped=<disabled|ineligible>]", file=sys.stderr)
  sys.exit(2)

patterns = {
  "check": r"pending|completed|missing",
  "seen": r"yes|no",
  "event": r"open|ready|push|trigger",
  "elapsed": r"[0-9]+",
  "age": r"[0-9]+|none",
  "gate": r"pending|appear|absent|timeout|no-review|decide",
  "approved": r"yes|no",
  "reviewed": r"yes|no",
  "limited": r"yes|no",
  "retry": r"[0-9]+|none",
  "reviews": r"[0-9]+",
  "worst": r"critical|major|minor|trivial|none",
  "unanswered": r"critical|major|minor|trivial|none",
  "triggered": r"yes|no",
  "critical": r"true|false",
  "dismissed": r"yes|no",
  "skipped": r"disabled|ineligible",
}

facts = {}
for argument in " ".join(sys.argv[1:]).split():
  key, separator, value = argument.partition("=")
  if not separator or key not in patterns or key in facts or not re.fullmatch(patterns[key], value):
    usage()

  facts[key] = value

if not set(patterns).difference({"critical", "dismissed", "skipped"}) <= facts.keys():
  usage()

order = {"trivial": 0, "minor": 1, "major": 2, "critical": 3}
floor = settings["threshold"]
if facts.get("critical", "false") == "true" and order[settings["critical-threshold"]] < order[floor]:
  floor = settings["critical-threshold"]

budget_left = int(facts["reviews"]) <= int(settings["rereviews"])
elapsed = int(facts["elapsed"])
def at_floor(value):
  return value != "none" and order[value] >= order[floor]

has_findings = at_floor(facts["worst"])

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
  reason = facts["gate"]
  if facts["limited"] == "yes":
    reason = "rate-limited" + ("" if facts["retry"] == "none" else " " + facts["retry"])

  print(unavailable(reason))
elif facts["approved"] == "yes":
  print("done approved")
elif facts["reviewed"] == "no" and facts["limited"] == "yes" and (facts["retry"] != "none" or elapsed < int(limits["cap"])):
  suffix = "" if facts["retry"] == "none" else " " + facts["retry"]
  print(unavailable("rate-limited" + suffix))
elif facts["reviewed"] == "no" and facts.get("skipped") == "ineligible":
  print(unavailable("skipped"))
elif facts["reviewed"] == "no" and facts.get("skipped") == "disabled" and facts["triggered"] == "no":
  print("rereview paused" if budget_left else unavailable("paused"))
elif facts["reviewed"] == "no" and facts["triggered"] == "yes":
  print(unavailable("no-review"))
elif facts["reviewed"] == "no":
  print("rereview paused" if budget_left else unavailable("paused"))
elif not has_findings:
  print("done clean")
else:
  print(findings())
'

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
settings=$("$script_dir/../../playbook/bin/skills" --root "$script_dir/../.." settings coderabbit) || exit 1
limits=$(sh "$script_dir/../../playbook/scripts/check-state.sh" --limits) || exit 1
DECIDE_SETTINGS=$settings CHECK_LIMITS=$limits python3 -c "$program" "$@"
