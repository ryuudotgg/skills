---
packages:
  skills-cli: patch
---

### 🐛 Plans views with bytes that are not UTF-8 refuse cleanly

An `index.tsv` or `log.tsv` holding bytes that are not valid UTF-8 now gets the usual `changed outside the store` or `is not in the store yet` sentence from every plans writer and checked read, where it used to crash with an encoding error. Such a view left pending by another project no longer blocks a write elsewhere.
