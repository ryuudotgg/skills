#!/bin/sh

cr=$(printf '\r')
skill_md=$1
opened=0
closed=0
optional=0
requires=none

if [ ! -r "$skill_md" ]; then
  echo not-extension
  exit 0
fi

while IFS= read -r fm || [ -n "$fm" ]; do
  fm=${fm%"$cr"}

  if [ "$opened" = 0 ]; then
    [ "$fm" = --- ] || break
    opened=1
    continue
  fi

  if [ "$fm" = --- ]; then
    closed=1
    break
  fi

  [ "$fm" = 'optional: true' ] && optional=1

  case $fm in
    *requires*)
      if [ "$fm" = 'requires: prs' ] && [ "$requires" != unknown ]; then
        requires=prs
      else
        requires=unknown
      fi
      ;;
  esac
done < "$skill_md"

if [ "$closed" = 0 ] || [ "$optional" = 0 ]; then
  echo not-extension
  exit 0
fi

echo "requires-$requires"
