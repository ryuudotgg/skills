#!/bin/sh
set -eu

usage() {
  echo 'usage: review-read.sh <pr number>' >&2
  exit 2
}

refuse() {
  printf 'review-read: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 1 ] || usage
case $1 in
  *[!0-9]*|'') usage ;;
esac

number=$1
inline=$(gh api "repos/{owner}/{repo}/pulls/$number/comments" --paginate --jq '.[] | "### \(.path):\(.line // .original_line // "file") by \(.user.login)\n\(.html_url)\n\(.body)\n"') \
  || refuse 'gh failed reading inline comments'
body=$(gh pr view "$number" --json body --jq .body) || refuse 'gh failed reading PR body'
reviews=$(gh pr view "$number" --json reviews --jq '.reviews[] | select(.body != "") | "### review by \(.author.login), \(.state)\n\(.body)\n"') \
  || refuse 'gh failed reading reviews'
comments=$(gh pr view "$number" --json comments --jq '.comments[] | "### comment by \(.author.login)\n\(.url)\n\(.body)\n"') \
  || refuse 'gh failed reading PR comments'

print_section() {
  printf '== %s\n' "$1"
  if printf '%s' "$2" | grep -q '[^[:space:]]'; then
    printf '%s\n' "$2"
  else
    echo empty
  fi
}

source_text() {
  case $1 in
    'PR body') printf '%s\n' "$body" ;;
    reviews) printf '%s\n' "$reviews" ;;
    *) printf '%s\n' "$comments" ;;
  esac
}

outside_sources=
for source in 'PR body' reviews 'PR comments'; do
  source_text "$source" | grep -iq 'Comments Outside Diff' || continue
  outside_sources=${outside_sources:+$outside_sources, }$source
done

print_section 'inline comments' "$inline"
print_section 'PR body' "$body"
print_section reviews "$reviews"
print_section 'PR comments' "$comments"
printf '== comments outside diff\n'
if [ -z "$outside_sources" ]; then
  echo empty
else
  printf 'found in: %s\n' "$outside_sources"
  for source in 'PR body' reviews 'PR comments'; do
    source_text "$source" | awk 'tolower($0) ~ /comments[[:space:]]outside[[:space:]]diff/ { found = 1 } found'
  done
fi
