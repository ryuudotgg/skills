#!/bin/sh
set -eu

program='
small_line_limit = 30

import os
import re
import sys

settings = dict(line.split("=", 1) for line in os.environ["DECIDE_SETTINGS"].splitlines())
limits = dict(line.split("=", 1) for line in os.environ["CHECK_LIMITS"].splitlines())
default_threshold = int(settings["threshold"])
critical_threshold = int(settings["critical-threshold"])
paid_cap = int(settings["rereviews"])

def usage():
  print("usage: decide.sh check=<pending|completed|missing> seen=<yes|no> event=<open|ready|push|trigger> elapsed=<n> age=<n|none> gate=<pending|appear|absent|timeout|no-review|decide> score=<0-5|none> paid=<n> running=<yes|no> skipped=<yes|no> reviewed=<sha|none> required=<0-5|none> [commits=<n> lines=<n> added=<n> moved=<yes|no>] [critical=<true|false>]", file=sys.stderr)
  sys.exit(2)

patterns = {
  "check": r"pending|completed|missing",
  "seen": r"yes|no",
  "event": r"open|ready|push|trigger",
  "elapsed": r"[0-9]+",
  "age": r"[0-9]+|none",
  "gate": r"pending|appear|absent|timeout|no-review|decide",
  "score": r"[0-5]|none",
  "paid": r"[0-9]+",
  "running": r"yes|no",
  "skipped": r"yes|no",
  "reviewed": r"[0-9a-fA-F]{40}|none",
  "required": r"[0-5]|none",
  "commits": r"[0-9]+",
  "lines": r"[0-9]+",
  "added": r"[0-9]+",
  "moved": r"yes|no",
  "critical": r"true|false",
}

facts = {}
for argument in " ".join(sys.argv[1:]).split():
  key, separator, value = argument.partition("=")
  if not separator or key not in patterns or key in facts or not re.fullmatch(patterns[key], value):
    usage()

  facts[key] = value

if not {"check", "seen", "event", "elapsed", "age", "gate", "score", "paid", "running", "skipped", "reviewed", "required"} <= facts.keys():
  usage()

fix_keys = {"commits", "lines", "added", "moved"}
has_fixes = fix_keys <= facts.keys()
if fix_keys & facts.keys() and not has_fixes:
  usage()

threshold = default_threshold if facts["required"] == "none" else int(facts["required"])
if facts.get("critical", "false") == "true":
  threshold = max(threshold, critical_threshold)

small = has_fixes and int(facts["lines"]) < small_line_limit and int(facts["added"]) == 0
score = -1 if facts["score"] == "none" else int(facts["score"])

if facts["gate"] == "pending":
  print("wait check-pending")
elif facts["gate"] == "appear":
  print("wait check-appear")
elif facts["gate"] == "absent":
  print("absent")
elif facts["skipped"] == "yes":
  print("unavailable skipped")
elif facts["gate"] in ("timeout", "no-review"):
  print("unavailable " + facts["gate"])
elif score == -1 and facts["running"] == "yes":
  print("wait check-pending")
elif score == -1 and facts["check"] == "completed" and facts["age"] != "none" and int(facts["age"]) < int(limits["window"]):
  print("wait no-score")
elif score == -1:
  print("handback no-score")
elif facts["reviewed"] == "none":
  print("handback no-reviewed-commit")
elif not has_fixes:
  print("triage scored")
elif score >= threshold and not small:
  print("done large-fix")
elif score >= threshold:
  print("done threshold")
elif int(facts["paid"]) >= paid_cap:
  print("handback paid-cap")
elif int(facts["commits"]) == 0 and facts["moved"] == "yes":
  print("handback rebase-only")
elif int(facts["commits"]) == 0:
  print("handback all-dismissed")
else:
  print("rereview below-threshold")
'

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
settings=$(sh "$script_dir/../../playbook/scripts/settings.sh" greptile) || exit 1
limits=$(sh "$script_dir/../../playbook/scripts/check-state.sh" --limits) || exit 1
DECIDE_SETTINGS=$settings CHECK_LIMITS=$limits python3 -c "$program" "$@"
