#!/bin/sh
set -eu
proj="${1:?project required}"
id="${2:-}"
directory="${PLANS_DIR:-$HOME/Plans}/$proj"
index="$directory/index.tsv"
errors=0
filedids=$(for path in "$directory"/[0-9][0-9][0-9]-*.md "$directory"/done/[0-9][0-9][0-9]-*.md; do
  [ -f "$path" ] || continue
  base=$(basename "$path")
  printf '%s,' "${base%%-*}"
done)

[ -d "$directory" ] || { echo "no plans directory $directory" >&2; exit 1; }

lint_file() {
  path="$1"
  name=$(basename "$path")
  isctx=0
  case "$name" in
    ctx-*) isctx=1 ;;
  esac

  if [ "$isctx" -eq 0 ]; then
    bytes=$(wc -c < "$path" | tr -d ' ')
    if [ "$bytes" -gt 4096 ]; then
      echo "$name: $bytes bytes, over the 4096 cap"
      errors=$((errors + 1))
    fi
  fi

  bad=0
  awk -v name="$name" -v isctx="$isctx" '
  NR == 1 && $0 == "---" { opened = 1; next }
  opened && !closed && $0 == "---" { closed = 1; next }
  opened && !closed && /^surface:/ {
    value = $0
    sub(/^surface:[ \t]*/, "", value)
    sub(/[ \t]+$/, "", value)
    if (value ~ /^".*"$/ || value ~ /^'.*'$/) value = substr(value, 2, length(value) - 2)
    sub(/^[ \t]+|[ \t]+$/, "", value)
    if (value != "") surface = 1
    next
  }
  opened && !closed && /^critical:/ {
    value = $0
    sub(/^critical:[ \t]*/, "", value)
    sub(/[ \t]+$/, "", value)
    if (value != "true" && value != "false") {
      badcritical = 1
      critical = value
    }
    next
  }
  /^## / {
    heading = substr($0, 4)
    sub(/[ \t]+$/, "", heading)
    if (tolower(heading) ~ /^(current state|steps|git workflow|drift check|stop conditions|commands you will need)$/)
      banned[++bannedcount] = heading
    inacceptance = (heading == "Acceptance")
    next
  }
  inacceptance && /^([0-9]+[.)]|- \[[ xX]\]|[-*] )/ { items++ }
  END {
    if (!isctx) {
      if (!opened || !closed) {
        print name ": no frontmatter"
        bad++
      } else if (!surface) {
        print name ": frontmatter has no surface: value"
        bad++
      }
      if (badcritical) {
        print name ": critical: must be true or false, got \"" critical "\""
        bad++
      }
      if (items > 3) {
        print name ": " items " acceptance items, cap is 3"
        bad++
      }
    }
    for (i = 1; i <= bannedcount; i++) {
      print name ": banned section \"## " banned[i] "\""
      bad++
    }
    exit bad
  }
  ' "$path" || bad=$?
  errors=$((errors + bad))

  if [ "$isctx" -eq 1 ] && [ -f "$index" ]; then
    bad=0
    awk -F '\t' -v name="$name" -v filedids="$filedids" '
    function closed(pid) {
      return (pid in status) && (status[pid] == "DONE" || status[pid] == "DROPPED")
    }
    function filed(pid) {
      return (pid in status) || index(filedids, pid ",") > 0
    }
    function report(pattern, needtail,   rest, offset, start, len, seg, pid, tail, text) {
      rest = lower
      offset = 0
      while (match(rest, pattern)) {
        start = offset + RSTART
        len = RLENGTH
        seg = substr(rest, RSTART, RLENGTH)
        offset = start + len - 1
        rest = substr(lower, offset + 1)

        match(seg, /[0-9][0-9][0-9]/)
        pid = substr(seg, RSTART, 3)
        if (!closed(pid)) continue

        if (needtail) {
          tail = substr(lower, start + index(seg, pid) + 2)
          sub(/[.,;:)].*$/, "", tail)
          if (tail !~ /(lands|closes|ships|is[ \t]+done)/) continue
        }

        text = substr(line, start, len)
        sub(/[^0-9]$/, "", text)
        print name ": line " FNR ": forward pointer at " pid " (" status[pid] "): " text
        return 1
      }
      return 0
    }
    BEGIN {
      forward = "(until|once|which[ \t]+is|pending|blocked[ \t]+by|blocks[ \t]+on|waits[ \t]+on|waiting[ \t]+on|will[ \t]+be)[ \t]+[0-9][0-9][0-9]([^0-9]|$)"
      conditional = "(when|after)[ \t]+[0-9][0-9][0-9]([^0-9]|$)"
      intention = "(wants|needs|deserves|should[ \t]+be|should[ \t]+get|worth)[ \t]+its[ \t]+own[ \t]+plan"
      idtoken = "(^|[^0-9])[0-9][0-9][0-9]([^0-9]|$)"
    }
    NR == FNR {
      if (FNR > 1) status[$1] = $3
      next
    }
    /^[ \t]*```/ {
      fenced = !fenced
      next
    }
    !fenced {
      line = $0
      lower = tolower(line)

      if (report(forward, 0)) bad++
      else if (report(conditional, 1)) bad++

      if (match(lower, intention)) {
        phrase = substr(line, RSTART, RLENGTH)
        known = 0
        rest = lower
        while (match(rest, idtoken)) {
          seg = substr(rest, RSTART, RLENGTH)
          rest = substr(rest, RSTART + RLENGTH - 1)
          match(seg, /[0-9][0-9][0-9]/)
          if (filed(substr(seg, RSTART, 3))) {
            known = 1
            break
          }
        }

        if (!known) {
          print name ": line " FNR ": intention with no id: " phrase
          bad++
        }
      }
    }
    END { exit bad }
    ' "$index" "$path" || bad=$?
    errors=$((errors + bad))
  fi
}

if [ -n "$id" ]; then
  matched=0
  for path in "$directory"/"$id"-*.md; do
    [ -f "$path" ] || continue
    matched=1
    lint_file "$path"
  done
  [ "$matched" -eq 1 ] || { echo "no plan $id in $proj" >&2; exit 1; }
else
  for path in "$directory"/*.md; do
    [ -f "$path" ] || continue
    lint_file "$path"
  done
fi

if [ "$errors" -gt 0 ]; then
  echo "$errors error(s)"
  exit 1
fi

echo ok
