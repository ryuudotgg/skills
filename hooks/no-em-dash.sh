#!/bin/bash
# Kill switch: AGENT_HOOKS=0 disables every hook.
[ "${AGENT_HOOKS:-1}" = "0" ] && exit 0
exec python3 "$(cd "$(dirname "$0")" && pwd)/no_em_dash.py"
