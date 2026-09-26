#!/bin/sh
set -eu

repo=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/test-validate.XXXXXX")
trap 'rm -rf "$tmp"' 0

root="$tmp/root"
mkdir -p "$root"

git -C "$repo" ls-files -co --exclude-standard | while IFS= read -r file; do
  case "$file" in
    scripts/fixtures/*) continue ;;
  esac

  [ -e "$repo/$file" ] || continue
  mkdir -p "$root/$(dirname "$file")"
  cp -p "$repo/$file" "$root/$file"
done

effort="$tmp/effort"
cp -R "$root" "$effort"
cp -R "$repo/scripts/fixtures/codex-effort/." "$effort/"

cp -R "$repo/scripts/fixtures/delivery-restatement/." "$root/"

plans="$root/skills/plans/SKILL.md"
awk '{ print } /^## \/plans do/ { print "Never commit it." }' "$plans" > "$tmp/plans" && mv "$tmp/plans" "$plans"
echo 'Never commit it.' >> "$plans"
plans_line=$(wc -l < "$plans" | tr -d ' ')

fail() {
  echo "FAIL: $case_name: $1" >&2
  cat "$tmp/out" >&2
  cat "$tmp/err" >&2
  exit 1
}

case_name='owner restatement fixture'
status=0
python3 "$repo/scripts/validate.py" "$root" > "$tmp/out" 2> "$tmp/err" || status=$?
[ "$status" -eq 1 ] || fail 'expected exit status 1'
[ ! -s "$tmp/err" ] || fail 'unexpected stderr'
printf '%s\n' \
  'skills/fixture-owner/SKILL.md:6: restates the owner delivery rule, point at references/delivery.md' \
  'skills/fixture-owner/SKILL.md:8: restates the owner delivery rule, point at references/delivery.md' \
  "skills/plans/SKILL.md:$plans_line: restates the owner delivery rule, point at references/delivery.md" \
  '3 error(s)' > "$tmp/expected"

sort "$tmp/expected" > "$tmp/expected.sorted"
sort "$tmp/out" > "$tmp/out.sorted"
cmp -s "$tmp/expected.sorted" "$tmp/out.sorted" || fail 'expected the owner lines flagged and the tail and delegate lines passed'

case_name='shared model effort fixture'
status=0
python3 "$repo/scripts/validate.py" "$effort" > "$tmp/out" 2> "$tmp/err" || status=$?
[ "$status" -eq 1 ] || fail 'expected exit status 1'
[ ! -s "$tmp/err" ] || fail 'unexpected stderr'
printf '%s\n' \
  'skills/fixture-effort/SKILL.md:9: codex exec invocation pins low, but model-b requires high or medium' \
  'skills/fixture-effort/SKILL.md:10: codex exec invocation pins high, but model-a requires low' \
  '2 error(s)' > "$tmp/expected"

cmp -s "$tmp/expected" "$tmp/out" || fail 'expected both efforts of a shared model to pass and the other pins flagged'

case_name='real repository'
python3 "$repo/scripts/validate.py" "$repo" > "$tmp/out" 2> "$tmp/err" || fail 'validate.py exited nonzero'
[ ! -s "$tmp/err" ] || fail 'unexpected stderr'
printf '%s\n' ok > "$tmp/expected"
cmp -s "$tmp/expected" "$tmp/out" || fail 'expected ok'

echo ok
