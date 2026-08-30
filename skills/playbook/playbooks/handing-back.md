### Handing back

**You own the handover, not the landing. The operator stages, commits, pushes and posts, all of it.** Terminal step for every playbook that would otherwise end in opening a PR.

1. Report what was implemented. One line per change, terse and concrete, each naming its file. Skip anything the diff already says on its own.
2. Name the evidence for each acceptance criterion: the command and its output, the screenshot, the query result. A criterion with no evidence is unmet, so say it is unmet rather than checking its box.
3. Suggest one commit message for the round. Conventional Commits, single line, no body, max 50 characters, describing the actual change. Never "resolve comments", "address review", "fix issues" or "update code". No `Co-Authored-By` trailer and no "Generated with" trailer.
4. Name what is still open: a criterion you could not evidence, a follow-up that deserves its own plan, a risk worth knowing before the commit. Nothing open is one line saying so.
5. Stop. Do not stage, do not commit, do not push, do not open a PR, do not comment on a PR or an issue, do not reply to a review, do not merge. The work stays unstaged on the `feat/*` branch in the main tree, where the operator picks it up.

**Reply:** the change list, the evidence per criterion, the one commit message, and the open items. Close with the plain statement that nothing was staged, committed, pushed or posted.
