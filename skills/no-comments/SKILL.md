---
name: no-comments
description: "Spawn comment-sicko, fix accepted findings, and offer encodings for claimed constraints."
disable-model-invocation: true
---

# No comments

Spawn `comment-sicko`. Act on accepted findings.

Authoring agents defend comments. Defer to `comment-sicko`'s fresh perspective.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the repo's base branch, read from `git symbolic-ref refs/remotes/origin/HEAD` rather than assumed, including staged, unstaged, and untracked work in the tree.

## Steps

1. Spawn `Task` with `subagent_type: "comment-sicko"`. Agent names cannot contain spaces here, so the name is the slug. Pass the scope. Do not restate its rules.
2. Inspect its report and diff. Reject application-code edits, scope escapes, exception-protected deletions, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. Reshape flags on our-code surprises stay actionable. Do not restore those comments. A keep survives only with proof it is about something we cannot change. Audit missed scoped lint and TypeScript suppressions. Correctness or safety suppressions stay actionable `MUST KILL`s. Restore deletions only with exact exceptions and scoped proof. Before accepting thin `IMPORTANT` or `do not remove` kills or keeps, run `/how` on their symbol and read its git history. If a kill is ambiguous, do not restore. If a keep is refuted or still ambiguous, delete it. Revert and rerun one rejected report with the failure named. Reject a second, report it open, and fail `/no-comments`.
3. Fix trivial accepted flags directly by deleting a dead path, dropping a parameter, or using the real API. If any fix needs a shape, run `/architect` once for the accepted set and surrounding code. Stop at the sketch. Architect shapes. Step 4 implements.
4. Implement the smallest root-cause fix in scope. Remove every named workaround. If the root cause is out of scope, land the smallest in-scope fix and report the rest open. The **fix-root-causes** and **redesign-from-first-principles** principle skills guide intent only: fix real causes, redesign as if requirements always existed, never bolt on symptom guards. Neither authorizes widening the fence nor fixing instances outside it.
5. Constraint comments say `do not remove`, `do not change wording`, or `talk to X before changing`. Leave keeps about things we cannot change. Offer the cheapest in-scope type, runtime, test, or CI lint. Wait for interactive approval. Unattended and eval require caller pre-approval. If approved, encode then delete. Otherwise delete, report the constraint open, and sketch out-of-scope work.
6. Report the deletion count, restored comments, reruns, architect sketch, fixes, encoding offers, encodings, unenforced constraints, and other open work. Leave every edit unstaged on the `feat/*` branch in the main tree. Do not stage, do not commit, do not push, and do not post the report or any edit to a remote. Suggest one commit message: conventional, single line, no body, at most 50 characters, no trailers.
