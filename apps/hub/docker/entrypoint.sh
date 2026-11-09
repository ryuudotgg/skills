#!/bin/sh
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

if [ -z "${LITESTREAM_REPLICA_URL:-}" ]; then
  exec bun /app/hub.js
fi

case "$LITESTREAM_REPLICA_URL" in
  s3://*)
    if [ -z "${LITESTREAM_ACCESS_KEY_ID:-}" ] || [ -z "${LITESTREAM_SECRET_ACCESS_KEY:-}" ]; then
      echo "LITESTREAM_REPLICA_URL is set without LITESTREAM_ACCESS_KEY_ID and LITESTREAM_SECRET_ACCESS_KEY" >&2
      exit 1
    fi
    ;;
  file://*) ;;
  *)
    echo "LITESTREAM_REPLICA_URL must be an s3:// or file:// URL" >&2
    exit 1
    ;;
esac

db="${HUB_DATA}/hub.db"
staged="${HUB_DATA}/hub.db.restoring"

if [ ! -e "$db" ]; then
  echo "restoring $db from the replica"
  rm -f "$staged"
  timeout "${LITESTREAM_RESTORE_TIMEOUT:-300}" litestream restore -if-replica-exists -o "$staged" "$db"

  if [ -e "$staged" ]; then
    touch "${HUB_DATA}/.restored"
    mv "$staged" "$db"
    echo "restored $db"
  else
    echo "no replica yet, starting empty"
  fi
fi

exec litestream replicate -exec "bun /app/hub.js"
