---
packages:
  skills-cli: patch
---

### 🐛 Agents find transcripts for dotted paths

The playbook agent, Session pickup and `show-me-your-work` now say every character other than an ASCII letter or digit becomes `-` in a transcript directory name, so a checkout like `/Users/you/.t3/worktrees/app` resolves to the right folder.

### 🐛 Playbook agent knows the plans store

The playbook agent now lists the `REVIEW` status, names `plans.db` as the store and treats `log.tsv` and `index.tsv` as views, changing rows only through the `skills plans` verbs.
