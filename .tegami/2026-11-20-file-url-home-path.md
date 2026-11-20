---
packages:
  skills-cli: patch
---

### 🐛 Outgoing text check refuses file URLs to a home path

`skills review reply` and `skills publish` now refuse a body holding a `file:` URL whose decoded path is a home path, and judge a plan id the way the drafted reply guard does, ignoring `http` and `https` URLs and counting any decimal digits.
