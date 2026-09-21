### Pause safely

**You own a clean stop. Leave a checkpoint a cold-start agent can resume from.** An explicit stop is "pause safely", "I need to go offline", "restart Claude Code", or "board my flight". Run the whole playbook, then stand down. A checkpoint because automatic compaction is near leaves the same patch and note, then the run continues, so nothing stands down. On "keep going", "going to bed, keep going", or "don't stop", do not pause. Those mean continue; a long run's checkpoint is the **show-me-your-work** trail, one row per iteration.

1. Stop at a safe boundary. Finish the current atomic step or back out of it. Never stop mid-edit in a known-broken state. For an explicit stop, start nothing new and cancel any nested subagents. A compaction checkpoint does not end the run, so nested subagents keep running.
2. Don't cross an irreversible line to pause. No commit, no push, no PR, no comment posted anywhere. The tree is the operator's to review.
3. Make the work durable without touching the tree. Write a patch of the tracked edits to `<plans>/<Project>/.resume-<id>.patch` with `git diff HEAD > "${PLANS_DIR:-$HOME/Plans}/<Project>/.resume-<id>.patch"`, where `<plans>` is the plans directory (default `~/Plans`, override with `PLANS_DIR`), and record untracked files with `git status --porcelain` into the resume note so nothing new is invisible on pickup. Leave the working tree exactly as it is, unstaged, on its `feat/*` branch. Never commit, and never a `wip:` commit. If the tree is broken, say so in one line in the resume note.
4. Write the resume note off-context to `<plans>/<Project>/.resume-<id>.md`, beside the patch. Not `/tmp`, which is purged before the operator gets back. Capture intent, what you were doing, progress and what's verified, current state, next steps, key files, and gotchas, plus the patch path and the untracked-file list. Three more lines, one each, carry what dies with the transcript:
   - The operator's constraints, quoted in their own words, because a paraphrase drops the binding half.
   - Alternatives rejected and the reason each lost, so the resumer does not re-propose them.
   - Promises made and not yet delivered.

   The in-context plan does not survive summarization, so the note is the only carrier. If a show-me-your-work trail exists, point at it instead of duplicating it.

**Reply:** where you are in the loop, what's on disk versus still in your head (paths, no diff dumps), the patch and note paths, that the tree is untouched and uncommitted, and the first action on resume. This is a pause, not a final report. Resume is the Session pickup playbook reading this note.
