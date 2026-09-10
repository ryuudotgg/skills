#!/bin/bash
# Deploy this repo. Idempotent, safe to re-run.
#
# skills/ are symlinked into the canonical store, then linked into every agent
# tool found on this machine. Edit the repo and all of them follow.
# agents/ and hooks/ are Claude Code only and are copied, not linked, because
# those directories are not symlink-managed.
#
# AGENTS_DIR   canonical skill store, default ~/.agents/skills
# CLAUDE_HOME  where agents and hooks are copied, default ~/.claude
# SEED_DIRS    skill dirs to create if the tool is installed
# EXTRA_DIRS   skill dirs to link into only if they already exist
set -eu
R="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="${AGENTS_DIR:-$HOME/.agents/skills}"
CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"

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

owned() { # owned <linkpath>: the link points into this repo or the canonical store
  case "$(readlink "$1")" in "$R"/skills/*|"$AGENTS_DIR"/*) return 0;; esac
  return 1
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
  ln -sfn "${d%/}" "$AGENTS_DIR/$n"
  for t in $tools; do link "$AGENTS_DIR/$n" "$t/$n"; done
  echo "skill  $n"
done

echo
for t in $tools; do echo "linked into $t"; done

if [ -d "$CLAUDE" ]; then
  mkdir -p "$CLAUDE/agents" "$CLAUDE/hooks"
  echo
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
else
  echo
  echo "Done. Skills only: no Claude Code install found, so agents and hooks were skipped."
fi
