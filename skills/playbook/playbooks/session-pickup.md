### Session pickup

**You own the resume point. Read the prior trail, don't redo it.** For "take over this", "resume this conversation", "continue from <transcript path>", "you're taking over", "pick up where X left off", or a branch you're meant to continue.

A pickup is inheritance. The prior agent already paid the cost of reading the code, running the repros, making the design choices. Redoing loses the bias check and burns context. Resist the urge to re-derive; read.

1. Locate the prior trail. Transcripts live at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, where the encoded cwd is the absolute path with every `/` turned into a hyphen (`/Users/you/Projects/app` becomes `-Users-you-Projects-app`). Resolve the directory from the current cwd and read the specific session file. Do not glob across `~/.claude/projects/*/`, that crosses project boundaries and reads private chats from unrelated work. Do not glob inside the directory either; `memory/` sits in it, so a naive `*` ingests non-transcripts. A paused run instead leaves `.resume-<id>.md` and `.resume-<id>.patch` in the plans directory (default `~/Plans`, override with `PLANS_DIR`) under `<plans>/<Project>/`; read the note first when one exists. Read the metadata overview and last messages first, then scan back for the decision points. Parse a long transcript in a subagent and keep the reduced timeline in the main thread (the **guard-the-context-window** principle skill).
2. Reconstruct operational state. The branch, what already landed (`git log`, `git diff` against the base), what is still unstaged in the tree, the open todos, the decisions made. The prior trail is authoritative input. Resist the bias to re-derive it.
3. Diff done vs pending. Compare what shipped against what was planned, name the resume point, do not re-run the prior repro or redo completed work. A "let me verify from scratch" pass is the tell that you're treating the trail as untrustworthy when it's actually authoritative.
4. Route the remaining work to the matching playbook and pick the verdict: continue the execution, ship a finished recommendation, ratify or override a prior conclusion, or postmortem a failed run. The pickup playbook ends here; the routed playbook owns the rest.
5. Verify the inherited claims against the original goal on the real artifact (the **prove-it-works** principle skill). A passing prior self-report is not the proof.

**Reply:** where the prior agent stopped, what you inherited vs redid (ideally nothing redone), the resume point, and the outcome.
