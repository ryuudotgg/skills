---
name: fixture-effort
description: Codex effort pin fixture.
---

```
codex exec -m model-b -c model_reasoning_effort=medium -s read-only -C /tmp
codex exec -m model-b -c model_reasoning_effort=high -s read-only -C /tmp
codex exec -m model-b -c model_reasoning_effort=low -s read-only -C /tmp
codex exec -m model-a -c model_reasoning_effort=high -s read-only -C /tmp
```
