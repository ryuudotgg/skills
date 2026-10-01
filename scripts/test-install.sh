#!/bin/sh
set -eu

repo=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)
tmp=$(CDPATH='' cd "$(mktemp -d "${TMPDIR:-/tmp}/test-install.XXXXXX")" && pwd)
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
older_opus=$(git -C "$repo" log --format=%H -- agents/opus-review.md | sed -n '2p')
older_comment_scan=$(git -C "$repo" log --format=%H -- hooks/comment_scan.py | sed -n '2p')
retired_version=$(git -C "$repo" log --diff-filter=AM --format=%H -n 1 -- hooks/session-brief.sh)
deleted_codex=$(git -C "$repo" log --diff-filter=D --format=%H -n 1 -- agents/codex-sol.md)
git -C "$repo" show "$older_opus:agents/opus-review.md" > "$tmp/opus-review-older.md" 2> /dev/null ||
  printf '%s\n' 'older opus review from a shallow clone' > "$tmp/opus-review-older.md"
git -C "$repo" show "$older_comment_scan:hooks/comment_scan.py" > "$tmp/comment-scan-older.py" 2> /dev/null ||
  printf '%s\n' 'older comment scanner hook from a shallow clone' > "$tmp/comment-scan-older.py"
git -C "$repo" show "$deleted_codex^:agents/codex-sol.md" > "$tmp/codex-sol-last.md" 2> /dev/null ||
  printf '%s\n' 'last codex sol from a shallow clone' > "$tmp/codex-sol-last.md"
git -C "$repo" show "$retired_version:hooks/session-brief.sh" > "$tmp/session-brief-last.sh" 2> /dev/null ||
  printf '%s\n' 'last session brief from a shallow clone' > "$tmp/session-brief-last.sh"
cp "$tmp/opus-review-older.md" "$root/agents/opus-review.md"
cp "$tmp/comment-scan-older.py" "$root/hooks/comment_scan.py"
cp "$tmp/codex-sol-last.md" "$root/agents/codex-sol.md"
cp "$tmp/session-brief-last.sh" "$root/hooks/session-brief.sh"
for shim in no-comments.sh no-em-dash.sh; do
  version=$(git -C "$repo" log --diff-filter=AM --format=%H -n 1 -- "hooks/$shim")
  git -C "$repo" show "$version:hooks/$shim" > "$tmp/$shim" 2> /dev/null ||
    printf '%s\n' 'owned retired shim from a shallow clone' > "$tmp/$shim"
  cp "$tmp/$shim" "$root/hooks/$shim"
done
git -C "$root" add -A
git -C "$root" -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false commit -qm fixture-old
cp -p "$repo/agents/opus-review.md" "$root/agents/opus-review.md"
cp -p "$repo/hooks/comment_scan.py" "$root/hooks/comment_scan.py"
rm "$root/agents/codex-sol.md"
rm "$root/hooks/session-brief.sh" "$root/hooks/no-comments.sh" "$root/hooks/no-em-dash.sh"
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

opus="$home/.claude/agents/opus-review.md"
codex="$home/.claude/agents/codex-sol.md"
printf '%s\n' 'personal opus review' > "$tmp/opus-review-personal.md"
printf '%s\n' 'personal codex sol' > "$tmp/codex-sol-personal.md"
cp "$tmp/opus-review-personal.md" "$opus"
cp "$tmp/codex-sol-personal.md" "$codex"
install 'personal agents survive' || fail 'install.sh exited nonzero'
cmp -s "$tmp/opus-review-personal.md" "$opus" || fail 'personal opus review changed'
cmp -s "$tmp/codex-sol-personal.md" "$codex" || fail 'personal codex sol changed'
grep '^skip   opus-review (.*was not installed)' "$tmp/out" > /dev/null || fail 'personal opus skip was not printed'
grep '^skip   codex-sol (.*left in place)' "$tmp/out" > /dev/null || fail 'personal codex sol skip was not printed'

cp "$tmp/opus-review-older.md" "$opus"
chmod 600 "$opus"
cp "$tmp/codex-sol-last.md" "$codex"
install 'owned agents update and prune' || fail 'install.sh exited nonzero'
cmp -s "$root/agents/opus-review.md" "$opus" || fail 'older opus review was not updated'
case $(ls -l "$opus") in -rw-------*) ;; *) fail 'updated opus review lost its mode';; esac
[ ! -e "$codex" ] || fail 'deleted codex sol was not pruned'
says 'prune  codex-sol' || fail 'codex sol prune was not printed'

mkdir -p "$tmp/personal-how"
rm "$agents/how"
ln -s "$tmp/personal-how" "$agents/how"
install 'personal store skill survives' || fail 'install.sh exited nonzero'
[ "$(readlink "$agents/how")" = "$tmp/personal-how" ] || fail 'personal store skill link changed'
grep '^skip   how (' "$tmp/out" > /dev/null || fail 'personal store skill skip was not printed'
rm "$agents/how"

