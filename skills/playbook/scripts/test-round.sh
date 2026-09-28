#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/test-round.XXXXXX")
trap 'rm -rf "$tmp"' 0
skills=$tmp/skills
playbook=$skills/playbook/scripts
mkdir -p "$playbook" "$tmp/bin"
for file in round.sh reviewers.sh settings.sh delivery-mode.sh extension-verdict.sh; do
  cp "$script_dir/$file" "$playbook/$file"
done

export SKILLS_CONF="$tmp/skills.conf" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export ROUND_FIXTURES="$tmp" GH_STUB_LOG="$tmp/gh.log"
PATH="$tmp/bin:$script_dir/../../../scripts/stubs:$PATH"
export PATH

cat > "$tmp/bin/gh" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$GH_STUB_LOG"
exit 1
SH
chmod 755 "$tmp/bin/gh"

for name in a r s; do
  mkdir -p "$skills/$name/scripts"
  printf '%s\n' '---' "name: $name" 'description: Fixture reviewer.' 'optional: true' 'requires: prs' '---' > "$skills/$name/SKILL.md"
  cat > "$skills/$name/reviewer.conf" <<EOF
NAME=$name
LOGINS=$name $name[bot]
HANDLES=@$name
TRIGGER=@$name review
CHECK=$name
EOF
  cat > "$skills/$name/scripts/verdict.sh" <<'SH'
#!/bin/sh
name=$(basename "$(dirname "$(dirname "$0")")")
printf '%s %s\n' "$name" "$*" >> "$ROUND_FIXTURES/calls"
cat "$ROUND_FIXTURES/$name.verdict"
[ ! -f "$ROUND_FIXTURES/$name.fail" ]
SH
  printf 'done\n' > "$tmp/$name.verdict"
done

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

configure() {
  printf 'DELIVERY=prs\nWITH=%s\n' "$1" > "$SKILLS_CONF"
  : > "$tmp/calls"
}

check() {
  expected=$1
  shift
  actual=$(sh "$playbook/round.sh" "$@") || fail "round failed: $*"
  [ "$actual" = "$expected" ] || fail "expected [$expected], got [$actual]"
}

check_pair() {
  first=$1
  second=$2
  combined=$3
  reverse=$4
  printf '%s\n' "$first" > "$tmp/r.verdict"
  printf '%s\n' "$second" > "$tmp/s.verdict"
  configure 'r s'
  check "r $first
s $second
$combined" gate 18

  printf '%s\n' "$second" > "$tmp/r.verdict"
  printf '%s\n' "$first" > "$tmp/s.verdict"
  check "r $second
s $first
$reverse" gate 18
}

check_pair done 'unavailable rate-limited' done done
check_pair absent 'unavailable rate-limited' 'handback s unavailable rate-limited' 'handback r unavailable rate-limited'
check_pair absent absent done done
check_pair triage 'unavailable skipped' triage triage
check_pair triage wait wait wait
check_pair 'handback paid-cap' 'handback round-cap' 'handback r paid-cap, s round-cap' 'handback r round-cap, s paid-cap'

configure 'a r'
printf 'wait\n' > "$tmp/a.verdict"
printf 'done\n' > "$tmp/r.verdict"
check 'a wait
r done
wait' gate 18 --wait critical=true
grep -Fxq 'a gate 18 --wait critical=true' "$tmp/calls" || fail 'a did not receive wait and critical'
grep -Fxq 'r gate 18 --wait critical=true' "$tmp/calls" || fail 'r did not receive wait and critical'

check 'a wait
r done
wait' decide 18 feat/topic critical=true
grep -Fxq 'a decide 18 feat/topic critical=true' "$tmp/calls" || fail 'decide gained an outcome'

check 'a wait
r done
wait' decide 18 feat/topic r=dismissed
grep -Fxq 'r decide 18 feat/topic outcome=dismissed' "$tmp/calls" || fail 'outcome did not reach reviewer'
! grep -Fq 'a decide 18 feat/topic outcome=' "$tmp/calls" || fail 'outcome reached another reviewer'

status=0
sh "$playbook/round.sh" decide 18 feat/topic s=fixed > "$tmp/out" 2> "$tmp/err" || status=$?
[ "$status" -eq 2 ] && [ ! -s "$tmp/out" ] || fail 'inactive outcome was accepted'

status=0
sh "$playbook/round.sh" decide 18 r=fixed > "$tmp/out" 2> "$tmp/err" || status=$?
[ "$status" -eq 2 ] && [ ! -s "$tmp/out" ] || fail 'missing branch was accepted'

printf 'broken verdict\n' > "$tmp/r.verdict"
check 'a wait
r handback refused
handback r refused' gate 18
printf 'unavailable\n' > "$tmp/r.verdict"
check 'a wait
r handback refused
handback r refused' gate 18
printf 'done\nmore\n' > "$tmp/r.verdict"
check 'a wait
r handback refused
handback r refused' gate 18
printf 'done\n' > "$tmp/r.verdict"
: > "$tmp/r.fail"
check 'a wait
r handback refused
handback r refused' gate 18
rm "$tmp/r.fail"
mv "$skills/r/scripts/verdict.sh" "$tmp/r-script"
check 'a wait
r handback refused
handback r refused' gate 18
sh "$playbook/round.sh" gate 18 2>&1 >/dev/null | grep -Fxq 'round: r has no scripts/verdict.sh' || fail 'missing verdict had no note'
mv "$tmp/r-script" "$skills/r/scripts/verdict.sh"

configure ''
: > "$GH_STUB_LOG"
check done gate 18
[ ! -s "$GH_STUB_LOG" ] || fail 'empty round called gh'

configure r
printf 'malformed\n' >> "$skills/r/reviewer.conf"
status=0
sh "$playbook/round.sh" gate 18 > "$tmp/out" 2> "$tmp/err" || status=$?
[ "$status" -eq 1 ] && [ ! -s "$tmp/out" ] || fail 'malformed declaration was accepted'

echo ok
