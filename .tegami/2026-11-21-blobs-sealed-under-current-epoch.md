---
packages:
  skills-cli: patch
  skills-hub: patch
---

### 🐛 Blobs uploaded after a revocation are sealed under the new epoch

When a device is revoked while another machine is mid sync, the hub now refuses a new blob sealed under the old epoch, and the syncing machine reads the membership again and sends that blob once more under the current one. A CLI older than this release fails that one sync and succeeds on the next.