rm "$home/.claude/skills/how"
ln -s "$tmp/personal-how" "$home/.claude/skills/how"
install 'personal tool skill survives' || fail 'install.sh exited nonzero'
[ "$(readlink "$home/.claude/skills/how")" = "$tmp/personal-how" ] || fail 'personal tool skill link changed'
grep '^skip   how (' "$tmp/out" > /dev/null || fail 'personal tool skill skip was not printed'
rm "$home/.claude/skills/how"
install 'tool skill after personal removal' || fail 'install.sh exited nonzero'
[ "$(readlink "$home/.claude/skills/how")" = "$agents/how" ] || fail 'tool skill was not restored'

git clone -q "$root" "$tmp/clone2"
rm "$agents/how"
ln -s "$tmp/clone2/skills/how" "$agents/how"
install 'skill from another checkout updates' || fail 'install.sh exited nonzero'
[ "$(readlink "$agents/how")" = "$root/skills/how" ] || fail 'other checkout skill was not updated'
linked_everywhere playbook || fail 'playbook is not linked everywhere'
linked_everywhere how || fail 'how is not linked everywhere'

for dir in $link_dirs; do rm "$dir/how"; done
ln -s "$tmp/moved-away/skills/how" "$agents/how"
ln -s "$agents/how" "$home/.claude/skills/how"
install 'dangling skill link survives' || fail 'install.sh exited nonzero'
[ "$(readlink "$agents/how")" = "$tmp/moved-away/skills/how" ] || fail 'dangling skill link changed'
grep '^skip   how (.*which is gone.*rerun to relink it)$' "$tmp/out" > /dev/null || fail 'dangling skill skip was not printed'
rm "$agents/how"
install 'skill relinks after dangling link removal' || fail 'install.sh exited nonzero'
[ "$(readlink "$agents/how")" = "$root/skills/how" ] || fail 'skill was not relinked'
linked_everywhere how || fail 'relinked skill is not linked everywhere'

rm "$agents/how"
ln -s "../../../clone2/skills/how" "$agents/how"
[ -d "$agents/how" ] || fail 'relative fixture link does not resolve'
install 'relative skill link survives' || fail 'install.sh exited nonzero'
[ "$(readlink "$agents/how")" = "../../../clone2/skills/how" ] || fail 'relative skill link changed'
grep '^skip   how (' "$tmp/out" > /dev/null || fail 'relative skill skip was not printed'
rm "$agents/how"
install 'skill relinks after relative link removal' || fail 'install.sh exited nonzero'
[ "$(readlink "$agents/how")" = "$root/skills/how" ] || fail 'skill was not relinked after relative link'

rm -f "$opus"
cp "$tmp/opus-review-older.md" "$opus"
chmod 444 "$opus"
install 'read only owned agent updates' || fail 'install.sh exited nonzero'
cmp -s "$root/agents/opus-review.md" "$opus" || fail 'read only opus review was not updated'
case $(ls -l "$opus") in -r--r--r--*) ;; *) fail 'read only opus review lost its mode';; esac
chmod 644 "$opus"

rm "$opus"
cp "$tmp/opus-review-older.md" "$tmp/opus-target.md"
link_value=../../../opus-target.md
ln -s "$link_value" "$opus"
install 'owned agent through symlink' || fail 'install.sh exited nonzero'
[ -L "$opus" ] || fail 'opus review link was replaced'
[ "$(readlink "$opus")" = "$link_value" ] || fail 'opus review link target changed'
cmp -s "$root/agents/opus-review.md" "$tmp/opus-target.md" || fail 'opus review link target was not updated'
if find "$tmp" -name '.install.*' -print | grep -q .; then fail 'agent temp file remained'; fi
rm "$opus"
install 'agent after symlink removal' || fail 'install.sh exited nonzero'
[ -f "$opus" ] && [ ! -L "$opus" ] || fail 'opus review was not installed as a file'

rm "$opus"
link_value="$tmp/missing/opus-review.md"
ln -s "$link_value" "$opus"
install 'dangling agent symlink' || fail 'install.sh exited nonzero'
[ -L "$opus" ] || fail 'dangling opus review link was removed'
[ "$(readlink "$opus")" = "$link_value" ] || fail 'dangling opus review link changed'
grep '^skip   opus-review (' "$tmp/out" > /dev/null || fail 'dangling opus skip was not printed'
rm "$opus"

install 'clean agents install' || fail 'install.sh exited nonzero'
ls -li "$home/.claude/agents" > "$tmp/agent-inodes"
find "$home/.claude/agents" -type f -exec cksum {} \; | sort > "$tmp/agent-cksums"
install 'clean agents rerun' || fail 'install.sh exited nonzero'
find "$home/.claude/agents" -type f -exec cksum {} \; | sort | cmp -s "$tmp/agent-cksums" - || fail 'agent checksums changed on rerun'
ls -li "$home/.claude/agents" | cmp -s "$tmp/agent-inodes" - || fail 'agent files were rewritten on rerun'

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
[ -f "$home/.claude/hooks/commit-guard.sh" ] || fail 'commit guard shell hook is missing'
[ -f "$home/.claude/hooks/commit_guard.py" ] || fail 'commit guard python hook is missing'
[ -x "$home/.claude/hooks/commit-guard.sh" ] || fail 'commit guard shell hook is not executable'
grep -F '"PreToolUse"' "$home/.codex/hooks.json" > /dev/null || fail 'hooks.json has no PreToolUse hook'
grep -F 'commit-guard.sh' "$home/.codex/hooks.json" > /dev/null || fail 'hooks.json has no commit guard'
cp "$home/.codex/hooks.json" "$tmp/hooks-first"
install 'hooks second run' || fail 'install.sh exited nonzero'
cmp -s "$tmp/hooks-first" "$home/.codex/hooks.json" || fail 'hooks.json changed between runs'

