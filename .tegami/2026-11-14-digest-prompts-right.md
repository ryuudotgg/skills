---
packages:
  skills-cli: patch
---

### 🐛 Session digests list only the prompts you sent

`skills sessions show --digest` now counts a Claude prompt sent with an image as a prompt, and no longer lists task notifications or the AGENTS.md and environment blocks Codex injects as prompts. Digests already stored keep their old turns until their series restarts.
