#!/bin/sh
set -eu

program='
import os
import re
import sys

settings = dict(line.split("=", 1) for line in os.environ["DECIDE_SETTINGS"].splitlines())

def usage():
  print("usage: decide.sh approved=<yes|no> reviewed=<yes|no> check=<pending|done|none> limited=<yes|no> retry=<n|none> waited=<n> reviews=<n> worst=<critical|major|minor|trivial|none> triggered=<yes|no> [present=<no>] [critical=<true|false>] [dismissed=<yes|no>] [skipped=<disabled|ineligible>]", file=sys.stderr)
  sys.exit(2)

patterns = {
  "approved": r"yes|no",
  "reviewed": r"yes|no",
  "check": r"pending|done|none",
  "limited": r"yes|no",
  "retry": r"[0-9]+|none",
  "waited": r"[0-9]+",
  "reviews": r"[0-9]+",
  "worst": r"critical|major|minor|trivial|none",
  "triggered": r"yes|no",
  "present": r"no",
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

if not set(patterns).difference({"present", "critical", "dismissed", "skipped"}) <= facts.keys():
  usage()

order = {"trivial": 0, "minor": 1, "major": 2, "critical": 3}
floor = settings["threshold"]
if facts.get("critical", "false") == "true" and order[settings["critical-threshold"]] < order[floor]:
  floor = settings["critical-threshold"]

budget_left = int(facts["reviews"]) <= int(settings["rereviews"])
waited = int(facts["waited"])

if facts.get("present") == "no":
  print("absent" if waited >= int(settings["grace-minutes"]) else "wait absent")
elif facts["approved"] == "yes":
  print("done approved")
elif facts["reviewed"] == "no" and facts["limited"] == "yes" and (facts["retry"] != "none" or waited < int(settings["timeout-minutes"])):
  suffix = "" if facts["retry"] == "none" else " " + facts["retry"]
  print("handback rate-limited" + suffix)
elif facts["reviewed"] == "no" and facts.get("skipped") == "ineligible":
  print("handback skipped")
elif facts["reviewed"] == "no" and facts.get("skipped") == "disabled" and facts["triggered"] == "no":
  print("rereview paused" if budget_left else "handback paused")
elif facts["reviewed"] == "no" and facts["check"] == "pending":
  print("wait check-pending" if waited < int(settings["timeout-minutes"]) else "handback timeout")
elif facts["reviewed"] == "no":
  if waited < int(settings["grace-minutes"]):
    print("wait grace")
  elif facts["triggered"] == "yes":
    print("handback no-review")
  else:
    print("rereview paused" if budget_left else "handback paused")
elif facts["worst"] == "none" or order[facts["worst"]] < order[floor]:
  print("done clean")
elif facts.get("dismissed") == "yes":
  print("handback all-dismissed")
elif budget_left:
  print("triage findings")
else:
  print("handback round-cap")
'

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
settings=$(sh "$script_dir/../../playbook/scripts/settings.sh" coderabbit) || exit 1
DECIDE_SETTINGS=$settings python3 -c "$program" "$@"
