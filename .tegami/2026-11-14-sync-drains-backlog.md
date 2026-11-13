---
packages:
  skills-cli: patch
---

### 🐛 Long hub syncs drain a big backlog

`skills hub sync` with more backlog than one run can move now stops inside its budget, records the run for `skills hub status`, and exits 75 after a `left` line naming the events, blobs and transcript bytes still to go, so rerunning it while it exits 75 drains the queue. Uploads are no longer cut off mid body, and a blob too large to send in any run stops the sync with a sentence naming its size.
