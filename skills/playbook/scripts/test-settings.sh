#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/settings-test.XXXXXX")
trap 'rm -rf "$tmp"' 0
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_CONFIG
export SKILLS_CONF="$tmp/skills.conf"

skills=$tmp/skills
scripts=$skills/playbook/scripts
mkdir -p "$scripts" "$skills/greptile" "$skills/testbot" "$tmp/repo" "$tmp/other" "$tmp/away"
for file in reviewers.sh settings.sh delivery-mode.sh extension-verdict.sh; do
  cp "$script_dir/$file" "$scripts/$file"
done

for name in greptile testbot; do
  printf '%s\n' '---' "name: $name" 'description: Reviewer extension.' \
    'optional: true' 'requires: prs' '---' > "$skills/$name/SKILL.md"
done

cp "$script_dir/../../greptile/reviewer.conf" "$skills/greptile/reviewer.conf"
cat > "$skills/testbot/reviewer.conf" <<'EOF'
NAME=TestBot
LOGINS=testbot testbot[bot]
HANDLES=@testbot
TRIGGER=@testbot review
CHECK=TestBot
SETTING_ROLE=advisory required|advisory
SETTING_BUDGET=1 [0-9]
EOF

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

run() {
  status=0
  (cd "$1" && sh "$scripts/settings.sh" "$2") > "$tmp/out" 2> "$tmp/err" || status=$?
}

expect_values() {
  [ "$status" -eq 0 ] || fail "status $status"
  [ "$(cat "$tmp/out")" = "$1" ] || fail "values: $(cat "$tmp/out")"
}

expect_note() { grep -Fq "$1" "$tmp/err" || fail "missing note: $1"; }

defaults=$(printf '%s\n' 'role=required' 'rereviews=2' 'threshold=4' 'critical-threshold=5')
three=$(printf '%s\n' 'role=required' 'rereviews=3' 'threshold=4' 'critical-threshold=5')
one=$(printf '%s\n' 'role=required' 'rereviews=1' 'threshold=4' 'critical-threshold=5')

printf 'DELIVERY=prs\nWITH=greptile\nGREPTILE_REREVIEWS=3\n' > "$SKILLS_CONF"
run "$tmp/away" greptile
expect_values "$three"
[ ! -s "$tmp/err" ] || fail 'base config wrote stderr'
[ "$(sh "$scripts/delivery-mode.sh")" = "$(printf 'prs\ngreptile')" ] || fail 'base delivery mode'

git init --quiet -b main "$tmp/repo"
git -C "$tmp/repo" config skills.greptile.rereviews 1
run "$tmp/repo" greptile
expect_values "$one"
run "$tmp/away" greptile
expect_values "$three"
git init --quiet -b main "$tmp/other"
run "$tmp/other" greptile
expect_values "$three"

printf 'DELIVERY=prs\nWITH=greptile\nGREPTILE_REREVIEWS=lots\n' > "$SKILLS_CONF"
run "$tmp/away" greptile
expect_values "$defaults"
expect_note 'GREPTILE_REREVIEWS=lots is not valid, skipped'
[ "$(sh "$scripts/delivery-mode.sh")" = "$(printf 'prs\ngreptile')" ] || fail 'invalid setting changed delivery mode'

printf 'DELIVERY=prs\nWITH=greptile\n' > "$SKILLS_CONF"
git -C "$tmp/repo" config --replace-all skills.greptile.rereviews "1
threshold=1"
run "$tmp/repo" greptile
expect_values "$defaults"
expect_note 'git config skills.greptile.rereviews='
[ "$(wc -l < "$tmp/out" | tr -d ' ')" -eq 4 ] || fail 'newline forged a setting'

git -C "$tmp/repo" config --replace-all skills.greptile.rereviews 1
git -C "$tmp/repo" config --add skills.greptile.rereviews 3
run "$tmp/repo" greptile
expect_values "$defaults"
expect_note 'git config skills.greptile.rereviews is set more than once, skipped'

printf 'DELIVERY=prs\nWITH=\nGREPTILE_REREVIEWS=3\n' > "$SKILLS_CONF"
run "$tmp/away" greptile
expect_values "$defaults"
expect_note 'GREPTILE_REREVIEWS ignored, greptile is not active'
run "$tmp/repo" greptile
expect_values "$defaults"
expect_note 'git config skills.greptile.rereviews ignored, greptile is not active'

printf 'DELIVERY=prs\nWITH=greptile\nGREPTILE_REREVIEW=3\n' > "$SKILLS_CONF"
run "$tmp/away" greptile
expect_values "$defaults"
expect_note 'GREPTILE_REREVIEW is no installed reviewer'

printf 'DELIVERY=prs\nWITH=greptile\nGREPTILE_REREVIEWS=3\nGREPTILE_REREVIEWS=1\n' > "$SKILLS_CONF"
run "$tmp/away" greptile
expect_values "$defaults"
expect_note 'GREPTILE_REREVIEWS is set more than once, skipped'

printf 'DELIVERY=prs\r\nWITH=greptile\r\nGREPTILE_REREVIEWS=3\r\n' > "$SKILLS_CONF"
run "$tmp/away" greptile
expect_values "$three"
[ ! -s "$tmp/err" ] || fail 'CRLF wrote stderr'

cp "$SKILLS_CONF" "$tmp/away/skills.conf"
SKILLS_CONF=skills.conf run "$tmp/away" greptile
expect_values "$defaults"
[ ! -s "$tmp/err" ] || fail 'relative config was read'

run "$tmp/away" missing
[ "$status" -eq 1 ] && [ ! -s "$tmp/out" ] || fail 'unknown reviewer status or stdout'
run "$tmp/away" Bad
[ "$status" -eq 2 ] && [ ! -s "$tmp/out" ] || fail 'bad argument status or stdout'
printf '%s\n' 'SETTING_BAD=3 [' >> "$skills/testbot/reviewer.conf"
run "$tmp/away" greptile
[ "$status" -eq 1 ] && [ ! -s "$tmp/out" ] || fail 'defective declaration status or stdout'

echo ok
