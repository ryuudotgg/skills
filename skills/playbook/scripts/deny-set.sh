#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)

awk '
  /^## Deny set per mode$/ { table = 1; next }
  table && /^## / { exit }
  !table || !/^\| / || /^\| (entry|---) / { next }
  {
    split($0, cell, "|")
    for (column = 3; column <= 4; column++) {
      action[column] = cell[column]
      gsub(/^ +| +$/, "", action[column])
      if (action[column] != "deny" && action[column] != "allow") {
        print "deny-set.sh: delivery.md deny row is neither deny nor allow: " $0 > "/dev/stderr"
        failed = 1
        exit 1
      }
    }
    entries = cell[2]
    output = action[3] "\t" action[4]
    found = 0
    while (match(entries, /`[^`]+`/)) {
      output = output "\t" substr(entries, RSTART + 1, RLENGTH - 2)
      entries = substr(entries, RSTART + RLENGTH)
      found++
    }
    if (!found) {
      print "deny-set.sh: delivery.md deny row has no backticked entry: " $0 > "/dev/stderr"
      failed = 1
      exit 1
    }
    print output
    rows++
  }
  END {
    if (failed) exit 1
    if (!rows) {
      print "deny-set.sh: no deny rows under ## Deny set per mode in delivery.md" > "/dev/stderr"
      exit 1
    }
  }' "$script_dir/../references/delivery.md"
