---
packages:
  skills-cli: patch
---

### 🧰 Tests no longer fail on a slow machine's clock

The 28 assertions that compared real elapsed time with a fixed number are gone from the tests under `packages/cli/src`: each now asserts the outcome its deadline produces, or compares two runs it measures itself through `test/scaling.ts`. `test/elapsed-bounds.test.ts` fails when a new one is added outside `read.test.ts`, `read-faults.test.ts` and `hub/sync.test.ts`.
