---
packages:
  skills-cli: patch
---

### 🐛 A long sync no longer starts a blob it cannot finish after one slow request

`skills hub sync` takes its rate only from uploads that outlast a round trip, so one slow small request no longer makes a short upload look fast and send a blob the link aborts. A shorter upload only lifts a slower saved rate, a blob judged by that alone waits for the next run instead of stopping as too slow, and the calibration resend uses the largest pushed blob up to 1 MiB so it measures the link wherever it can.
