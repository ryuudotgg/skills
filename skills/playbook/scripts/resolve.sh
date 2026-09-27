#!/bin/sh
set -eu

usage() {
  echo 'usage: resolve.sh <pr> <inline comment url>...' >&2
  exit 2
}

refuse() {
  printf 'resolve: %s\n' "$*" >&2
  exit 1
}

[ "$#" -ge 2 ] || usage
case $1 in
  *[!0-9]*|'') usage ;;
esac

number=$1
shift
for url in "$@"; do
  case $url in
    https://*/pull/"$number"#discussion_r*) ;;
    *) usage ;;
  esac

  case ${url##*#discussion_r} in
    *[!0-9]*|'') usage ;;
  esac
done

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)

installed_names=$(sh "$script_dir/reviewers.sh" NAME) || refuse 'cannot read reviewer declarations'
active_logins=$(sh "$script_dir/reviewers.sh" --active LOGINS) || refuse 'cannot read reviewer declarations'
active_names=$(sh "$script_dir/reviewers.sh" --active NAME) || refuse 'cannot read reviewer declarations'
tab=$(printf '\t')

if [ -z "$active_names" ]; then
  [ -n "$installed_names" ] || refuse 'no reviewer is installed'

  while IFS="$tab" read -r name _; do
    printf 'resolve: %s is not active in prs mode\n' "$name" >&2
  done <<EOF
$installed_names
EOF

  exit 1
fi

names=$(printf '%s\n' "$active_names" | cut -f 2- | python3 -c 'import sys; print(" or ".join(sys.stdin.read().splitlines()))')
logins=$(printf '%s\n' "$active_logins" | cut -f 2-)

program='
import json
import sys

def refuse(message):
  print(f"resolve: {message}", file=sys.stderr)
  sys.exit(1)

def login(author):
  return (author or {}).get("login") or "ghost"

logins = set(sys.argv[1].lower().split())
names = sys.argv[2]
del sys.argv[1:3]

def reviewer(author):
  return login(author).lower() in logins

try:
  threads = json.load(sys.stdin)["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
  by_url = {comment["url"]: thread for thread in threads for comment in thread["comments"]["nodes"]}
except (KeyError, TypeError, ValueError):
  refuse("cannot read review threads")

plan = []
for url in sys.argv[2:]:
  thread = by_url.get(url)
  if thread is None:
    refuse(f"{url} is not in a review thread on PR {sys.argv[1]}")

  comments = thread["comments"]["nodes"]
  if not reviewer(comments[0]["author"]):
    refuse(f"{url} is in a thread {names} did not start")

  others = ",".join(sorted({login(comment["author"]) for comment in comments if not reviewer(comment["author"])}))
  if thread["isResolved"]:
    plan.append(f"already-resolved - {url}")
  elif others:
    plan.append(f"left-open - {url} reply-from={others}")
  else:
    plan.append(" ".join(("resolve", thread["id"], url)))

print("\n".join(plan))
'

response=$(gh api graphql -F 'owner={owner}' -F 'repo={repo}' -F "number=$number" -F "query=@$script_dir/threads.graphql") \
  || refuse 'gh failed reading review threads'

plan=$(printf '%s' "$response" | python3 -c "$program" "$logins" "$names" "$number" "$@")

resolved=' '
while read -r action id url detail; do
  case $action in
    resolve)
      case $resolved in
        *" $id "*) ;;
        *)
          state=$(gh api graphql -F "query=@$script_dir/resolve.graphql" -f "id=$id" --jq .data.resolveReviewThread.thread.isResolved < /dev/null) \
            || refuse "gh failed resolving $url"

          [ "$state" = true ] || refuse "$url did not resolve"
          resolved="$resolved$id "
          ;;
      esac

      echo "resolved $url"
      ;;

    *) printf '%s %s%s\n' "$action" "$url" "${detail:+ $detail}" ;;
  esac
done <<EOF
$plan
EOF
