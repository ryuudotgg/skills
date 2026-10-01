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

exec "$R/skills/playbook/bin/skills" install "$@"