printf '%s\n' 'personal comment scanner helper' > "$tmp/comment-scan-personal.py"
cp "$tmp/comment-scan-personal.py" "$home/.claude/hooks/comment_scan.py"
install 'personal comment scanner hook survives' || fail 'install.sh exited nonzero'
cmp -s "$tmp/comment-scan-personal.py" "$home/.claude/hooks/comment_scan.py" || fail 'personal comment scanner hook changed'
grep '^skip   comment_scan.py (.*was not installed)' "$tmp/out" > /dev/null || fail 'personal comment scanner skip was not printed'
for importer in $(grep -lE '^(from comment_scan|import comment_scan)' "$root"/hooks/*); do
  case "$importer" in */test_*|*.sh) continue;; esac
  name=$(basename "$importer")
  says "broken $name (imports comment_scan, so it will not work until the clash at $home/.claude/hooks/comment_scan.py is resolved)" || fail 'comment scanner importer was not printed'
done
says 'broken reply-guard.sh (runs reply_guard.py, which is broken above, so it will not work either)' || fail 'reply guard wrapper of a comment scanner importer was not named broken'
says "codex  $home/.codex/hooks.json already runs reply-guard.sh, which this repo did not install; remove that entry by hand if you do not want it" || fail 'an existing Codex entry for a broken wrapper was not named'
mv "$home/.codex/hooks.json" "$tmp/hooks-before-scanner-clash"
install 'comment scanner clash stays out of fresh Codex hooks' || fail 'install.sh exited nonzero'
if grep -F 'reply-guard.sh' "$home/.codex/hooks.json" > /dev/null; then fail 'a wrapper broken by the comment scanner clash was wired into Codex'; fi
grep -F 'hook post-tool-use' "$home/.codex/hooks.json" > /dev/null || fail 'the CLI edit guards were omitted during the scanner clash'
grep -F 'commit-guard.sh' "$home/.codex/hooks.json" > /dev/null || fail 'an unaffected hook was left out of Codex'
mv "$tmp/hooks-before-scanner-clash" "$home/.codex/hooks.json"
rm "$home/.claude/hooks/comment_scan.py"
install 'comment scanner after clash removal' || fail 'install.sh exited nonzero'
cmp -s "$root/hooks/comment_scan.py" "$home/.claude/hooks/comment_scan.py" || fail 'comment scanner was not installed'

cp "$tmp/comment-scan-older.py" "$home/.claude/hooks/comment_scan.py"
install 'older comment scanner hook updates' || fail 'install.sh exited nonzero'
cmp -s "$root/hooks/comment_scan.py" "$home/.claude/hooks/comment_scan.py" || fail 'older comment scanner hook was not updated'
says 'hook   comment_scan.py' || fail 'comment scanner update was not printed'

rm "$home/.claude/hooks/comment_scan.py"
link_value="$tmp/missing/comment_scan.py"
ln -s "$link_value" "$home/.claude/hooks/comment_scan.py"
install 'dangling comment scanner hook symlink' || fail 'install.sh exited nonzero'
[ -L "$home/.claude/hooks/comment_scan.py" ] || fail 'dangling comment scanner hook link was removed'
[ "$(readlink "$home/.claude/hooks/comment_scan.py")" = "$link_value" ] || fail 'dangling comment scanner hook link changed'
grep '^skip   comment_scan.py (.*was not installed)' "$tmp/out" > /dev/null || fail 'dangling comment scanner hook skip was not printed'
rm "$home/.claude/hooks/comment_scan.py"

printf '%s\n' '#!/bin/sh' 'echo personal guard' > "$tmp/commit-guard-personal.sh"
cp "$tmp/commit-guard-personal.sh" "$home/.claude/hooks/commit-guard.sh"
printf '%s\n' 'personal reply guard' > "$home/.claude/hooks/reply_guard.py"
mv "$home/.codex/hooks.json" "$tmp/hooks-before-personal-scripts"
install 'personal hook scripts stay out of Codex' || fail 'install.sh exited nonzero'
cmp -s "$tmp/commit-guard-personal.sh" "$home/.claude/hooks/commit-guard.sh" || fail 'personal commit guard changed'
says "broken reply-guard.sh (runs reply_guard.py, so it will not work until the clash at $home/.claude/hooks/reply_guard.py is resolved)" || fail 'reply guard wrapper was not named broken'
if grep -F -e 'commit-guard.sh' -e 'reply-guard.sh' "$home/.codex/hooks.json" > /dev/null; then fail 'a personal hook script was wired into Codex'; fi
grep -F 'hook post-tool-use' "$home/.codex/hooks.json" > /dev/null || fail 'an installed hook was left out of Codex'
says "skip   commit-guard.sh Codex entry (the repo's commit-guard.sh is not what runs, so none is added)" || fail 'commit guard Codex skip was not printed'
rm "$home/.claude/hooks/commit-guard.sh" "$home/.claude/hooks/reply_guard.py" "$home/.codex/hooks.json"
mv "$tmp/hooks-before-personal-scripts" "$home/.codex/hooks.json"
install 'hook scripts after personal removal' || fail 'install.sh exited nonzero'
cmp -s "$root/hooks/commit-guard.sh" "$home/.claude/hooks/commit-guard.sh" || fail 'commit guard was not reinstalled'

