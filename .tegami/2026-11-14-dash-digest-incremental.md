---
packages:
  skills-cli: patch
---

### 🎨 Session digests in the dashboard read only what is new

While `skills dash` runs, asking again for a session's digest reads only the lines the transcript gained since the last answer, so a long session no longer gets slower to open each time it grows. A replaced transcript or a change to the checkout's `.env` values still reads the whole file again.
