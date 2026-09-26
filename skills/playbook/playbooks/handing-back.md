### Handing back

**You own the handover, not the landing. The operator stages, commits, pushes and posts, all of it.** Terminal step for every playbook that would otherwise end in opening a PR.

This step stays hands-off in both modes, as `../references/delivery.md` states for the four delivery tails.

1. **Fan out the tail in one turn.** The last edit has landed, so nothing will move under a reader. One assistant message launches all of it: the review arm or arms your route names, the comment sweep if the route has one, and the project's standing checks, read from its own config rather than assumed (typecheck, lint, and the tests nearest the change). The steps below wait for every one to return. A fix a reviewer or the sweep forces re-runs the standing checks once and stops there.
2. Report what was implemented. One line per change, terse and concrete, each naming its file. Skip anything the diff already says on its own.
3. Name the evidence for each acceptance criterion: the command and its output, the screenshot, the query result. A criterion with no evidence is unmet, so say it is unmet rather than checking its box.
4. Report the standing checks' output. Acceptance says the right thing was built; this says it clears the bar every change clears. Code the operator reviews compiles.
5. Suggest one commit message for the round. Conventional Commits, single line, no body, max 50 characters, describing the actual change. Never "resolve comments", "address review", "fix issues" or "update code". No `Co-Authored-By` trailer and no "Generated with" trailer.
6. Name what is still open: a criterion you could not evidence, a follow-up that deserves its own plan, a risk worth knowing before the commit. Nothing open is one line saying so.
7. Stop. Do not stage, do not commit, do not push, do not open a PR, do not comment on a PR or an issue, do not reply to a review, do not merge. The work stays unstaged on the `feat/*` branch in the main tree, where the operator picks it up.

Step 1, why both halves are there. The arms earn their tokens because someone other than the author reads the diff: a Codex arm is a different model, and a Claude arm at least arrives without the lead's reasoning chain in context. Standing in for a missing arm with a re-read of your own is the pass that costs tokens and finds nothing. The cap at one rerun stops the fix, check, review loop from running until the arms fall silent; a second fix round is a new handover, not a longer tail.

**Reply:** the change list, the evidence per criterion, the one commit message, and the open items. Close with the plain statement that nothing was staged, committed, pushed or posted.
