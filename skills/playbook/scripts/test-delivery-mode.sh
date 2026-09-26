#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/delivery-mode.XXXXXX")
trap 'chmod -R u+rwx "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT

skills="$tmp/fixture/skills"
mode_script="$skills/playbook/scripts/delivery-mode.sh"
home="$tmp/home"
work="$tmp/work"
mkdir -p "$skills/playbook/scripts" "$skills/greptile" "$skills/quoted" "$skills/plain" "$skills/spaced" "$skills/nested" "$home" "$work"
cp "$script_dir/delivery-mode.sh" "$mode_script"
cp "$script_dir/extension-verdict.sh" "$skills/playbook/scripts/extension-verdict.sh"

printf '%s\n' \
  '---' \
  'name: greptile' \
  'description: Greptile review loop on opened PRs.' \
  'optional: true' \
  'requires: prs' \
  '---' \
  '# Greptile' \
  > "$skills/greptile/SKILL.md"

printf '%s\n' \
  '---' \
  'name: quoted' \
  'description: An extension with a quoted requirement.' \
  'optional: true' \
  'requires: "prs"' \
  '---' \
  > "$skills/quoted/SKILL.md"

printf '%s\n' \
  '---' \
  'name: plain' \
  'description: A skill that is not an extension.' \
  '---' \
  'optional: true' \
  > "$skills/plain/SKILL.md"

printf '%s\n' \
  '---' \
  'name: spaced' \
  'description: An extension with a spaced requires key.' \
  'optional: true' \
  'requires : prs' \
  '---' \
  > "$skills/spaced/SKILL.md"

printf '%s\n' \
  '---' \
  'name: nested' \
  'description: An extension with a nested requires key.' \
  'optional: true' \
  'metadata:' \
  '  requires: prs' \
  '---' \
  > "$skills/nested/SKILL.md"

mkdir -p "$tmp/linked"
ln -s "$skills/playbook" "$tmp/linked/playbook"

fail() {
  echo "FAIL: $case_name: $1" >&2
  echo 'stdout:' >&2
  cat "$tmp/out" >&2
  echo 'stderr:' >&2
  cat "$tmp/err" >&2
  exit 1
}

run() {
  case_name=$1
  conf=$2
  cwd=${3:-$work}
  script=${4:-$mode_script}

  (
    cd "$cwd"
    unset SKILLS_CONF AGENTS_DIR
    HOME=$home
    export HOME
    if [ -n "$conf" ]; then
      SKILLS_CONF=$conf
      export SKILLS_CONF
    fi
    sh "$script" > "$tmp/out" 2> "$tmp/err"
  ) || fail "exited nonzero"

  if grep -v '^delivery-mode: ' "$tmp/err" > /dev/null; then
    fail "stderr line without the delivery-mode: prefix"
  fi
}

expect_out() {
  [ "$(cat "$tmp/out")" = "$1" ] || fail "stdout is not: $1"
}

expect_quiet() {
  [ ! -s "$tmp/err" ] || fail "stderr is not empty"
}

expect_note() {
  grep -F -- "$1" "$tmp/err" > /dev/null || fail "stderr lacks: $1"
}

conf_file() {
  printf '%b' "$1" > "$tmp/skills.conf"
  echo "$tmp/skills.conf"
}

prs_greptile=$(printf '%s\n' prs greptile)

run 'no config' ''
expect_out hands-off
expect_quiet

run 'missing SKILLS_CONF' "$tmp/nowhere/skills.conf"
expect_out hands-off
expect_quiet

if [ "$(id -u)" = 0 ]; then
  echo 'skip: unreadable config, running as root'
else
  conf=$(conf_file 'DELIVERY=prs\n')
  chmod 000 "$conf"
  run 'unreadable config' "$conf"
  expect_out hands-off
  expect_note 'not a readable regular file'
  chmod 644 "$conf"
fi

run 'quoted value' "$(conf_file 'DELIVERY="prs"\n')"
expect_out hands-off
expect_note 'line 1: malformed'

run 'export prefix' "$(conf_file 'export DELIVERY=prs\n')"
expect_out hands-off
expect_note 'line 1: malformed'

marker=$(mktemp "$tmp/marker.XXXXXX")
rm "$marker"
run 'command injection' "$(conf_file "DELIVERY=prs; touch $marker\\n")"
expect_out hands-off
expect_note 'line 1: malformed'
[ ! -e "$marker" ] || fail "the config line was executed"

run 'unknown key' "$(conf_file 'DELIVER=prs\n')"
expect_out hands-off
expect_note 'line 1: malformed'

run 'leading space' "$(conf_file ' DELIVERY=prs\n')"
expect_out hands-off
expect_note 'line 1: malformed'

run 'duplicate key' "$(conf_file 'DELIVERY=prs\nDELIVERY=prs\n')"
expect_out hands-off
expect_note 'line 2: malformed'

run 'bad last line without newline' "$(conf_file 'DELIVERY=prs\nWITH=greptile\nbad line')"
expect_out hands-off
expect_note 'line 3: malformed'

mkdir -p "$work/glob/greptile"
run 'glob in WITH' "$(conf_file 'DELIVERY=prs\nWITH=*\n')" "$work/glob"
expect_out hands-off
expect_note 'line 2: malformed'

printf 'DELIVERY=prs\n' > "$work/skills.conf"
run 'path escape in WITH' "$(conf_file 'DELIVERY=prs\nWITH=../playbook\n')"
expect_out hands-off
expect_note 'line 2: malformed'

run 'relative SKILLS_CONF' skills.conf
expect_out hands-off
expect_note 'not absolute'

run 'prs with greptile' "$(conf_file 'DELIVERY=prs\nWITH=greptile\n')"
expect_out "$prs_greptile"
expect_quiet

run 'CRLF config' "$(conf_file 'DELIVERY=prs\r\nWITH=greptile\r\n')"
expect_out "$prs_greptile"
expect_quiet

run 'hands-off with greptile' "$(conf_file 'DELIVERY=hands-off\nWITH=greptile\n')"
expect_out hands-off
expect_note 'greptile dropped: requires DELIVERY=prs'

run 'mixed extensions' "$(conf_file 'DELIVERY=prs\nWITH=greptile missing plain quoted prs greptile\n')"
expect_out "$prs_greptile"
expect_note 'missing dropped: not installed'
expect_note 'plain dropped: not an extension'
expect_note 'quoted dropped: unknown requires'
expect_note 'prs dropped: prs is a mode, set DELIVERY=prs'
[ "$(grep -c greptile "$tmp/err" || true)" = 0 ] || fail "greptile was dropped"

run 'hands-off with loose requires keys' "$(conf_file 'DELIVERY=hands-off\nWITH=spaced nested\n')"
expect_out hands-off
expect_note 'spaced dropped: unknown requires'
expect_note 'nested dropped: unknown requires'

run 'symlinked playbook resolves the real skills root' \
  "$(conf_file 'DELIVERY=prs\nWITH=greptile\n')" "$work" "$tmp/linked/playbook/scripts/delivery-mode.sh"
expect_out "$prs_greptile"
expect_quiet

run 'comments and blank lines' "$(conf_file '# delivery\n\nDELIVERY=prs\n\n# extensions\nWITH=greptile\n\n')"
expect_out "$prs_greptile"
expect_quiet

echo ok
