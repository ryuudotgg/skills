#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/plans-frontier.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
project="$tmp/fixture"
tab=$(printf '\t')

mkdir -p "$project"

printf '%s\n' \
  "id${tab}slug${tab}status${tab}pri${tab}effort${tab}blocked_by${tab}ctx${tab}branch${tab}updated${tab}note" \
  "001${tab}ready${tab}TODO${tab}P0${tab}XS${tab}-${tab}-${tab}-${tab}2026-09-26${tab}ready note" \
  "002${tab}released${tab}DONE${tab}P1${tab}S${tab}-${tab}-${tab}-${tab}2026-09-26${tab}-" \
  "003${tab}released-ready${tab}TODO${tab}P1${tab}S${tab}002${tab}-${tab}-${tab}2026-09-26${tab}released note" \
  "010${tab}base-review${tab}REVIEW${tab}P1${tab}M${tab}-${tab}-${tab}feat/base${tab}2026-09-26${tab}-" \
  "011${tab}stacks-base${tab}TODO${tab}P1${tab}S${tab}010${tab}-${tab}-${tab}2026-09-26${tab}-" \
  "012${tab}child-review${tab}REVIEW${tab}P1${tab}M${tab}010${tab}-${tab}feat/child${tab}2026-09-26${tab}-" \
  "013${tab}stacks-child${tab}TODO${tab}P1${tab}S${tab}010,012${tab}-${tab}-${tab}2026-09-26${tab}-" \
  "020${tab}other-review${tab}REVIEW${tab}P1${tab}M${tab}-${tab}-${tab}feat/other${tab}2026-09-26${tab}-" \
  "021${tab}two-stacks${tab}TODO${tab}P1${tab}S${tab}010,020${tab}-${tab}-${tab}2026-09-26${tab}-" \
  "030${tab}waits-todo${tab}TODO${tab}P2${tab}S${tab}031${tab}-${tab}-${tab}2026-09-26${tab}-" \
  "031${tab}todo-blocker${tab}TODO${tab}P2${tab}S${tab}-${tab}-${tab}-${tab}2026-09-26${tab}-" \
  "040${tab}in-progress${tab}DOING${tab}P1${tab}M${tab}-${tab}-${tab}feat/progress${tab}2026-09-26${tab}-" \
  "060${tab}late-ready${tab}TODO${tab}P0${tab}XS${tab}-${tab}-${tab}-${tab}2026-09-26${tab}-" \
  > "$project/index.tsv"

expected='READY 6
001  P0  XS  ready                              ready note
060  P0  XS  late-ready                         -
003  P1  S   released-ready                     released note
011  P1  S   stacks-base                        stacks on 010 (feat/base)
013  P1  S   stacks-child                       stacks on 012 (feat/child)
031  P2  S   todo-blocker                       -

BLOCKED 2
021  P1  two-stacks                         waits on 010,020 (two stacks)
030  P2  waits-todo                         waits on 031

REVIEW 3
010  P1  base-review                        feat/base
012  P1  child-review                       feat/child
020  P1  other-review                       feat/other

DOING 040 in-progress feat/progress'

output=$(PLANS_DIR="$tmp" sh "$script_dir/frontier.sh" fixture)
if [ "$output" != "$expected" ]; then
  echo 'actual output:' >&2
  printf '%s\n' "$output" >&2
  echo 'expected output:' >&2
  printf '%s\n' "$expected" >&2
  exit 1
fi

next=$(PLANS_DIR="$tmp" sh "$script_dir/frontier.sh" --next fixture)
[ "$next" = 001 ] || { echo "next was $next, expected 001" >&2; exit 1; }

stackers=$(PLANS_DIR="$tmp" sh "$script_dir/frontier.sh" --stacks-on 012 fixture)
[ "$stackers" = 013 ] || { echo "stackers were $stackers, expected 013" >&2; exit 1; }

stackers=$(PLANS_DIR="$tmp" sh "$script_dir/frontier.sh" --stacks-on 010 fixture)
[ "$stackers" = 011 ] || { echo "stackers were $stackers, expected 011" >&2; exit 1; }

stackers=$(PLANS_DIR="$tmp" sh "$script_dir/frontier.sh" --stacks-on 020 fixture)
[ -z "$stackers" ] || { echo "stackers were $stackers, expected empty" >&2; exit 1; }

if output=$(PLANS_DIR="$tmp" sh "$script_dir/frontier.sh" --next missing 2>"$tmp/stderr"); then
  echo 'next succeeded for a missing project' >&2
  exit 1
else
  status=$?
fi

[ "$status" -eq 1 ] || { echo "next exited $status, expected 1" >&2; exit 1; }
[ -z "$output" ] || { echo 'next wrote to stdout for a missing project' >&2; exit 1; }

echo ok
