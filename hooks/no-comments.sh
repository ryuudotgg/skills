#!/bin/bash
[ "${AGENT_HOOKS:-1}" = "0" ] && exit 0
exec python3 -B "$(cd "$(dirname "$0")" && pwd)/no_comments.py"
