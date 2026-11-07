#!/bin/sh
set -eu

fail() {
  printf 'verify-update-move: %s\n' "$1" >&2
  exit 1
}

if [ $# -ne 2 ]; then
  printf '%s\n' 'usage: scripts/verify-update-move.sh <old ref> <new ref>' >&2
  exit 2
fi

checkout=$(git rev-parse --show-toplevel) || fail 'run it from a checkout of the skills repository'
old=$(git -C "$checkout" rev-parse --verify --quiet "$1^{commit}") || fail "$1 is not a commit"
new=$(git -C "$checkout" rev-parse --verify --quiet "$2^{commit}") || fail "$2 is not a commit"
git -C "$checkout" merge-base --is-ancestor "$old" "$new" || fail "$1 is not an ancestor of $2"

bun=$(command -v bun) || fail 'Bun 1.4.0 or newer must be on PATH'
cache=${BUN_INSTALL_CACHE_DIR:-${HOME-}/.bun/install/cache}
trusted=https://github.com/ryuudotgg/skills.git
mkdir -p "/tmp/plans-${PLAN_ID:-verify}"
root=$(mktemp -d "/tmp/plans-${PLAN_ID:-verify}/update-move.XXXXXX")
bare=$root/origin.git
clone=$root/skills
stubs=$root/gh

mkdir -p "$root/home" "$root/tmp" "$root/plans/skills" "$stubs"

version=$(git -C "$checkout" show "$old:package.json" | "$bun" -e 'process.stdout.write(JSON.parse(await Bun.stdin.text()).version)')
bumped=$(printf '%s' "$version" | "$bun" -e 'const [major, minor, patch] = (await Bun.stdin.text()).split("."); process.stdout.write(`${major}.${minor}.${Number(patch) + 1}`)')
tag=v$bumped

GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM

git init -q --bare --initial-branch=main "$bare"
git -C "$checkout" -c core.hooksPath=/dev/null push -q "$bare" "$new:refs/heads/main"
git -C "$bare" show "$new:package.json" | "$bun" -e 'const manifest = JSON.parse(await Bun.stdin.text()); manifest.version = process.argv[1]; await Bun.write(process.argv[2], `${JSON.stringify(manifest, null, 2)}\n`)' "$bumped" "$root/package.json"

blob=$(git -C "$bare" hash-object -w "$root/package.json")
GIT_INDEX_FILE=$root/index git -C "$bare" read-tree "$new"
GIT_INDEX_FILE=$root/index git -C "$bare" update-index --cacheinfo "100644,$blob,package.json"
tree=$(GIT_INDEX_FILE=$root/index git -C "$bare" write-tree)
release=$(git -C "$bare" -c user.name=verify -c user.email=verify@localhost commit-tree "$tree" -p "$new" -m "chore: release $bumped")
git -C "$bare" update-ref refs/heads/main "$release"
git -C "$bare" tag "$tag" "$release"

git -c core.hooksPath=/dev/null clone -q "$bare" "$clone"
git -C "$clone" -c core.hooksPath=/dev/null reset -q --hard "$old"
git -C "$clone" remote set-url origin "$trusted"
git -C "$clone" config "url.$bare.insteadOf" "$trusted"

printf '{"tag_name": "%s", "draft": false, "prerelease": false, "published_at": "2026-11-07T00:00:00Z", "html_url": "https://github.com/ryuudotgg/skills/releases/tag/%s"}\n' "$tag" "$tag" >"$stubs/api_--hostname_github.com_repos_ryuudotgg_skills_releases_tags_$tag"
printf '{"sha": "%s", "commit": {"verification": {"verified": true}}}\n' "$release" >"$stubs/api_--hostname_github.com_repos_ryuudotgg_skills_commits_$release"
printf 'id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote\n' >"$root/plans/skills/index.tsv"

run() {
  env -i \
    PATH="$checkout/scripts/stubs:${bun%/*}:/usr/bin:/bin:/usr/sbin:/sbin" \
    HOME="$root/home" \
    TMPDIR="$root/tmp" \
    TERM=dumb \
    BUN_INSTALL_CACHE_DIR="$cache" \
    GH_STUB_DIR="$stubs" \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    PLANS_DIR="$root/plans" \
    "$@" </dev/null
}

status=0
line=$(cd "$clone" && run "$clone/skills/playbook/bin/skills" update 2>"$root/update.log") || status=$?
printf '%s\n' "$line"
if [ "$status" -ne 0 ]; then
  cat "$root/update.log" >&2
  fail "skills update exited $status"
fi

(cd "$clone" && du -sm node_modules)
for docs in apps/docs docs; do
  if [ -e "$clone/$docs/node_modules" ]; then
    printf '%s\n' "$docs/node_modules: present"
  else
    printf '%s\n' "$docs/node_modules: absent"
  fi
done

cd "$clone" && run "$clone/skills/playbook/bin/skills" plans frontier
