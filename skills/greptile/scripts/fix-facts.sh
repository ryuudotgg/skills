#!/bin/sh
set -eu

usage() {
  echo 'usage: fix-facts.sh <reviewed sha> <branch>' >&2
  exit 2
}

refuse() {
  printf 'fix-facts: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 2 ] || usage
reviewed=$1
branch=$2
git show-ref --verify --quiet "refs/heads/$branch" || refuse 'branch is not a local branch'
tip=$(git rev-parse --verify "refs/heads/$branch^{commit}") || refuse 'cannot resolve branch tip'
git cat-file -e "$reviewed^{commit}" 2>/dev/null || refuse 'reviewed is not a commit'

origin_head=$(git rev-parse --verify 'origin/HEAD^{commit}' 2>/dev/null) || origin_head=
if base=$(git config "branch.$branch.skills-base") && base=$(git rev-parse --verify "$base^{commit}" 2>/dev/null); then
  :
else
  [ -n "$origin_head" ] || refuse 'cannot resolve origin/HEAD'
  base=$(git merge-base "$tip" "$origin_head") || refuse 'cannot resolve base'
fi

set -- "$reviewed...$tip" "^$base"
if [ -n "$origin_head" ]; then
  set -- "$@" "^$origin_head"
fi

commits=$(git rev-list --cherry-pick --right-only --no-merges "$@") \
  || refuse 'cannot read commits'
reviewed=$(git rev-parse "$reviewed^{commit}")
moved=no
if [ "$tip" != "$reviewed" ]; then
  moved=yes
fi

program='
import subprocess
import sys

commits = sys.argv[1].splitlines()
lines = 0
added = set()
try:
  for commit in commits:
    stats = subprocess.check_output(["git", "show", "--numstat", "--format=", commit], text=True)
    for row in stats.splitlines():
      insertions, deletions, path = row.split("\t", 2)
      lines += 30 if "-" in (insertions, deletions) else int(insertions) + int(deletions)

    paths = subprocess.check_output(["git", "show", "--diff-filter=A", "--name-only", "--format=", commit], text=True)
    added.update(paths.splitlines())
except subprocess.CalledProcessError:
  print("fix-facts: cannot read commit changes", file=sys.stderr)
  sys.exit(1)

print(f"commits={len(commits)} lines={lines} added={len(added)} moved={sys.argv[2]}")
'

python3 -c "$program" "$commits" "$moved"
