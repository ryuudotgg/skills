#!/bin/sh
set -u

if [ $# -eq 0 ]; then
  printf '%s\n' 'usage: scripts/spawn-count.sh <command...>' >&2
  exit 2
fi

quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

root=$(mktemp -d "${TMPDIR:-/tmp}/spawn-count.XXXXXX") || exit 2
root=$(CDPATH= cd "$root" && pwd -P) || exit 2
trap 'rm -rf "$root"' EXIT
trap : HUP INT TERM
mkdir "$root/bin"

for name in git bun; do
  : >"$root/$name"
  real=$(command -v "$name") || continue
  case $real in
    /*) ;;
    *) real=$PWD/$real ;;
  esac

  cat >"$root/bin/$name" <<EOF
#!/bin/sh
echo >>$(quote "$root/$name")
exec $(quote "$real") "\$@"
EOF
  chmod +x "$root/bin/$name"
done

PATH=$root/bin:$PATH
export PATH

"$@"
status=$?

for name in git bun; do
  printf '%s %s\n' "$name" "$(($(wc -l <"$root/$name")))"
done

exit "$status"
