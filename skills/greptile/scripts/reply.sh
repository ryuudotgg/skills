#!/bin/sh
set -eu

usage() {
  echo 'usage: reply.sh <pr> <inline comment url> <body file>' >&2
  exit 2
}

refuse() {
  printf 'reply: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 3 ] || usage
case $1 in
  *[!0-9]*|'') usage ;;
esac

number=$1
url=$2
body=$3
case $url in
  https://*/pull/"$number"#discussion_r*) ;;
  *) usage ;;
esac

case ${url##*#discussion_r} in
  *[!0-9]*|'') usage ;;
esac

[ -f "$body" ] && [ -r "$body" ] || usage
grep -q '[^[:space:]]' "$body" || refuse 'the reply body is empty'
! grep -qi '@greptile' "$body" || refuse 'the reply body mentions @greptile, which requests a paid review'

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
mode=$(sh "$script_dir/../../playbook/scripts/delivery-mode.sh" 2>/dev/null)
[ "$(printf '%s\n' "$mode" | sed -n '1p')" = prs ] && printf '%s\n' "$mode" | sed '1d' | grep -Fxq greptile \
  || refuse 'greptile is not active in prs mode'

program='
import json
import re
import sys

def refuse(message):
  print(f"reply: {message}", file=sys.stderr)
  sys.exit(1)

def greptile(author):
  return re.search("greptile", (author or {}).get("login") or "ghost", re.I) is not None

try:
  threads = json.load(sys.stdin)["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
  by_url = {comment["url"]: thread for thread in threads for comment in thread["comments"]["nodes"]}
except (KeyError, TypeError, ValueError):
  refuse("cannot read review threads")

url = sys.argv[2]
thread = by_url.get(url)
if thread is None:
  refuse(f"{url} is not in a review thread on PR {sys.argv[1]}")

if thread["isResolved"]:
  refuse(f"{url} is in a resolved thread")

comments = thread["comments"]["nodes"]
if not all(greptile(comment["author"]) for comment in comments):
  refuse(f"{url} is not in a thread only Greptile has written in")

print(thread["id"])
'

response=$(gh api graphql -F 'owner={owner}' -F 'repo={repo}' -F "number=$number" -F "query=@$script_dir/threads.graphql") \
  || refuse 'gh failed reading review threads'

id=$(printf '%s' "$response" | python3 -c "$program" "$number" "$url")

posted=$(gh api graphql -F "query=@$script_dir/reply.graphql" -f "id=$id" -F "body=@$body" --jq .data.addPullRequestReviewThreadReply.comment.url < /dev/null) \
  || refuse "gh failed replying to $url"

[ -n "$posted" ] || refuse "the reply to $url did not post"
echo "replied $posted"

state=$(gh api graphql -F "query=@$script_dir/resolve.graphql" -f "id=$id" --jq .data.resolveReviewThread.thread.isResolved < /dev/null) \
  || refuse "gh failed resolving $url"

[ "$state" = true ] || refuse "$url did not resolve"
echo "resolved $url"
