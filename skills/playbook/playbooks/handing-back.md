### Handing back

**You own the handover. In hands-off mode the operator stages, commits, pushes and posts, all of it. In prs mode you publish the verified work and stop at the open PR.** Terminal step for every playbook that would otherwise end in opening a PR.

Read `../references/delivery.md` before step 7. The end of `/plans do` still holds this step hands-off in both modes, as that reference states, so under that tail step 7 takes the hands-off branch whatever the mode. Babysit takes its own branch below.

1. **Fan out the tail in one turn.** The last edit has landed, so nothing will move under a reader. One assistant message launches all of it: the review arm or arms your route names, the comment sweep if the route has one, and the project's standing checks, read from its own config rather than assumed (typecheck, lint, and the tests nearest the change). The steps below wait for every one to return. A fix a reviewer or the sweep forces re-runs the standing checks once and stops there.
2. Report what was implemented. One line per change, terse and concrete, each naming its file. Skip anything the diff already says on its own.
3. Name the evidence for each acceptance criterion: the command and its output, the screenshot, the query result. A criterion with no evidence is unmet, so say it is unmet rather than checking its box.
4. Report the standing checks' output. Acceptance says the right thing was built; this says it clears the bar every change clears. Code the operator reviews compiles.
5. Write one commit message for the round. Conventional Commits, single line, no body, max 50 characters, describing the actual change. Never "resolve comments", "address review", "fix issues" or "update code". No `Co-Authored-By` trailer and no "Generated with" trailer.
6. Name what is still open: a criterion you could not evidence, a follow-up that deserves its own plan, a risk worth knowing before the commit. Nothing open is one line saying so.
7. Run `../scripts/delivery-mode.sh` with `sh` and quote its output.
   - **hands-off**, the `/plans do` tail holds this step, a babysit that ran hands-off, or you are a delegate: stop. Do not stage, do not commit, do not push, do not open a PR. The work stays unstaged on the `feat/*` branch in the main tree, where the operator picks it up.
   - **prs, under a babysit that ran prs delivery**: its fix rounds already published, so run neither `publish.sh` nor a push here. Report, per owned branch, the commits pushed, the old and new sha of every rewrite, any commit in `git log origin/<branch>..<branch>` that never reached the remote, and the unpushed follow-up branch if there is one. A fix step 1 forced goes back through a babysit fix round, never through this step. Then stop.
   - **prs**, you own the task, and the arms and standing checks pass: run `../scripts/publish.sh` by its absolute path, never through `sh`, which the commit guard reads as a nested command. Pass `-m` with the message from step 5 and each of the task's files by path, plus `-t` with one Conventional line when the branch already holds other commits since its base. It commits exactly those files, pushes the branch and opens its PR, or its layer of a stack, with no body. It prints every PR URL it opened or reused. Register each URL with the harness's PR linking tool when there is one. A refusal or failure is reported verbatim and stops the step: rerunning after a fix reuses the pushed branch and the open PR. Then stop.

   In both modes: do not comment on a PR or an issue, do not reply to a review, do not merge.

Step 1, why both halves are there. The arms earn their tokens because someone other than the author reads the diff: a Codex arm is a different model, and a Claude arm at least arrives without the lead's reasoning chain in context. Standing in for a missing arm with a re-read of your own is the pass that costs tokens and finds nothing. The cap at one rerun stops the fix, check, review loop from running until the arms fall silent; a second fix round is a new handover, not a longer tail.

**Reply:** the change list, the evidence per criterion, the commit message, and the open items. In hands-off mode close with the plain statement that nothing was staged, committed, pushed or posted. In prs mode close with the commit, the pushed branch and each PR URL, or under babysit with the per branch report from step 7.
