#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)

usage() {
  echo 'usage: publish.sh -m "<message>" [-t "<title>"] <file>...' >&2
  exit 2
}

refuse() {
  printf 'publish: %s\n' "$*" >&2
  exit 1
}

validate_message() {
  cr=$(printf '\r')
  case $1 in
    *'
'*|*"$cr"*) refuse 'multi line message' ;;
  esac

  [ "${#1}" -le 50 ] || refuse 'longer than 50 characters'
  printf '%s\n' "$1" | grep -Eq '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()[:space:]]+\))?!?: [^[:space:]](.*[^[:space:]])?$' \
    || refuse 'no Conventional prefix'
}

message=
title=
has_message=0
has_title=0
while getopts ':m:t:' option; do
  case $option in
    m)
      [ "$has_message" -eq 0 ] || usage
      message=$OPTARG
      has_message=1
      ;;

    t)
      [ "$has_title" -eq 0 ] || usage
      title=$OPTARG
      has_title=1
      ;;

    *) usage ;;
  esac
done

shift "$((OPTIND - 1))"
[ "$has_message" -eq 1 ] && [ "$#" -gt 0 ] || usage
validate_message "$message"
[ "$has_title" -eq 0 ] || validate_message "$title"

mode=$(sh "$script_dir/delivery-mode.sh" 2>/dev/null | sed -n '1p')
[ "$mode" = prs ] || refuse 'delivery mode is not prs'

[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] \
  || refuse 'not inside a work tree'
branch=$(git symbolic-ref --quiet --short HEAD) || refuse 'detached HEAD'
trunk=$(git ls-remote --symref origin HEAD 2>/dev/null \
  | awk '$1 == "ref:" { sub("refs/heads/", "", $2); print $2; exit }')

[ -n "$trunk" ] || refuse 'cannot read the default branch of origin'
[ "$branch" != "$trunk" ] || refuse "cannot publish the default branch $trunk"

staged=$(git diff --cached --no-renames --name-only)
selected=$(git diff --cached --no-renames --name-only -- "$@")
if [ -n "$staged" ]; then
  printf '%s\n' "$staged" | while IFS= read -r path; do
    printf '%s\n' "$selected" | grep -Fxq -- "$path" \
      || refuse "already staged outside the file list: $path"
  done
fi