hooks="$home/.codex/hooks.json"
H="$home/.claude/hooks"
stamp() {
  python3 -c 'import os, sys; s = os.stat(sys.argv[1]); print(s.st_ino, s.st_mtime_ns)' "$1"
}

case_name='hook table matches shipped scripts'
python3 - "$root/scripts/codex-hooks.py" "$root/hooks" <<'PY' || fail 'a table script is missing'
import os
import runpy
import sys

for _, _, script in runpy.run_path(sys.argv[1])["ENTRIES"]:
    if script.endswith(".sh"):
        assert os.path.isfile(os.path.join(sys.argv[2], script)), script
PY

case_name='owned retired duplicates stay scoped to their event'
python3 - "$root/scripts/codex-hooks.py" "$tmp/hooks-owned.json" "$H" "$agents" <<'PY' || fail 'owned retired duplicates were not reconciled'
import contextlib
import io
import json
import os
import runpy
import sys

writer_path, path, directory, agents = sys.argv[1:]
writer = runpy.run_path(writer_path)
old = os.path.join(directory, "session-brief.sh")
entry = {"type": "command", "command": old}
data = {"hooks": {
    "SessionStart": [
        {"matcher": "custom", "groupKey": "kept", "hooks": [
            dict(entry, timeout=17), dict(entry), {"type": "command", "command": "/mine"}
        ]},
        {"matcher": "empty", "hooks": [dict(entry)]},
    ],
    "Stop": [{"hooks": [dict(entry)]}],
}}
with open(path, "w", encoding="utf-8") as output:
    json.dump(data, output)
captured = io.StringIO()
with contextlib.redirect_stdout(captured):
    writer["main"](path, directory, agents, set())
with open(path, encoding="utf-8") as source:
    result = json.load(source)
new = writer["command_for"]("hook session-start", directory, agents)
assert result["hooks"]["SessionStart"] == [{"matcher": "custom", "groupKey": "kept", "hooks": [
    {"type": "command", "command": new, "timeout": 17}, {"type": "command", "command": "/mine"}
]}]
assert result["hooks"]["Stop"][0] == data["hooks"]["Stop"][0]
assert captured.getvalue().count(f"codex  replace SessionStart {old} with {new}") == 1
assert captured.getvalue().count(f"codex  drop SessionStart {old}") == 2

for order in (("no-comments.sh", "no-em-dash.sh"), ("no-em-dash.sh", "no-comments.sh")):
    commands = [os.path.join(directory, name) for name in order]
    seed = {"hooks": {event: [] for event, _, _ in writer["ENTRIES"]}}
    writer["add_entries"](seed, writer["missing_entries"](seed, directory, agents))
    seed["hooks"]["PostToolUse"] = [
        {"matcher": "custom", "groupKey": "kept", "hooks": [
            {"type": "command", "command": commands[0], "timeout": 17},
            {"type": "command", "command": commands[1]},
        ]},
        {"matcher": "empty", "hooks": [{"type": "command", "command": commands[0]}]},
    ]
    owned = writer["owned_entries"](seed, directory, ())
    assert [entry[4] for entry in owned] == [commands[0], commands[1], commands[0]]
    assert [row[0] for row in writer["missing_entries"](seed, directory, agents)] == ["PostToolUse"]
    with open(path, "w", encoding="utf-8") as output:
        json.dump(seed, output)
    with contextlib.redirect_stdout(io.StringIO()):
        writer["main"](path, directory, agents, set())
    with open(path, encoding="utf-8") as source:
        result = json.load(source)
    new = writer["command_for"]("hook post-tool-use", directory, agents)
    assert result["hooks"]["PostToolUse"] == [{"matcher": "^(Bash|apply_patch)$", "hooks": [
        {"type": "command", "command": new},
    ]}]
    assert writer["missing_entries"](result, directory, agents) == []

    covering = json.loads(json.dumps(seed))
    covering["hooks"]["PostToolUse"][0]["matcher"] = "Bash|apply_patch|Edit"
    with open(path, "w", encoding="utf-8") as output:
        json.dump(covering, output)
    with contextlib.redirect_stdout(io.StringIO()):
        writer["main"](path, directory, agents, set())
    with open(path, encoding="utf-8") as source:
        result = json.load(source)
    assert result["hooks"]["PostToolUse"] == [{"matcher": "Bash|apply_patch|Edit", "groupKey": "kept", "hooks": [
        {"type": "command", "command": new, "timeout": 17},
    ]}]
    assert writer["missing_entries"](result, directory, agents) == []

    with open(path, "w", encoding="utf-8") as output:
        json.dump(seed, output)
    with contextlib.redirect_stdout(io.StringIO()):
        writer["main"](path, directory, agents, set())
    with open(path, "rb") as source:
        before = source.read()
    with contextlib.redirect_stdout(io.StringIO()):
        writer["main"](path, directory, agents, set())
    with open(path, "rb") as source:
        assert source.read() == before

    for personal in ((), (order[0],), (order[1],)):
        with open(path, "w", encoding="utf-8") as output:
            json.dump(seed, output)
        with open(path, "rb") as source:
            before = source.read()
        with contextlib.redirect_stdout(io.StringIO()):
            writer["main"](path, directory, agents, set(), personal, not personal)
        with open(path, "rb") as source:
            assert source.read() == before
