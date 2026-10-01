---
name: fixture-hooks
description: Codex hooks prefix fixture.
---

```
AGENT_HOOKS=0 codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s read-only -C /tmp
codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s read-only -C /tmp
codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s workspace-write -C /tmp
AGENT_HOOKS=0 codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s workspace-write -C /tmp
AGENT_HOOKS=0 \
  codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s read-only -C /tmp
codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s read-only -C /tmp # AGENT_HOOKS=0 codex
AGENT_HOOKS=0 \
  codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s workspace-write -C /tmp
codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -C /tmp
AGENT_HOOKS=0 codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s read-only -C /tmp; AGENT_HOOKS=0 codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s workspace-write -C /tmp && codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s read-only -C /tmp
AGENT_HOOKS=0 codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s workspace-write -C '/tmp/a;b'
AGENT_HOOKS=0 codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s workspace-write -C '/tmp/a&&b'; codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s read-only -C /tmp
```
