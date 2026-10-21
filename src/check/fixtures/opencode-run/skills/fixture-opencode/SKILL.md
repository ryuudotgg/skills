---
name: fixture-opencode
description: OpenCode invocation pin fixture.
---

```
OPENCODE_CONFIG_CONTENT="$(cat /tmp/p.json)" opencode run --standalone --auto --format json -m provider/model#high
OPENCODE_CONFIG_CONTENT="$(cat /tmp/p.json)" opencode run --standalone --auto --format json -m provider/model --variant high
OPENCODE_CONFIG_CONTENT="$(cat /tmp/p.json)" opencode run --standalone --auto --format json -m provider/model
OPENCODE_CONFIG_CONTENT="$(cat /tmp/p.json)" opencode run --standalone --auto --format json
opencode run --standalone --auto -m provider/model#high
OPENCODE_CONFIG_CONTENT="$(cat /tmp/p.json)" opencode run --auto --model=provider/model#high
OPENCODE_CONFIG_CONTENT="$(cat /tmp/p.json)" opencode run --standalone -m provider/model#high
OPENCODE_CONFIG_CONTENT="$(cat /tmp/p.json)" opencode run --standalone --auto \
  -m provider/model#high
OPENCODE_CONFIG_CONTENT="$(cat /tmp/p.json)" \
  perl -e 'alarm shift; exec @ARGV' 60 opencode run --standalone --auto -m provider/model#high
opencode run > /tmp/out <<'PROMPT'
OPENCODE_CONFIG_CONTENT='{}' true && opencode run --standalone --auto -m provider/model#high
OPENCODE_CONFIG_CONTENT="$(cat /tmp/p.json)" opencode run -- --standalone --auto -m provider/model#high
OPENCODE_CONFIG_CONTENT="$(cat /tmp/p.json)" opencode run --standalone --auto -m provider/model#
```

Use `opencode run` to start an invocation.