PY

rm -f "$hooks"
install 'fresh Codex hooks file' || fail 'install.sh exited nonzero'
python3 - "$root/scripts/codex-hooks.py" "$hooks" "$H" "$agents" <<'PY' || fail 'fresh file has wrong entries'
import json
import os
import runpy
import sys

writer = runpy.run_path(sys.argv[1])
entries = writer["ENTRIES"]
with open(sys.argv[2], encoding="utf-8") as source:
    data = json.load(source)
assert "description" not in data
for event, _, script in entries:
    command = writer["command_for"](script, sys.argv[3], sys.argv[4])
    found = [hook for group in data["hooks"][event] for hook in group["hooks"] if hook["command"] == command]
    assert len(found) == 1, command
PY
cp "$hooks" "$tmp/hooks-fresh"
before=$(stamp "$hooks")
install 'fresh Codex hooks rerun' || fail 'install.sh exited nonzero'
cmp -s "$tmp/hooks-fresh" "$hooks" || fail 'fresh hooks changed on rerun'
[ "$(stamp "$hooks")" = "$before" ] || fail 'fresh hooks were opened for write on rerun'

cat > "$hooks" <<JSON
{
  "description": "Installed by ryuudotgg/skills install.sh. Scripts live in $H.",
  "hooks": {
    "SessionStart": [{ "matcher": "owned custom matcher", "groupKey": "kept", "hooks": [
      { "type": "command", "command": "$H/session-brief.sh", "timeout": 17, "entryKey": "kept" } ] }],
    "PreToolUse": [{ "matcher": "^Bash$", "hooks": [
      { "type": "command", "command": "$H/commit-guard.sh" } ] }],
    "PostToolUse": [{ "matcher": "^(Edit|MultiEdit|Write)$", "hooks": [
      { "type": "command", "command": "$H/no-em-dash.sh" },
      { "type": "command", "command": "$H/no-comments.sh" } ] }],
    "Stop": [{ "hooks": [
      { "type": "command", "command": "$H/reply-guard.sh" } ] }]
  }
}
JSON
cp "$hooks" "$tmp/hooks-old"
cp "$tmp/session-brief-last.sh" "$H/session-brief.sh"
cp "$tmp/no-em-dash.sh" "$H/no-em-dash.sh"
cp "$tmp/no-comments.sh" "$H/no-comments.sh"
before=$(stamp "$hooks")
install 'old Codex hooks file' || fail 'install.sh exited nonzero'
python3 - "$root/scripts/codex-hooks.py" "$tmp/hooks-old" "$hooks" "$H" "$agents" <<'PY' || fail 'old entry was not replaced in place'
import json
import runpy
import sys

writer_path, original, current, directory, agents = sys.argv[1:]
writer = runpy.run_path(writer_path)
with open(original, encoding="utf-8") as source:
    seed = json.load(source)
with open(current, encoding="utf-8") as source:
    result = json.load(source)
seed["hooks"]["SessionStart"][0]["hooks"][0]["command"] = writer["command_for"]("hook session-start", directory, agents)
seed["hooks"]["PostToolUse"] = [{"matcher": "^(Bash|apply_patch)$", "hooks": [{"type": "command", "command": writer["command_for"]("hook post-tool-use", directory, agents)}]}]
assert result == seed
PY
grep -F "codex  replace SessionStart $H/session-brief.sh with $agents/playbook/bin/skills hook session-start" "$tmp/out" > /dev/null || fail 'replace line missing'
grep -F "codex  drop PostToolUse $H/no-em-dash.sh" "$tmp/out" > /dev/null || fail 'dash guard shim under the stale matcher was not dropped'
grep -F "codex  drop PostToolUse $H/no-comments.sh" "$tmp/out" > /dev/null || fail 'comment guard shim under the stale matcher was not dropped'
grep -F "codex  add PostToolUse $agents/playbook/bin/skills hook post-tool-use" "$tmp/out" > /dev/null || fail 'edit guard verb was not added under its own matcher'
grep -F 'run /hooks, trust the new entries once' "$tmp/out" > /dev/null || fail 'replacement trust line missing'
cmp -s "$tmp/session-brief-last.sh" "$H/session-brief.sh" || fail 'shipped retired hook copy was pruned'
cp "$hooks" "$tmp/hooks-replaced"
before=$(stamp "$hooks")
install 'replaced Codex hooks rerun' || fail 'install.sh exited nonzero'
cmp -s "$tmp/hooks-replaced" "$hooks" || fail 'replaced hooks changed on rerun'
[ "$(stamp "$hooks")" = "$before" ] || fail 'replaced hooks were opened for write on rerun'

