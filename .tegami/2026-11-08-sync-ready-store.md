---
packages:
  skills-cli: patch
---

### 🧰 The plans store can take another device's events

The first open after updating migrates `plans.db`: revision texts move into a `blobs` table, each revision gets a `revision` event, and every view reads events in core's total order, with history, frontier and views unchanged. `applyRemoteEvents` in `packages/cli/src/plans/sync.ts` applies a verified batch of another device's events and blobs, keeps rejected events quarantined, and renders the views they touch the way a local write does.