base=$(git config "branch.$branch.skills-base" || true)
prbase=${base:-origin/$trunk}
prbase=${prbase#origin/}
baseref=$prbase
if [ "$prbase" = "$trunk" ]; then
  baseref=origin/$trunk
fi

for path in "$@"; do
  shift
  if [ -e "$path" ] || git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    set -- "$@" "$path"
  elif printf '%s\n' "$staged" | grep -Fxq -- "$path"; then
    :
  elif [ -z "$(git log --format= --name-only "$baseref..HEAD" -- "$path")" ]; then
    refuse "no such file: $path"
  fi
done

if [ "$#" -gt 0 ]; then
  git add -- "$@" >&2
fi

if git diff --cached --no-renames --quiet; then
  :
else
  status=$?
  [ "$status" -eq 1 ] || refuse 'cannot read staged changes'
  git commit --quiet -m "$message" >&2
  actual=$(git log -1 --format=%B)
  if [ "$actual" != "$message" ]; then
    git reset --quiet --soft HEAD^ >&2
    refuse 'commit message was altered by a hook or template'
  fi
fi

count=$(git rev-list --count "$baseref..HEAD")
[ "$count" -gt 0 ] || refuse "nothing to publish since $baseref"
if [ "$count" -eq 1 ]; then
  title=$(git log -1 --format=%s)
else
  [ "$has_title" -eq 1 ] \
    || refuse "branch has $count commits since $baseref, pass -t with a title covering it"
fi

open_pr() {
  gh pr list --head "$1" --state open --json url --jq '.[0].url // empty' \
    || refuse "gh pr list failed for $1"
}

registered() {
  [ -f "$stack_state" ] || return 1
  escaped=$(printf '%s' "$1" | sed 's/[][\\.^$*]/\\&/g')
  grep -q '"branch"[[:space:]]*:[[:space:]]*"'"$escaped"'"' "$stack_state"
}

url=$(open_pr "$branch")
existing=$url
if gh stack --version >/dev/null 2>&1 && [ "$prbase" != "$trunk" ]; then
  chain=$branch
  parent=$prbase
  while [ "$parent" != "$trunk" ]; do
    case " $chain " in
      *" $parent "*) refuse "cycle in recorded bases at $parent" ;;
    esac

    chain="$parent $chain"
    base=$(git config "branch.$parent.skills-base" || true)
    [ -n "$base" ] || refuse "ancestor $parent has no recorded base"
    parent=${base#origin/}
  done

  for layer in $chain; do
    [ "$layer" = "$branch" ] && continue
    ancestor_url=$(open_pr "$layer")
    [ -n "$ancestor_url" ] || refuse "ancestor $layer has no open PR"
  done

  stack_state=$(git rev-parse --git-dir)/gh-stack
  if registered "$branch"; then
    :
  elif registered "$prbase"; then
    git checkout --quiet "$prbase" >&2
    if ! gh stack add "$branch" >&2; then
      git checkout --quiet "$branch" >&2
      refuse 'gh stack add failed'
    fi

    [ "$(git symbolic-ref --quiet --short HEAD)" = "$branch" ] \
      || refuse "gh stack add did not check out $branch"
  else
    gh stack init --base "$trunk" $chain >&2 || refuse 'gh stack init failed'
  fi

  stack_view=$(gh stack view --json) || refuse 'gh stack view failed'
  layers=$(printf '%s\n' "$stack_view" | sed -n '
    /"branches"[[:space:]]*:/,/^[[:space:]]*]/ {
      s/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p
    }
  ')

  for layer in $layers; do
    if git ls-remote --exit-code --heads origin "$layer" >/dev/null; then
      git fetch --quiet origin "+refs/heads/$layer:refs/remotes/origin/$layer" >&2
      git merge-base --is-ancestor "refs/remotes/origin/$layer" "refs/heads/$layer" \
        || refuse "origin/$layer has commits $layer lacks, rebase before publishing"
    else
      status=$?
      [ "$status" -eq 2 ] || refuse "cannot read origin/$layer"
    fi
  done

  gh stack submit --auto --open >&2 || refuse 'gh stack submit failed'
  url=$(open_pr "$branch")
  [ -n "$url" ] || refuse "gh stack submit opened no PR for $branch"

  clear_body=0
  if [ -z "$existing" ]; then
    clear_body=1
  else
    body=$(gh pr view "$url" --json body --jq .body) || refuse 'gh pr view failed'
    case $body in
      *github.com/github/gh-stack*) clear_body=1 ;;
    esac

    if [ "$clear_body" -eq 0 ]; then
      root=$(git rev-parse --show-toplevel)
      template=
      for file in "$root"/.github/* "$root"/* "$root"/docs/*; do
        [ -f "$file" ] || continue
        printf '%s\n' "${file##*/}" | grep -Eiq '^pull[_-]request[_-]template(\.|$)' \
          || continue

        template=$file
        break
      done

      if [ -n "$template" ]; then
        template_body=$(awk '
          NR == 1 && /^---\r?$/ { front = 1; next }
          front && /^---\r?$/ { front = 0; next }
          !front { text = text $0 "\n" }
          END {
            sub(/^[[:space:]]+/, "", text)
            sub(/[[:space:]]+$/, "", text)
            printf "%s", text
          }
        ' "$template")

        trimmed_body=$(printf '%s' "$body" | awk '
          { text = text $0 "\n" }
          END {
            sub(/^[[:space:]]+/, "", text)
            sub(/[[:space:]]+$/, "", text)
            printf "%s", text
          }
        ')

        [ "$trimmed_body" != "$template_body" ] || clear_body=1
      fi
    fi
  fi

  if [ "$clear_body" -eq 1 ]; then
    gh pr edit "$url" --title "$title" --body "" >&2 || refuse 'gh pr edit failed'
  else
    gh pr edit "$url" --title "$title" >&2 || refuse 'gh pr edit failed'
  fi
else
  git push --quiet -u origin "refs/heads/$branch:refs/heads/$branch" >&2
  if [ -z "$url" ]; then
    created=$(gh pr create --base "$prbase" --head "$branch" --title "$title" --body "") \
      || refuse 'gh pr create failed'

    url=$(printf '%s\n' "$created" | sed -n '$p')
    [ -n "$url" ] || refuse 'gh pr create returned no URL'
  else
    gh pr edit "$url" --title "$title" >&2 || refuse 'gh pr edit failed'
  fi
fi

printf '%s\n' "$url"
