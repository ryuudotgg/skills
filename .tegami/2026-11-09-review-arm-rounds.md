---
packages:
  skills-cli: patch
---

### 🎨 The review arm checks the fixes its findings forced

When a review arm finding forces a behaviour fix before handback, the review arm reads that fix against a ledger of its earlier findings, up to three passes in all counting the first, or five on critical work or an open security, auth, data or concurrency finding, and whatever is still open or disputed goes to the handback's open items.