python3 - "$hooks" "$H" <<'PY' || fail 'could not seed stale retired entry'
import json
import os
import sys

path, directory = sys.argv[1:]
with open(path, encoding="utf-8") as source:
    data = json.load(source)
data["hooks"]["SessionStart"].append({"matcher": "stale", "hooks": [
    {"type": "command", "command": os.path.join(directory, "session-brief.sh")}
]})
with open(path, "w", encoding="utf-8") as output:
    json.dump(data, output)
PY
install 'verb present with stale retired entry' || fail 'install.sh exited nonzero'
python3 - "$hooks" "$tmp/hooks-replaced" <<'PY' || fail 'stale entry was not dropped'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    result = json.load(source)
with open(sys.argv[2], encoding="utf-8") as source:
    seed = json.load(source)
assert result == seed
PY
grep -F "codex  drop SessionStart $H/session-brief.sh" "$tmp/out" > /dev/null || fail 'drop line missing'

cp "$tmp/hooks-old" "$hooks"
chmod 444 "$hooks"
before=$(stamp "$hooks")
install 'readonly file with owned retired entry' || fail 'install.sh exited nonzero'
cmp -s "$tmp/hooks-old" "$hooks" || fail 'readonly retired entry changed'
[ "$(stamp "$hooks")" = "$before" ] || fail 'readonly retired entry was opened for write'
grep -F "$agents/playbook/bin/skills hook session-start" "$tmp/out" > /dev/null || fail 'hand add block omitted the replacement'
grep -F "codex  remove SessionStart $H/session-brief.sh by hand" "$tmp/out" > /dev/null || fail 'readonly retired removal line missing'
chmod 644 "$hooks"

printf '%s\n' 'personal retired hook no shipped version has' > "$H/session-brief.sh"
cp "$tmp/hooks-old" "$hooks"
install 'personal retired hook is preserved' || fail 'install.sh exited nonzero'
python3 - "$hooks" "$tmp/hooks-old" <<'PY' || fail 'personal retired entry changed'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    result = json.load(source)
with open(sys.argv[2], encoding="utf-8") as source:
    seed = json.load(source)
assert result["hooks"]["SessionStart"] == seed["hooks"]["SessionStart"]
assert len(result["hooks"]["SessionStart"]) == 1
PY
grep -Fx "skip   hook session-start Codex entry ($hooks already runs $H/session-brief.sh, which this repo did not install)" "$tmp/out" > /dev/null || fail 'personal retired skip line missing'
grep -Fx 'personal retired hook no shipped version has' "$H/session-brief.sh" > /dev/null || fail 'personal hook file changed'
python3 - "$hooks" <<'PY' || fail 'could not remove the personal entry'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    data = json.load(source)
del data["hooks"]["SessionStart"]
with open(sys.argv[1], "w", encoding="utf-8") as output:
    json.dump(data, output)
PY
install 'personal retired file without an entry adds the CLI hook' || fail 'install.sh exited nonzero'
python3 - "$hooks" "$agents" <<'PY' || fail 'personal retired file blocked the CLI hook without an entry'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    data = json.load(source)
assert data["hooks"]["SessionStart"] == [{
    "matcher": "startup|resume|clear|compact",
    "hooks": [{"type": "command", "command": f"{sys.argv[2]}/playbook/bin/skills hook session-start"}],
}]
PY
rm "$H/session-brief.sh"

rm "$agents/playbook"
mkdir -p "$tmp/elsewhere/playbook"
ln -s "$tmp/elsewhere/playbook" "$agents/playbook"
cp "$tmp/hooks-old" "$hooks"
before=$(stamp "$hooks")
install 'playbook linked elsewhere skips the CLI hook' || fail 'install.sh exited nonzero'
cmp -s "$tmp/hooks-old" "$hooks" || fail 'no-cli rewrote retired entries'
[ "$(stamp "$hooks")" = "$before" ] || fail 'no-cli file was opened for write'
grep -F "skip   hook session-start Codex entry (the repo's hook session-start is not what runs, so none is added)" "$tmp/out" > /dev/null || fail 'no-cli skip line missing'
if grep -F 'remove ' "$tmp/out" > /dev/null; then fail 'no-cli printed a removal line'; fi
rm "$agents/playbook"
install 'restore the playbook link' || fail 'install.sh exited nonzero'

case_name='missing Bun skips the CLI hook'
for candidate in /opt/homebrew/bin/bun /usr/local/bin/bun; do
  [ ! -x "$candidate" ] || fail "cannot hide fallback Bun at $candidate without changing this machine"
