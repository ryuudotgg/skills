#!/bin/bash
# Deploy this repo. Idempotent, safe to re-run.
#
# skills/ are symlinked into the canonical store, then linked into every agent
# tool found on this machine. Edit the repo and all of them follow.
# agents/ and hooks/ are Claude Code only and are copied, not linked, because
# those directories are not symlink-managed.
#
# --with <name>, --without <name>  turn prs mode or an optional skill on or off,
#                                  saved to SKILLS_CONF and kept on reruns
#
# AGENTS_DIR   canonical skill store, default ~/.agents/skills
# CLAUDE_HOME  where agents and hooks are copied, default ~/.claude
# SKILLS_CONF  delivery mode config, default ~/.agents/skills.conf
# SEED_DIRS    skill dirs to create if the tool is installed
# EXTRA_DIRS   skill dirs to link into only if they already exist
set -eu
R="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="${AGENTS_DIR:-$HOME/.agents/skills}"
CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
CONF="${SKILLS_CONF:-$HOME/.agents/skills.conf}"
MODE_SCRIPT="$R/skills/playbook/scripts/delivery-mode.sh"

usage() {
  echo "usage: install.sh [--with <name>]... [--without <name>]..." >&2
  exit 2
}

no_such() {
  echo "install.sh: no optional skill named $1" >&2
  exit 1
}

has() {
  case " $1 " in *" $2 "*) return 0;; esac
  return 1
}

verdict() {
  result=$(sh "$R/skills/playbook/scripts/extension-verdict.sh" "$R/skills/$1/SKILL.md") || result=""
  case $result in
    not-extension|requires-none|requires-prs|requires-unknown) echo "$result";;
    *) echo "install.sh: extension-verdict.sh gave no verdict for $1" >&2; exit 1;;
  esac
}

optional() {
  case "$(verdict "$1")" in requires-none|requires-prs) return 0;; esac
  return 1
}

with=""
without=""
while [ $# -gt 0 ]; do
  case $1 in
    --with=|--without=) usage;;
    --with=*) with="$with ${1#*=}";;
    --without=*) without="$without ${1#*=}";;
    --with|--without)
      [ $# -gt 1 ] || usage
      if [ "$1" = --with ]; then with="$with $2"; else without="$without $2"; fi
      shift;;
    *) usage;;
  esac
  shift
done

