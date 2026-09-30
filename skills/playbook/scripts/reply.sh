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
! grep -Eiq '(^|[^[:alnum:]_])plans?[[:space:]]+#?[0-9]+([^[:alnum:]_]|$)' "$body" \
  || refuse 'the reply body names a plan id, which exists only on this machine'

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)

installed_names=$(sh "$script_dir/reviewers.sh" NAME) || refuse 'cannot read reviewer declarations'
installed_handles=$(sh "$script_dir/reviewers.sh" HANDLES) || refuse 'cannot read reviewer declarations'
active_logins=$(sh "$script_dir/reviewers.sh" --active LOGINS) || refuse 'cannot read reviewer declarations'
active_names=$(sh "$script_dir/reviewers.sh" --active NAME) || refuse 'cannot read reviewer declarations'
tab=$(printf '\t')

set -f
while IFS="$tab" read -r name handles; do
  [ -n "$name" ] || continue
  display=$(printf '%s\n' "$installed_names" | awk -F '\t' -v name="$name" '$1 == name { print substr($0, index($0, "\t") + 1) }')
  for handle in $handles; do
    ! grep -Fqi -e "$handle" "$body" || refuse "the reply body mentions $handle, which summons $display and may cost a review"
  done
done <<EOF
$installed_handles
EOF
set +f

if [ -z "$active_names" ]; then
  [ -n "$installed_names" ] || refuse 'no reviewer is installed'

  while IFS="$tab" read -r name _; do
    printf 'reply: %s is not active in prs mode\n' "$name" >&2
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
  print(f"reply: {message}", file=sys.stderr)
  sys.exit(1)

logins = set(sys.argv[1].lower().split())
names = sys.argv[2]
del sys.argv[1:3]

def reviewer(author):
  return author is not None and (author.get("login") or "ghost").lower() in logins

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
if not comments or not reviewer(comments[0]["author"]) or not all(reviewer(comment["author"]) for comment in comments):
  refuse(f"{url} is not in a thread only {names} has written in")

print(thread["id"])
'

response=$(gh api graphql -F 'owner={owner}' -F 'repo={repo}' -F "number=$number" -F "query=@$script_dir/threads.graphql") \
  || refuse 'gh failed reading review threads'

id=$(printf '%s' "$response" | python3 -c "$program" "$logins" "$names" "$number" "$url")

posted=$(gh api graphql -F "query=@$script_dir/reply.graphql" -f "id=$id" -F "body=@$body" --jq .data.addPullRequestReviewThreadReply.comment.url < /dev/null) \
  || refuse "gh failed replying to $url"

[ -n "$posted" ] || refuse "the reply to $url did not post"
echo "replied $posted"

state=$(gh api graphql -F "query=@$script_dir/resolve.graphql" -f "id=$id" --jq .data.resolveReviewThread.thread.isResolved < /dev/null) \
  || refuse "gh failed resolving $url"

[ "$state" = true ] || refuse "$url did not resolve"
echo "resolved $url"
