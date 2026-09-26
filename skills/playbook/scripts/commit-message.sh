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
