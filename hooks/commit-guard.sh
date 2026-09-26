#!/bin/bash
exec python3 -B "$(cd "$(dirname "$0")" && pwd)/commit_guard.py"
