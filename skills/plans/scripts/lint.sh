#!/bin/sh
set -eu
proj="${1:?project required}"
id="${2:-}"
directory="${PLANS_DIR:-$HOME/Plans}/$proj"
errors=0

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
