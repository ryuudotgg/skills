#!/bin/sh
set -eu

R=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P)
bun=$(command -v bun || true)
if [ -z "$bun" ]; then
  for candidate in "${HOME-}/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -x "$candidate" ]; then
      bun=$candidate
      PATH=${candidate%/*}:$PATH
      export PATH
      break
    fi
  done
fi

if [ -z "$bun" ]; then
  printf '%s\n' 'install.sh: Bun 1.4.0 or newer is required: curl -fsSL https://bun.sh/install | bash' >&2
  exit 1
fi

"$bun" --no-env-file -e 'const required = (await Bun.file(process.argv[1]).json()).engines.bun; if (!Bun.semver.satisfies(Bun.version, required)) { console.error(`install.sh: Bun ${required} required, found ${Bun.version}`); process.exit(1); }' "$R/package.json"

if ! output=$("$bun" install --cwd "$R" --frozen-lockfile --ignore-scripts --production 2>&1); then
  printf '%s\n' "$output" 'install.sh: could not install the dependencies' >&2
  exit 1
fi

exec "$R/skills/playbook/bin/skills" install "$@"
