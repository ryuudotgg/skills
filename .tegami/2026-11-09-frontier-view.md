---
packages:
  skills-cli: minor
---

### ✨ Frontier view in the dashboard

The `/frontier` route of `skills dash` lists each project's ready, blocked, review and doing rows in the order `skills plans frontier` prints them, with blockers in other projects and issues resolved the same way, each project's open issues, and a graph of what blocks what.

### 🧰 Recall test calls closeIssue with a transaction

`packages/cli/src/plans/recall.test.ts` passes a `Tx` to `closeIssue`, so main typechecks again after the recall index and issue links landed together.
