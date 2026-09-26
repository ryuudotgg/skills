#!/bin/bash
set -eu

R="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
plain_name="run-test-plain-$$"
with_name="run-test-with-$$"
bad_name="run-test-bad-$$"

cleanup() {
  rm -rf "$T" "/tmp/evals/$plain_name" "/tmp/evals/$with_name" "/tmp/evals/$bad_name"
}
trap cleanup EXIT

fail() {
  echo "test-run: $*" >&2
  exit 1
}

command -v zsh > /dev/null || fail "zsh not on PATH"

mkdir -p "$T/root/evals" "$T/root/skills" "$T/root/agents" "$T/bin" "$T/home/.agents"
cp "$R/evals/run.sh" "$R/evals/digest.py" "$T/root/evals/"

for entry in "$R"/skills/*; do
  ln -s "$entry" "$T/root/skills/$(basename "$entry")"
done

for entry in "$R"/agents/*; do
  ln -s "$entry" "$T/root/agents/$(basename "$entry")"
done

mkdir -p "$T/root/skills/fixture-optional"
printf '%s\n' '---' 'name: fixture-optional' 'description: eval fixture extension' 'optional: true' '---' > "$T/root/skills/fixture-optional/SKILL.md"
printf '%s\n' 'DELIVERY=prs' 'WITH=greptile' > "$T/home/.agents/skills.conf"
printf 'export SKILLS_CONF=%q\n' "$T/home/.agents/skills.conf" > "$T/home/.zprofile"
printf 'export SKILLS_CONF=%q\nexport EVAL_STARTUP_DONE=1\n' "$T/home/.agents/skills.conf" > "$T/home/.zshrc"
printf 'export SKILLS_CONF=%q\n' "$T/home/.agents/skills.conf" > "$T/home/.bash_profile"

cat > "$T/bin/claude" <<'EOF'
#!/bin/bash
set -eu
repo=$PWD
while [ "$repo" != / ] && [ ! -d "$repo/.claude" ]; do
  repo=$(dirname "$repo")
done

[ -d "$repo/.claude" ]

out=$(cd "$repo/../.." && pwd)
"$SHELL" -l -i -c 'sh .claude/skills/playbook/scripts/delivery-mode.sh 2>/dev/null | head -1; echo "startup=${EVAL_STARTUP_DONE:-}"; ls .claude/skills' > "$out/stub-result.txt" 2> "$out/stub-stderr.txt"
printf '%s\n' '{"type":"result","result":"ok"}'
EOF
chmod +x "$T/bin/claude"

make_case() {
  local name=$1
  local case_dir="$T/$name"

  mkdir -p "$case_dir"
  printf '%s\n' app > "$case_dir/project"
  printf '%s\n' test > "$case_dir/prompt.md"
  printf '%s\n' test > "$case_dir/expectations.md"
  printf '%s' "$case_dir"
}

plain_case=$(make_case "$plain_name")
with_case=$(make_case "$with_name")
bad_case=$(make_case "$bad_name")
printf '%s\n' fixture-optional > "$with_case/with"
printf '%s\n' nonexistent-thing > "$bad_case/with"

PATH="$T/bin:$PATH" HOME="$T/home" SHELL=/bin/bash "$T/root/evals/run.sh" "$plain_case" > /dev/null || fail "plain case failed"
plain_result="/tmp/evals/$plain_name/latest/stub-result.txt"
grep -qx 'hands-off' "$plain_result" || fail "plain case did not pin hands-off"
grep -qx 'startup=1' "$plain_result" || fail "plain case cut the operator startup short"
grep -qx 'playbook' "$plain_result" || fail "plain case did not link playbook"

if grep -qx 'fixture-optional' "$plain_result"; then
  fail "plain case linked fixture-optional"
fi


PATH="$T/bin:$PATH" HOME="$T/home" SHELL=/bin/bash "$T/root/evals/run.sh" "$with_case" > /dev/null || fail "with case failed"
with_result="/tmp/evals/$with_name/latest/stub-result.txt"
grep -qx 'hands-off' "$with_result" || fail "with case did not pin hands-off"
grep -qx 'fixture-optional' "$with_result" || fail "with case did not link fixture-optional"

if PATH="$T/bin:$PATH" HOME="$T/home" SHELL=/bin/bash "$T/root/evals/run.sh" "$bad_case" > /dev/null 2>&1; then
  fail "bad extension case succeeded"
else
  status=$?
fi
[ "$status" -eq 2 ] || fail "bad extension case exited $status"

echo ok
