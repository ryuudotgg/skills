#!/bin/sh
set -eu

repo=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/test-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

root="$tmp/root"
home="$tmp/home"
agents="$home/.agents/skills"
conf="$home/.agents/skills.conf"
settings="$home/.claude/settings.json"
link_dirs="$agents $home/.claude/skills $home/.codex/skills"
mkdir -p "$root" "$home/.claude" "$home/.codex"
printf '%s\n' '{ "permissions": { "deny": [] } }' > "$settings"

git -C "$repo" ls-files -co --exclude-standard | while IFS= read -r file; do
  [ -e "$repo/$file" ] || continue
  mkdir -p "$root/$(dirname "$file")"
  cp -p "$repo/$file" "$root/$file"
done

mkdir -p "$root/skills/fixture-ext"
printf '%s\n' '---' 'name: fixture-ext' 'description: Fixture extension for the installer test.' \
  'optional: true' 'requires: prs' '---' > "$root/skills/fixture-ext/SKILL.md"
mkdir -p "$root/skills/fixture-plain"
printf '%s\n' '---' 'name: fixture-plain' 'description: Optional fixture that works in either mode.' \
  'optional: true' '---' > "$root/skills/fixture-plain/SKILL.md"
mkdir -p "$agents" "$tmp/elsewhere/fixture-plain"
ln -s "$tmp/elsewhere/fixture-plain" "$agents/fixture-plain"

git -C "$root" init -q
git -C "$root" add -A
git -C "$root" -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false commit -qm fixture

fail() {
  echo "FAIL: $case_name: $1" >&2
  echo 'stdout:' >&2
  cat "$tmp/out" >&2
  echo 'stderr:' >&2
  cat "$tmp/err" >&2
  exit 1
}

install() {
  case_name=$1
  shift
  HOME=$home AGENTS_DIR=$agents CLAUDE_HOME="$home/.claude" CODEX_HOME="$home/.codex" \
    SKILLS_CONF=$conf SEED_DIRS="$home/.claude/skills $home/.codex/skills" EXTRA_DIRS='' \
    "$root/install.sh" "$@" > "$tmp/out" 2> "$tmp/err"
}

links() {
  for dir in $link_dirs; do
    for l in "$dir"/*; do
      if [ -L "$l" ]; then printf '%s %s -> %s\n' "$dir" "${l##*/}" "$(readlink "$l")"; fi
    done
  done
}

linked_everywhere() {
  for dir in $link_dirs; do [ -L "$dir/$1" ] || return 1; done
}

linked_nowhere() {
  for dir in $link_dirs; do
    if [ -e "$dir/$1" ] || [ -L "$dir/$1" ]; then return 1; fi
  done
}

says() {
  grep -Fx -- "$1" "$tmp/out" > /dev/null
}

printed_deny() {
  sed -n '/^"deny": \[$/,/^\]$/p' "$tmp/out" | sed '1d;$d' | sed 's/^  "//; s/",\{0,1\}$//'
}

reference_deny() {
  column=2
  [ "$1" = prs ] && column=3
  sed -n '/^## Deny set per mode$/,/^## /p' "$root/skills/playbook/references/delivery.md" |
    grep '^| `' |
    awk -F ' [|] ' -v column="$column" '{ sub(/ [|]$/, "", $column); if ($column == "deny") print $1 }' |
    grep -o '`[^`]*`' |
    tr -d '`'
}

cksum "$settings" > "$tmp/settings-before"

install 'fresh install without flags' || fail 'install.sh exited nonzero'
says 'mode   hands-off' || fail 'mode is not hands-off'
[ ! -e "$conf" ] || fail 'a plain install wrote the config'
linked_nowhere fixture-ext || fail 'the optional fixture was linked'
linked_everywhere playbook || fail 'a core skill is not linked'
[ "$(readlink "$agents/fixture-plain")" = "$tmp/elsewhere/fixture-plain" ] || fail 'a link it does not own was removed'

install '--with fixture-ext' --with fixture-ext || fail 'install.sh exited nonzero'
printf '%s\n' DELIVERY=prs WITH=fixture-ext | cmp -s - "$conf" || fail 'config is not prs with the fixture'
says 'mode   prs' || fail 'mode is not prs'
says 'with   fixture-ext' || fail 'the fixture is not active'
linked_everywhere fixture-ext || fail 'the fixture is not linked'
cp "$conf" "$tmp/conf-enabled"

install 'rerun without flags keeps the choice' || fail 'install.sh exited nonzero'
cmp -s "$tmp/conf-enabled" "$conf" || fail 'the config changed'
says 'mode   prs' || fail 'mode is not prs'
linked_everywhere fixture-ext || fail 'the fixture was unlinked'

links | grep -v ' fixture-ext -> ' > "$tmp/links-others"
install '--without fixture-ext' --without fixture-ext || fail 'install.sh exited nonzero'
printf '%s\n' DELIVERY=prs WITH= | cmp -s - "$conf" || fail 'config lost prs or kept the fixture'
linked_nowhere fixture-ext || fail 'the fixture is still linked'
links | cmp -s "$tmp/links-others" - || fail 'another link changed'

cp "$conf" "$tmp/conf-stable"
links > "$tmp/links-stable"

if install '--with nosuch' --with nosuch; then fail 'an unknown name was accepted'; fi
grep -F 'nosuch' "$tmp/err" > /dev/null || fail 'the error does not name nosuch'