case $CONF in
  /*) ;;
  *) echo "install.sh: SKILLS_CONF must be an absolute path, got $CONF" >&2; exit 1;;
esac

set -f
for name in $with $without; do
  printf '%s\n' "$name" | LC_ALL=C grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$' || no_such "$name"
done

for name in $with; do
  if has "$without" "$name"; then
    echo "install.sh: $name is in both --with and --without" >&2
    exit 1
  fi
done

# Validity comes from delivery-mode.sh so the two never read the config differently.
if SKILLS_CONF="$CONF" sh "$MODE_SCRIPT" 2>&1 >/dev/null |
  grep -Eq '^delivery-mode: .*: (line [0-9]+: malformed, ignoring the file|not a readable regular file)$'; then
  if [ -n "$with$without" ]; then
    echo "install.sh: $CONF is invalid, fix or remove it before passing --with or --without" >&2
    exit 1
  fi
  delivery=hands-off
  saved=""
elif [ -f "$CONF" ]; then
  delivery=$(tr -d '\r' < "$CONF" | sed -n 's/^DELIVERY=//p')
  saved=$(tr -d '\r' < "$CONF" | sed -n 's/^WITH=//p')
  [ -n "$delivery" ] || delivery=hands-off
else
  delivery=hands-off
  saved=""
fi

requested=""
for name in $with; do
  [ "$name" = prs ] && continue
  optional "$name" || no_such "$name"
  requested="$requested $name"
done

for name in $without; do
  [ "$name" = prs ] || optional "$name" || has "$saved" "$name" || no_such "$name"
done

next_with=""
for name in $saved $requested; do
  if has "$without" "$name" || has "$next_with" "$name"; then continue; fi
  next_with="${next_with:+$next_with }$name"
done

next_delivery=$delivery
has "$with" prs && next_delivery=prs
has "$without" prs && next_delivery=hands-off
for name in $requested; do
  if [ "$(verdict "$name")" = requires-prs ] && ! has "$without" prs; then next_delivery=prs; fi
done

if [ -n "$with$without" ] && [ "$next_delivery" = hands-off ]; then
  for name in $next_with; do
    if [ "$(verdict "$name")" = requires-prs ]; then
      echo "install.sh: $name requires prs mode, so hands-off needs --without $name too" >&2
      exit 1
    fi
  done
fi
set +f

deny_set() {
  awk -v column="$([ "$1" = prs ] && echo 4 || echo 3)" '
    /^## Deny set per mode$/ { table = 1; next }
    table && /^## / { exit }
    !table || !/^\| / || /^\| (entry|---) / { next }
    {
      split($0, cell, "|")
      action = cell[column]
      gsub(/^ +| +$/, "", action)
      if (action == "allow") next
      if (action != "deny") {
        print "install.sh: delivery.md deny row is neither deny nor allow: " $0 > "/dev/stderr"
        failed = 1
        exit 1
      }
      entries = cell[2]
      found = 0
      while (match(entries, /`[^`]+`/)) {
        print substr(entries, RSTART + 1, RLENGTH - 2)
        entries = substr(entries, RSTART + RLENGTH)
        found++
      }
      if (!found) {
        print "install.sh: delivery.md deny row has no backticked entry: " $0 > "/dev/stderr"
        failed = 1
        exit 1
      }
      rows++
    }
    END {
      if (failed) exit 1
      if (!rows) {
        print "install.sh: no deny rows under ## Deny set per mode in delivery.md" > "/dev/stderr"
        exit 1
      }
    }' "$R/skills/playbook/references/delivery.md"
}

# Tools known to read this layout, created when the tool's config dir exists.
SEED_DIRS="${SEED_DIRS:-$CLAUDE/skills $HOME/.codex/skills}"
# Any other skills directory already on disk is linked too, never created, so
# nothing is guessed about a tool that may not read this path.
EXTRA_DIRS="${EXTRA_DIRS:-$HOME/.cursor/skills $HOME/.config/opencode/skills $HOME/.copilot/skills}"

mkdir -p "$AGENTS_DIR"

link() { # link <target> <linkpath>
  if [ -L "$2" ]; then ln -sfn "$1" "$2"
  elif [ ! -e "$2" ]; then ln -s "$1" "$2"
  fi
}

tools=""
for t in $SEED_DIRS; do
  [ -d "$(dirname "$t")" ] || continue   # tool not installed
  mkdir -p "$t"
  tools="$tools $t"
done
for t in $EXTRA_DIRS; do
  if [ -d "$t" ]; then tools="$tools $t"; fi   # link only, never create
done

deny_set "$next_delivery" > /dev/null

# Only the two keys are rewritten in place, so comments a user added survive.
if [ -n "$with$without" ] && { [ "$next_delivery" != "$delivery" ] || [ "$next_with" != "$saved" ]; }; then
  mkdir -p "$(dirname "$CONF")"
  source_conf=/dev/null
  [ -f "$CONF" ] && source_conf=$CONF
  updated=$(awk -v delivery="DELIVERY=$next_delivery" -v with="WITH=$next_with" '
    { sub(/\r$/, "") }
    /^DELIVERY=/ { print delivery; wrote_delivery = 1; next }
    /^WITH=/ { print with; wrote_with = 1; next }
    { print }
    END {
      if (!wrote_delivery) print delivery
      if (!wrote_with) print with
    }' "$source_conf")

  printf '%s\n' "$updated" > "$CONF"
  echo "config $CONF"
fi

mode_out=$(SKILLS_CONF="$CONF" sh "$MODE_SCRIPT")
mode=$(printf '%s\n' "$mode_out" | sed -n 1p)
active=$(printf '%s\n' "$mode_out" | sed 1d | tr '\n' ' ')
echo "mode   $mode"
for name in $active; do echo "with   $name"; done

deny=$(deny_set "$mode")
echo

owned() { # owned <linkpath>: the link points into this repo or the canonical store
  case "$(readlink "$1")" in "$R"/skills/*|"$AGENTS_DIR"/*) return 0;; esac
  return 1
}

unlink_skill() {
  removed=""
  if [ -L "$AGENTS_DIR/$1" ]; then
    case "$(readlink "$AGENTS_DIR/$1")" in
      "$R/skills/$1"|"$R/skills/$1/") rm -f "$AGENTS_DIR/$1"; removed=1;;
      *) echo "skip   $1 ($AGENTS_DIR/$1 links outside this checkout)"; return;;
    esac
  fi

  for t in $tools; do
    [ -L "$t/$1" ] || continue
    case "$(readlink "$t/$1")" in
      "$AGENTS_DIR/$1"|"$R/skills/$1"|"$R/skills/$1/") rm -f "$t/$1"; removed=1;;
    esac
  done

  if [ -n "$removed" ]; then echo "unlink $1"; else echo "off    $1"; fi
}

# Prune links whose source left the repo, so a removed or renamed skill does not
# linger as a dangling symlink. Only links this script created are touched.
for t in $AGENTS_DIR $tools; do
  for l in "$t"/*; do
    [ -L "$l" ] || continue
    if [ ! -e "$l" ] && owned "$l"; then rm -f "$l"; echo "prune  $(basename "$l")"; fi
  done
done

for d in "$R"/skills/*/; do
  n=$(basename "$d")
  if [ -e "$AGENTS_DIR/$n" ] && [ ! -L "$AGENTS_DIR/$n" ]; then
    echo "skip   $n ($AGENTS_DIR/$n exists and is not a link)"
    continue
  fi

  state=$(verdict "$n")
  if [ "$state" != not-extension ] && ! has "$active" "$n"; then
    unlink_skill "$n"
    continue
  fi

  ln -sfn "${d%/}" "$AGENTS_DIR/$n"
  for t in $tools; do link "$AGENTS_DIR/$n" "$t/$n"; done
  echo "skill  $n"
