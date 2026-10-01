#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/reviewers.XXXXXX")
trap 'rm -rf "$tmp"' 0

export GH_STUB_LOG="$tmp/gh.log"
export SKILLS_CONF="$tmp/skills.conf" PLANS_DIR="$tmp/plans"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null

skills=$tmp/skills
mkdir -p "$skills/playbook/scripts" "$tmp/bin"
playbook_dir=$(CDPATH= cd "$skills/playbook/scripts" && pwd -P)
for file in reviewers.sh; do
  cp "$script_dir/$file" "$playbook_dir/$file"
done

mkdir -p "$skills/playbook/bin"
printf '#!/bin/sh\nexec "%s" --root "%s" "$@"\n' "$script_dir/../bin/skills" "$skills" > "$skills/playbook/bin/skills"
chmod +x "$skills/playbook/bin/skills"

for name in greptile testbot thirdbot; do
  mkdir -p "$skills/$name"
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
EOF
cat > "$skills/thirdbot/reviewer.conf" <<'EOF'
NAME=ThirdBot
LOGINS=thirdbot[bot] thirdbot
HANDLES=@thirdbot
TRIGGER=@thirdbot go
CHECK=ThirdBot
SETTING_BUDGET=1 [0-9]
EOF
printf 'DELIVERY=prs\nWITH=greptile testbot\n' > "$SKILLS_CONF"
: > "$GH_STUB_LOG"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

expect_refusal() {
  expected_status=$1
  reason=$2
  shift 2
  actual_status=0
  "$@" > "$tmp/out" 2> "$tmp/err" || actual_status=$?
  [ "$actual_status" -eq "$expected_status" ] || fail "expected exit $expected_status, got $actual_status: $reason"
  grep -Fq "$reason" "$tmp/err" || fail "missing refusal: $reason"
  [ ! -s "$tmp/out" ] || fail 'refusal printed stdout'
}

command -v jq > /dev/null || fail 'jq is required'

cp "$skills/thirdbot/reviewer.conf" "$tmp/thirdbot.conf"

pull=https://github.com/owner/repo/pull/18#discussion_r
comment() {
  printf '{"url":"%s%s","author":%s}' "$pull" "$1" "$2"
}

thread() {
  printf '{"id":"%s","isResolved":%s,"comments":{"nodes":[%s]}}' "$1" "$2" "$3"
}

mkdir -p "$PLANS_DIR/Proj" "$tmp/Proj"
printf 'id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote\n1\ta\tREVIEW\tP1\tS\t-\t-\tfeat/a\t2026-09-27\t-\n' > "$PLANS_DIR/Proj/index.tsv"
git init --quiet -b main "$tmp/Proj"
git -C "$tmp/Proj" config branch.feat/a.skills-base origin/main
export BELOW_FIXTURE="$tmp/below.json"
printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[%s,%s,%s,%s]}}}}}\n' \
  "$(thread B1 false "$(comment 60 '{"login":"testbot"}')")" \
  "$(thread B2 false "$(comment 61 '{"login":"developer"}')")" \
  "$(thread B3 false "$(comment 62 '{"login":"thirdbot-fan"}')")" \
  "$(thread B4 true "$(comment 63 '{"login":"testbot"}')")" > "$BELOW_FIXTURE"
cat > "$tmp/bin/gh" <<'SH'
#!/bin/sh
set -eu

printf '%s\n' "$*" >> "$GH_STUB_LOG"
case "$1 $2" in
  'pr list') printf 'OPEN 1\n' ;;

  'api graphql')
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --jq ]; then
        shift
        exec jq -r "$1" "$BELOW_FIXTURE"
      fi

      shift
    done

    cat "$BELOW_FIXTURE"
    ;;

  *) exit 1 ;;
esac
SH
chmod 755 "$tmp/bin/gh"
PATH="$tmp/bin:$PATH"
export PATH
cd "$tmp/Proj"

expect_refusal 1 'unresolved Greptile or TestBot or ThirdBot threads below the base' "$skills/playbook/bin/skills" plans below Proj feat/a
grep -Fq "${pull}60" "$tmp/err" || fail 'missing testbot thread'
! grep -Eq 'discussion_r6[123]' "$tmp/err" || fail 'below included another thread'
[ "$(tail -n 1 "$tmp/err")" = 'below: unresolved Greptile or TestBot or ThirdBot threads below the base' ] || fail 'below refusal names differ'

sed '/^TRIGGER=/d' "$tmp/thirdbot.conf" > "$skills/thirdbot/reviewer.conf"
: > "$GH_STUB_LOG"
expect_refusal 1 'cannot read reviewer declarations' "$skills/playbook/bin/skills" plans below Proj feat/a
[ ! -s "$GH_STUB_LOG" ] || fail 'below queried with unreadable declarations'

for name in greptile testbot thirdbot; do
  rm "$skills/$name/reviewer.conf"
done

[ ! -s "$GH_STUB_LOG" ] || fail 'missing reviewers called gh'
actual=$("$skills/playbook/bin/skills" plans below Proj feat/a) || fail 'below failed without reviewers'
[ -z "$actual" ] || fail 'below printed stdout without reviewers'
grep -Fq 'pr list' "$GH_STUB_LOG" || fail 'below skipped PR state'
! grep -Fq 'api graphql' "$GH_STUB_LOG" || fail 'below queried threads without reviewers'

echo ok
