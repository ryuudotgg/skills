---
packages:
  skills-cli: patch
---

### 🐛 Restack refuses a raced push without promising a rerun

When another push moves the branch while `skills restack-layer --push` is pushing it, the refusal now says origin moved since the rebase began and how to sync or drop the restack, and the rerun hint only follows an origin that could not be read.

### 🧰 Restack pushed line in the verb grammar

The `<branch> is pushed, run skills restack-layer --push to finish the layers above` line a run without `--push` prints is listed in the `restack-layer` grammar that `skills check` validates.
