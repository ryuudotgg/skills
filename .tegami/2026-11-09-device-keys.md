---
packages:
  skills-cli: patch
---

### 🧰 Keep hub device keys in the keychain or a private file

`packages/cli/src/hub/keys.ts` creates, reads and deletes a device's signing and wrapping keys: in the macOS login keychain through `security -i`, or under `~/.agents/hub/<device id>/` with `HUB_KEYS=file` and on other platforms. Nothing calls it yet: enrollment builds on it.