done

echo
for t in $tools; do echo "linked into $t"; done

if [ -d "$CLAUDE" ]; then
  mkdir -p "$CLAUDE/agents" "$CLAUDE/hooks"
  echo
  for n in $(git -C "$R" log --diff-filter=D --name-only --format= -- 'agents/*.md' | sed 's#^agents/##; s#\.md$##' | sort -u); do
    [ -f "$R/agents/$n.md" ] && continue
    [ -f "$CLAUDE/agents/$n.md" ] || continue
    rm -f "$CLAUDE/agents/$n.md"; echo "prune  $n"
  done
  for f in "$R"/agents/*.md; do
    [ -f "$f" ] || continue
    cp "$f" "$CLAUDE/agents/$(basename "$f")"; echo "agent  $(basename "$f" .md)"
  done
  for f in "$R"/hooks/*; do
    [ -f "$f" ] || continue
    case "$f" in */test_*) continue;; esac
    cp "$f" "$CLAUDE/hooks/$(basename "$f")"
    case "$f" in *.sh) chmod +x "$CLAUDE/hooks/$(basename "$f")";; esac
    echo "hook   $(basename "$f")"
  done
  echo
  echo "Done. Hooks still need wiring in $CLAUDE/settings.json (see README)."
  echo
  echo "Deny set for $mode mode. Add it to permissions in $CLAUDE/settings.json yourself:"
  printf '%s\n' "$deny" | awk '
    BEGIN { print "\"deny\": [" }
    NR > 1 { print entry "," }
    { entry = "  \"" $0 "\"" }
    END { print entry; print "]" }'
else
  echo
  echo "Done. Skills only: no Claude Code install found, so agents and hooks were skipped."
fi

CODEX="${CODEX_HOME:-$HOME/.codex}"
if [ -d "$CODEX" ] && [ -d "$CLAUDE/hooks" ]; then
  H="$CLAUDE/hooks"
  cat > "$CODEX/hooks.json" <<JSON
{
  "description": "Installed by ryuudotgg/skills install.sh. Scripts live in $H.",
  "hooks": {
    "SessionStart": [{ "matcher": "startup|resume|clear|compact", "hooks": [
      { "type": "command", "command": "$H/session-brief.sh" } ] }],
    "PostToolUse": [{ "matcher": "^(Edit|MultiEdit|Write)$", "hooks": [
      { "type": "command", "command": "$H/no-em-dash.sh" },
      { "type": "command", "command": "$H/no-comments.sh" } ] }],
    "Stop": [{ "hooks": [
      { "type": "command", "command": "$H/reply-guard.sh" } ] }]
  }
}
JSON
  echo "codex  $CODEX/hooks.json (open codex, run /hooks, trust them once)"
fi