if install '--with fixture-ext --without prs' --with fixture-ext --without prs; then fail 'a prs extension was accepted in hands-off'; fi
grep -F 'fixture-ext' "$tmp/err" > /dev/null || fail 'the error does not name fixture-ext'

if install '--with prs --without prs' --with prs --without prs; then fail 'a contradiction was accepted'; fi

cmp -s "$tmp/conf-stable" "$conf" || fail 'a failed run changed the config'
links | cmp -s "$tmp/links-stable" - || fail 'a failed run changed a link'

install 'hooks first run' || fail 'install.sh exited nonzero'
cp "$home/.codex/hooks.json" "$tmp/hooks-first"
install 'hooks second run' || fail 'install.sh exited nonzero'
cmp -s "$tmp/hooks-first" "$home/.codex/hooks.json" || fail 'hooks.json changed between runs'

install 'deny set for hands-off' --without prs || fail 'install.sh exited nonzero'
printed_deny > "$tmp/deny-hands-off"
reference_deny hands-off | cmp -s - "$tmp/deny-hands-off" || fail 'printed set differs from delivery.md'
grep -Fx 'Bash(git push:*)' "$tmp/deny-hands-off" > /dev/null || fail 'hands-off does not deny git push'

install 'deny set for prs' --with prs || fail 'install.sh exited nonzero'
printed_deny > "$tmp/deny-prs"
reference_deny prs | cmp -s - "$tmp/deny-prs" || fail 'printed set differs from delivery.md'
grep -Fx 'Bash(gh pr merge:*)' "$tmp/deny-prs" > /dev/null || fail 'prs does not deny merges'
if grep -Fx 'Bash(git push:*)' "$tmp/deny-prs" > /dev/null; then fail 'prs denies git push'; fi
[ "$(wc -l < "$tmp/deny-prs")" -ge 20 ] || fail 'prs set is too short to be the whole table'
[ "$(wc -l < "$tmp/deny-hands-off")" -gt "$(wc -l < "$tmp/deny-prs")" ] || fail 'hands-off is not stricter than prs'

printf '# my comment\r\nDELIVERY=prs\r\nWITH=fixture-ext\r\n' > "$conf"
install 'hand edited CRLF config' || fail 'install.sh exited nonzero'
linked_everywhere fixture-ext || fail 'the fixture is not linked'
install 'flag on a hand edited config' --without fixture-ext || fail 'install.sh exited nonzero'
grep -Fx '# my comment' "$conf" > /dev/null || fail 'the comment was dropped'
grep -Fx 'WITH=' "$conf" > /dev/null || fail 'the fixture is still in WITH'

printf 'DELIVERY=hands-off\nWITH=fixture-ext\n' > "$conf"
install 'extension the mode drops' || fail 'install.sh exited nonzero'
linked_nowhere fixture-ext || fail 'an inactive extension was linked'

printf 'DELIVERY=hands-off\nWITH=\n' > "$conf"
install 'optional skill without requires in hands-off' --with fixture-plain || fail 'install.sh exited nonzero'
says 'mode   hands-off' || fail 'mode left hands-off'
linked_everywhere fixture-plain || fail 'fixture-plain is not linked'
install 'second extension keeps the first' --with fixture-ext || fail 'install.sh exited nonzero'
linked_everywhere fixture-plain || fail 'the first extension was unlinked'
linked_everywhere fixture-ext || fail 'the second extension is not linked'
install 'turning both off' --without fixture-ext --without fixture-plain || fail 'install.sh exited nonzero'
linked_nowhere fixture-plain || fail 'fixture-plain is still linked'

cp "$conf" "$tmp/conf-before-failure"
mv "$agents" "$tmp/agents-aside"
: > "$agents"
if install 'store that cannot be created' --without prs; then fail 'install.sh succeeded without a store'; fi
cmp -s "$tmp/conf-before-failure" "$conf" || fail 'the config changed before the store failed'
rm -f "$agents"
mv "$tmp/agents-aside" "$agents"

printf 'DELIVERY=prs\nWITH=malformed\n' > "$conf"
install 'extension named like a config error' --without malformed || fail 'install.sh exited nonzero'
grep -Fx 'WITH=' "$conf" > /dev/null || fail 'the stale name is still in WITH'

printf 'DELIVERY="prs"\n' > "$conf"
cp "$conf" "$tmp/conf-malformed"
if install 'flag on a malformed config' --with fixture-ext; then fail 'a malformed config was edited'; fi
cmp -s "$tmp/conf-malformed" "$conf" || fail 'the malformed config changed'
install 'malformed config without flags' || fail 'install.sh exited nonzero'
says 'mode   hands-off' || fail 'mode is not hands-off'

cksum "$settings" | cmp -s "$tmp/settings-before" - || fail 'settings.json changed'

case_name='validate.py with the fixture'
python3 "$root/scripts/validate.py" "$root" > "$tmp/out" 2> "$tmp/err" || fail 'validate.py rejected the fixture'

case_name='validate.py on requires without optional'
mkdir -p "$root/skills/bad-ext"
printf '%s\n' '---' 'name: bad-ext' 'description: Requires prs without being optional.' 'requires: prs' '---' \
  > "$root/skills/bad-ext/SKILL.md"
if python3 "$root/scripts/validate.py" "$root" > "$tmp/out" 2> "$tmp/err"; then fail 'validate.py accepted it'; fi
grep -F 'bad-ext' "$tmp/out" > /dev/null || fail 'validate.py did not name bad-ext'

echo ok
