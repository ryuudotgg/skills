#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/plans-lint.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
project="$tmp/fixture"

mkdir -p "$project/done"

printf '%s\n' \
  'id	slug	status	pri	effort	blocked_by	ctx	branch	updated	note' \
  '036	matcher	DONE	P1	S	-	ctx-fixture	-	2026-09-23	-' \
  '042	migration	DONE	P1	S	-	ctx-fixture	-	2026-09-23	-' \
  '039	release	DROPPED	P1	S	-	ctx-fixture	-	2026-09-23	-' \
  '044	followup	TODO	P1	S	-	ctx-fixture	-	2026-09-23	-' \
  '046	review	REVIEW	P1	S	-	ctx-fixture	feat/review	2026-09-23	-' \
  > "$project/index.tsv"

printf '%s\n' \
  '---' \
  'surface: plans' \
  '---' \
  '# Valid plan' \
  '## Acceptance' \
  '- [ ] It passes lint.' \
  > "$project/001-valid.md"

printf '%s\n' \
  '---' \
  'surface: plans' \
  'critical: true   ' \
  '---' \
  '# Critical plan' \
  'critical: yes' \
  '## Acceptance' \
  '- [ ] It passes lint.' \
  > "$project/002-critical-true.md"

printf '%s\n' \
  '---' \
  'surface: plans' \
  'critical: false' \
  '---' \
  '# Noncritical plan' \
  '## Acceptance' \
  '- [ ] It passes lint.' \
  > "$project/003-critical-false.md"

printf '%s\n' \
  '---' \
  'surface: plans' \
  'critical: yes' \
  '---' \
  '# Invalid critical plan' \
  '## Acceptance' \
  '- [ ] It passes lint.' \
  > "$project/004-critical-invalid.md"

printf '%s\n' \
  'The context remains pending until 042 closes.' \
  'The next migration, which is 036, still owns the work.' \
  'The release remains blocked by 039.' \
  'The reporting cleanup wants its own plan.' \
  'The work continues until 046 closes.' \
  'Since 036 the matcher is anchored.' \
  'Before 036 it was unanchored.' \
  'It was fixed by 042.' \
  'The pre-036 behaviour remains documented.' \
  'Plan 012 covers it.' \
  '040 renames it to fable-judgment.' \
  'The work continues until 044 closes.' \
  'The cleanup wants its own plan, which is 044.' \
  '```' \
  'The example says until 042 closes.' \
  '```' \
  > "$project/ctx-fixture.md"

printf '%s\n' \
  '---' \
  'surface: plans' \
  '---' \
  '# Cleanup' \
  '## Acceptance' \
  '- [ ] It passes lint.' \
  > "$project/045-cleanup.md"

printf '%s\n' \
  'Wait until 044 closes and until 042 closes.' \
  'The cleanup wants its own plan, which is 099.' \
  'The context is pending 099.' \
  'The cleanup wants its own plan, tracked as 099.' \
  'The cleanup wants its own plan, tracked as 045.' \
  'After 042 shipped, the matcher was anchored; 044 ships the remaining cleanup.' \
  > "$project/ctx-regression.md"

expected='004-critical-invalid.md: critical: must be true or false, got "yes"
ctx-fixture.md: line 1: forward pointer at 042 (DONE): until 042
ctx-fixture.md: line 2: forward pointer at 036 (DONE): which is 036
ctx-fixture.md: line 3: forward pointer at 039 (DROPPED): blocked by 039
ctx-fixture.md: line 4: intention with no id: wants its own plan
ctx-regression.md: line 1: forward pointer at 042 (DONE): until 042
ctx-regression.md: line 2: intention with no id: wants its own plan
ctx-regression.md: line 4: intention with no id: wants its own plan
8 error(s)'

if output=$(PLANS_DIR="$tmp" sh "$script_dir/lint.sh" fixture 2>&1); then
  echo 'lint succeeded for an invalid fixture' >&2
  exit 1
else
  status=$?
fi

if [ "$status" -ne 1 ]; then
  echo "lint exited $status, expected 1" >&2
  exit 1
fi

if [ "$output" != "$expected" ]; then
  echo 'actual output:' >&2
  printf '%s\n' "$output" >&2
  echo 'expected output:' >&2
  printf '%s\n' "$expected" >&2
  exit 1
fi

awk 'NR > 4 { print }' "$project/ctx-fixture.md" > "$tmp/ctx-fixture-clean.md"
mv "$tmp/ctx-fixture-clean.md" "$project/ctx-fixture.md"
rm "$project/ctx-regression.md"
rm "$project/004-critical-invalid.md"

if output=$(PLANS_DIR="$tmp" sh "$script_dir/lint.sh" fixture 2>&1); then
  :
else
  status=$?
  echo "lint exited $status for a valid ctx fixture" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

if [ "$output" != 'ok' ]; then
  echo 'actual output:' >&2
  printf '%s\n' "$output" >&2
  echo 'expected output:' >&2
  printf '%s\n' 'ok' >&2
  exit 1
fi

echo ok
