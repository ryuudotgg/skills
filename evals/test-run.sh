#!/bin/bash
set -eu

R="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
plain_name="run-test-plain-$$"
with_name="run-test-with-$$"
bad_name="run-test-bad-$$"
prs_name="run-test-prs-$$"
bad_delivery_name="run-test-bad-delivery-$$"

cleanup() {
  rm -rf "$T" "/tmp/evals/$plain_name" "/tmp/evals/$with_name" "/tmp/evals/$bad_name" "/tmp/evals/$prs_name" "/tmp/evals/$bad_delivery_name"
}
trap cleanup EXIT

fail() {
  echo "test-run: $*" >&2
  exit 1
}

command -v zsh > /dev/null || fail "zsh not on PATH"

mkdir -p "$T/root/evals" "$T/root/scripts/stubs" "$T/root/skills" "$T/root/agents" "$T/bin" "$T/home/.agents"
cp "$R/evals/run.sh" "$R/evals/digest.py" "$T/root/evals/"
cp "$R/scripts/stubs/gh" "$T/root/scripts/stubs/"

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

{
  git remote get-url origin

  if [ "$(git rev-parse main)" = "$(git rev-parse origin/main)" ]; then
    echo origin=same
  else
    echo origin=differs
  fi

  printf 'dirty=%s\n' "$(git status --porcelain | wc -l | tr -d ' ')"
  command -v gh || true
} >> "$out/stub-result.txt"

if [ -n "${GH_STUB_DIR:-}" ]; then
  gh --version > /dev/null
fi

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
prs_case=$(make_case "$prs_name")
bad_delivery_case=$(make_case "$bad_delivery_name")
printf '%s\n' fixture-optional > "$with_case/with"
printf '%s\n' nonexistent-thing > "$bad_case/with"
printf '%s\n' prs > "$prs_case/delivery"
mkdir -p "$prs_case/gh"
printf '%s\n' 'gh stub' > "$prs_case/gh/--version"
printf '%s\n' yolo > "$bad_delivery_case/delivery"

PATH="$T/bin:$PATH" HOME="$T/home" SHELL=/bin/bash "$T/root/evals/run.sh" "$plain_case" > /dev/null || fail "plain case failed"
plain_result="/tmp/evals/$plain_name/latest/stub-result.txt"
grep -qx 'dirty=0' "$plain_result" || fail "plain case tree was dirty"
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

PATH="$T/bin:$PATH" HOME="$T/home" SHELL=/bin/bash "$T/root/evals/run.sh" "$prs_case" > /dev/null || fail "prs case failed"
prs_out=$(readlink "/tmp/evals/$prs_name/latest")
prs_result="$prs_out/stub-result.txt"
grep -qx 'prs' "$prs_result" || fail "prs case did not pin prs"
grep -qx 'dirty=0' "$prs_result" || fail "prs case tree was dirty"
grep -qx 'origin=same' "$prs_result" || fail "prs case origin/main differed from main"
grep -Fxq "$prs_out/remote.git" "$prs_result" || fail "prs case origin was not the bare remote"
grep -Fxq "$prs_out/bin/gh" "$prs_result" || fail "prs case gh did not resolve to the stub"

if PATH="$T/bin:$PATH" HOME="$T/home" SHELL=/bin/bash "$T/root/evals/run.sh" "$bad_delivery_case" > /dev/null 2> "$T/bad-delivery.err"; then
  fail "bad delivery case succeeded"
else
  status=$?
fi

[ "$status" -eq 2 ] || fail "bad delivery case exited $status"
grep -qx 'invalid delivery: yolo' "$T/bad-delivery.err" || fail "bad delivery diagnostic missing"
[ ! -d "/tmp/evals/$bad_delivery_name" ] || fail "bad delivery case created a directory"

echo ok