done
path_without_bun=$(python3 - <<'PY'
import os

print(":".join(directory for directory in os.environ["PATH"].split(":")
               if not os.access(os.path.join(directory, "bun"), os.X_OK)))
PY
)
[ ! -e "$home/.bun" ] || fail 'fixture HOME contains Bun'
cp "$tmp/hooks-old" "$hooks"
before=$(stamp "$hooks")
(PATH=$path_without_bun install "$case_name") || fail 'install.sh exited nonzero'
cmp -s "$tmp/hooks-old" "$hooks" || fail 'missing Bun rewrote retired entries'
[ "$(stamp "$hooks")" = "$before" ] || fail 'missing Bun opened hooks for write'
grep -Fx "skip   hook session-start Codex entry (the repo's hook session-start is not what runs, so none is added)" "$tmp/out" > /dev/null || fail 'missing Bun skip line missing'
if grep -F 'remove ' "$tmp/out" > /dev/null; then fail 'missing Bun printed a removal line'; fi

case_name='skip output without missing entries'
python3 - "$root/scripts/codex-hooks.py" "$hooks" <<'PY' || fail 'empty skip printed hand add instructions'
import contextlib
import io
import runpy
import sys

writer = runpy.run_path(sys.argv[1])
output = io.StringIO()
with contextlib.redirect_stdout(output):
    writer["skip"](sys.argv[2], "is not writable", [], [
        ("SessionStart", "hook session-start", {}, {}, "/hooks/session-brief.sh"),
    ])
assert output.getvalue() == f"skip   {sys.argv[2]} (is not writable)\n"
PY

printf '%s\n' 'personal comment guard shim' > "$H/no-comments.sh"
python3 - "$hooks" "$H" <<'PY' || fail 'could not seed personal hooks'
import json
import os
import sys

path, directory = sys.argv[1:]
data = {
    "mine": {"x": 1},
    "hooks": {
        "Stop": [{"hooks": [{"type": "command", "command": "/mine/stop"}]}],
        "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "/mine/prompt"}]}],
        "PostToolUse": [{"matcher": "personal", "hooks": [
            {"type": "command", "command": os.path.join(directory, "no-comments.sh")},
            {"type": "command", "command": "/mine/post", "timeout": 5},
        ]}],
    },
}
with open(path, "w", encoding="utf-8") as output:
    json.dump(data, output, indent=4)
PY
cp "$hooks" "$tmp/hooks-personal"
install 'personal Codex hooks' || fail 'install.sh exited nonzero'
python3 - "$root/scripts/codex-hooks.py" "$tmp/hooks-personal" "$hooks" "$H" "$agents" <<'PY' || fail 'personal hooks changed or skills entries are wrong'
import json
import os
import runpy
import sys

writer = runpy.run_path(sys.argv[1])
entries = writer["ENTRIES"]
with open(sys.argv[2], encoding="utf-8") as source:
    seed = json.load(source)
with open(sys.argv[3], encoding="utf-8") as source:
    result = json.load(source)
rest = json.loads(json.dumps(result))
for event in list(rest["hooks"]):
    if event in seed["hooks"]:
        rest["hooks"][event] = rest["hooks"][event][:len(seed["hooks"][event])]
    else:
        del rest["hooks"][event]
assert json.dumps(rest) == json.dumps(seed)
for event, _, script in entries:
    if script == "hook post-tool-use":
        continue
    command = writer["command_for"](script, sys.argv[4], sys.argv[5])
    found = [hook for group in result["hooks"][event] for hook in group["hooks"] if hook.get("command") == command]
    assert len(found) == 1, command
assert result["hooks"]["PostToolUse"] == seed["hooks"]["PostToolUse"]
PY
cp "$hooks" "$tmp/hooks-personal-added"
before=$(stamp "$hooks")
install 'personal Codex hooks rerun' || fail 'install.sh exited nonzero'
cmp -s "$tmp/hooks-personal-added" "$hooks" || fail 'personal hooks changed on rerun'
[ "$(stamp "$hooks")" = "$before" ] || fail 'personal hooks were opened for write on rerun'

python3 - "$hooks" "$H" "$agents" "$root/scripts/codex-hooks.py" <<'PY' || fail 'could not seed hand formatted hooks'
import json
import os
import runpy
import sys

path, directory, agents, writer_path = sys.argv[1:]
writer = runpy.run_path(writer_path)
command = lambda target: {"type": "command", "command": writer["command_for"](target, directory, agents)}
data = {"hooks": {
    "Stop": [{"hooks": [command("reply-guard.sh")]}],
    "PostToolUse": [{"matcher": "personal", "hooks": [
        command("hook post-tool-use"), {"type": "command", "command": "/mine/post"}
    ]}],
    "PreToolUse": [{"matcher": "mine", "hooks": [command("commit-guard.sh")]}],
    "SessionStart": [{"matcher": "mine", "hooks": [command("hook session-start")]}],
}}
with open(path, "w", encoding="utf-8") as output:
    output.write(json.dumps(data, separators=(",", ":")))
