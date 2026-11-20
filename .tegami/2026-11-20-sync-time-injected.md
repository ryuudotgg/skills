---
packages:
  skills-cli: patch
---

### 🧰 Hub sync reads one injected clock

The sync Budget, the hub client's deadlines and request timeouts, the file walk, file landing, session scan and chunker read time through the clock and timeout factory `Deps` carries, so a test can run a Budget out or time a request out without waiting.
