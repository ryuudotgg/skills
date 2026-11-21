---
packages:
  skills-cli: patch
---

### 🐛 `skills device android` stops the emulator it gave up on

When the emulator it started never shows up in adb, turns out to run another AVD or never finishes booting, the refusal prints only after that emulator has exited, so the next call finds the AVD unlocked. An emulator that was already running is left alone.
