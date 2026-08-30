#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 6 ]; then
	printf 'usage: log.sh <logfile> <project> <plan> <branch> <evidence> <result>\n' >&2
	exit 1
fi

logfile="$1"
shift

logdir="$(dirname "$logfile")"
if [ -n "$logdir" ] && [ "$logdir" != "." ] && [ ! -d "$logdir" ]; then
	mkdir -p "$logdir"
fi

if [ ! -f "$logfile" ]; then
	printf 'ts\tproject\tplan\tbranch\tevidence\tresult\n' > "$logfile"
fi

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

single_line_and_formula_safe() {
	local v
	v=$(printf '%s' "$1" | tr '\t\n\r' '   ')
	case "$v" in
		=*|+*|-*|@*) printf "'%s" "$v" ;;
		*) printf '%s' "$v" ;;
	esac
}

printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
	"$ts" \
	"$(single_line_and_formula_safe "$1")" \
	"$(single_line_and_formula_safe "$2")" \
	"$(single_line_and_formula_safe "$3")" \
	"$(single_line_and_formula_safe "$4")" \
	"$(single_line_and_formula_safe "$5")" \
	>> "$logfile"
