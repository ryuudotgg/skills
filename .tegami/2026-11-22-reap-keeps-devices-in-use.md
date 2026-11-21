---
packages:
  skills-cli: patch
---

### 🐛 `skills reap` keeps a device that is in use

`skills reap` holds a simulator's or AVD's device lock from its stop through its delete, so it keeps one a `skills device` call is using, and it keeps an AVD an emulator started on after the listing.

### 🐛 `skills reap --mine` leaves a row that moved to another branch alone

`skills reap --mine` works out the checkout's owners again before each stop and each delete, so a row that left the branch after the listing keeps its devices and servers.
