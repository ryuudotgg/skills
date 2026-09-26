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

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
mode=$(sh "$script_dir/../../playbook/scripts/delivery-mode.sh" 2>/dev/null)
[ "$(printf '%s\n' "$mode" | sed -n '1p')" = prs ] && printf '%s\n' "$mode" | sed '1d' | grep -Fxq greptile \
  || refuse 'greptile is not active in prs mode'

program='
import json
import re
import sys

def refuse(message):
  print(f"resolve: {message}", file=sys.stderr)
  sys.exit(1)

def login(author):
  return (author or {}).get("login") or "ghost"

def greptile(author):
  return re.search("greptile", login(author), re.I) is not None

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
  if not greptile(comments[0]["author"]):
    refuse(f"{url} is in a thread Greptile did not start")

  others = ",".join(sorted({login(comment["author"]) for comment in comments if not greptile(comment["author"])}))
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

plan=$(printf '%s' "$response" | python3 -c "$program" "$number" "$@")

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
