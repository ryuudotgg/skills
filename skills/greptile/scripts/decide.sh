#!/bin/sh
set -eu

program='
timeout_minutes = 10
normal_threshold = 4
critical_threshold = 5
paid_cap = 2
small_line_limit = 30

import re
import sys

def usage():
  print("usage: decide.sh score=<0-5|none> paid=<n> running=<yes|no> skipped=<yes|no> waited=<n> reviewed=<sha|none> [commits=<n> lines=<n> added=<n> moved=<yes|no>] [critical=<true|false>]", file=sys.stderr)
  sys.exit(2)

patterns = {
  "score": r"[0-5]|none",
  "paid": r"[0-9]+",
  "running": r"yes|no",
  "skipped": r"yes|no",
  "waited": r"[0-9]+",
  "reviewed": r"[0-9a-fA-F]{40}|none",
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

if not {"score", "paid", "running", "skipped", "waited", "reviewed"} <= facts.keys():
  usage()

fix_keys = {"commits", "lines", "added", "moved"}
has_fixes = fix_keys <= facts.keys()
if fix_keys & facts.keys() and not has_fixes:
  usage()

threshold = critical_threshold if facts.get("critical", "false") == "true" else normal_threshold
small = has_fixes and int(facts["lines"]) < small_line_limit and int(facts["added"]) == 0
score = -1 if facts["score"] == "none" else int(facts["score"])
waited = int(facts["waited"])

if facts["skipped"] == "yes":
  print("handback skipped")
elif facts["running"] == "yes" and waited < timeout_minutes:
  print("wait check-running")
elif facts["running"] == "yes":
  print("handback timeout")
elif score == -1 and waited < timeout_minutes:
  print("wait no-score")
elif score == -1:
  print("handback timeout")
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

python3 -c "$program" "$@"