PY
cp "$hooks" "$tmp/hooks-hand-formatted"
before=$(stamp "$hooks")
install 'hand formatted Codex hooks' || fail 'install.sh exited nonzero'
cmp -s "$tmp/hooks-hand-formatted" "$hooks" || fail 'hand formatted hooks changed'
[ "$(stamp "$hooks")" = "$before" ] || fail 'hand formatted hooks were opened for write'

printf '{ "hooks": ' > "$hooks"
cp "$hooks" "$tmp/hooks-invalid"
install 'invalid Codex hooks JSON' || fail 'install.sh exited nonzero'
cmp -s "$tmp/hooks-invalid" "$hooks" || fail 'invalid hooks changed'
python3 - "$root/scripts/codex-hooks.py" "$hooks" "$H" "$tmp/out" "$agents" <<'PY' || fail 'invalid hooks output omitted an entry'
import os
import runpy
import sys

writer = runpy.run_path(sys.argv[1])
entries = writer["ENTRIES"]
with open(sys.argv[4], encoding="utf-8") as source:
    output = source.read()
assert f"skip   {sys.argv[2]}" in output
for _, _, script in entries:
    assert writer["command_for"](script, sys.argv[3], sys.argv[5]) in output, script
PY

printf '%s\n' '{"mine": NaN, "hooks": {}}' > "$hooks"
cp "$hooks" "$tmp/hooks-nan"
install 'NaN in Codex hooks' || fail 'install.sh exited nonzero'
cmp -s "$tmp/hooks-nan" "$hooks" || fail 'a file holding NaN was rewritten'
grep -F "skip   $hooks" "$tmp/out" > /dev/null || fail 'NaN output omitted the path'

printf '%s\n' '{"hooks":{"Stop":[],"Stop":[]}}' > "$hooks"
cp "$hooks" "$tmp/hooks-duplicate"
install 'duplicate Codex hook key' || fail 'install.sh exited nonzero'
cmp -s "$tmp/hooks-duplicate" "$hooks" || fail 'duplicate key hooks changed'
grep -F "skip   $hooks" "$tmp/out" > /dev/null || fail 'duplicate key output omitted the path'

mkdir -p "$tmp/codex-target"
printf '%s\n' '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/mine/stop"}]}]}}' > "$tmp/codex-target/hooks.json"
rm -f "$hooks"
ln -s "$tmp/codex-target/hooks.json" "$hooks"
target=$(readlink "$hooks")
install 'symlinked Codex hooks' || fail 'install.sh exited nonzero'
[ "$(readlink "$hooks")" = "$target" ] || fail 'hooks symlink changed'
python3 - "$root/scripts/codex-hooks.py" "$target" "$H" "$agents" <<'PY' || fail 'symlink target lacks skills entries'
import json
import os
import runpy
import sys

writer = runpy.run_path(sys.argv[1])
entries = writer["ENTRIES"]
with open(sys.argv[2], encoding="utf-8") as source:
    data = json.load(source)
assert data["hooks"]["Stop"][0] == {"hooks": [{"type": "command", "command": "/mine/stop"}]}
for event, _, script in entries:
    command = writer["command_for"](script, sys.argv[3], sys.argv[4])
    assert sum(hook.get("command") == command for group in data["hooks"][event] for hook in group["hooks"]) == 1
PY
[ -z "$(find "$home/.codex" "$tmp/codex-target" -maxdepth 1 -name '.hooks.json.*' -print)" ] || fail 'atomic write left a temp file'
rm -f "$hooks"
install 'restore Codex hooks file' || fail 'install.sh exited nonzero'

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
[ "$(readlink "$agents/fixture-plain")" = "$tmp/elsewhere/fixture-plain" ] || fail 'personal fixture-plain link changed'
grep '^skip   fixture-plain (' "$tmp/out" > /dev/null || fail 'personal fixture-plain skip was not printed'
rm "$agents/fixture-plain"
install 'optional skill after personal removal' || fail 'install.sh exited nonzero'
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

rm -f "$conf"
awk '/^```/ { fenced = !fenced; next } fenced' "$root/README.md" |
  grep -o '\./install\.sh[^#&;|]*' | sed 's/ *$//' > "$tmp/readme-installs"

[ "$(wc -l < "$tmp/readme-installs")" -ge 2 ] || { case_name='README commands'; fail 'README shows no install.sh flags'; }

while IFS= read -r command; do
  set -f
  set -- ${command#./install.sh}
  set +f
  install "README: $command" "$@" || fail 'install.sh exited nonzero'
done < "$tmp/readme-installs"

says 'mode   hands-off' || fail 'the last README command did not leave hands-off'

printf 'DELIVERY=hands-off\nWITH=\nGREPTILE_REREVIEWS=3\n' > "$conf"
install 'reviewer setting survives rewrite' --with greptile || fail 'install.sh exited nonzero'
grep -Fx 'GREPTILE_REREVIEWS=3' "$conf" > /dev/null || fail 'reviewer setting was dropped'
grep -Fx 'DELIVERY=prs' "$conf" > /dev/null || fail 'mode did not switch to prs'
grep -Fx 'WITH=greptile' "$conf" > /dev/null || fail 'greptile was not enabled'
says 'mode   prs' || fail 'mode did not print prs'

case_name='settings.json untouched'
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
