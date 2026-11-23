---
packages:
  skills-cli: patch
---

### 🧰 Drop the plans readers only tests called

The tolerant index and trail file readers are gone, with their tests moved onto `parseIndexText`, `parseTrailText` and `decodeUtf8`. `Recorded` in record.ts lists the seven events `recordEvent` accepts, so a new store event no longer needs an edit there.
