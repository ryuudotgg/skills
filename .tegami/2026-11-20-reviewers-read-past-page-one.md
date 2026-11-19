---
packages:
  skills-cli: patch
---

### 🐛 Greptile and CodeRabbit see their check past the first page

`skills round` now reads the `Greptile Review` run and the `CodeRabbit` status even when the head carries more than 100 checks, so a pending review waits and Greptile's dashboard threshold still applies.

### 🐛 CodeRabbit stops re-reviewing PRs with over 100 commits

On a PR with more commits than the round can see, CodeRabbit reads its re-review budget as spent, as Macroscope already does.
