### Feature

**You own the design. Plan, review, verify.** Delegate implementation; stay in the lead.

**Where it lands is a blocking question, never a default.** Which surface, which tab, public or private, who can see it. If the request does not name exactly one destination, stop and ask before writing code. Do not infer it from the nearest plausible directory, and do not settle it with a prototype. This overrides the **never-block-on-the-human** principle skill by name; that principle covers reversible work, and a feature landing on the wrong surface is a disclosure, not a revert.

1. `how` over the affected subsystem.
2. `architect` for parallel design exploration. Skipping stays as `architect skipped: <reason>`; do not fold the design decision silently into implementation.
3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
   - **Blocking first steps.** Gates run before fan-out.
   - **Independent workstreams.** Disjoint files, services, or layers parallelize. Shared writes serialize.
   - **Shared mutable state.** Default to splitting the target (the **separate-before-serializing-shared-state** principle skill). Serialize only for real invariants.
   - **Smallest safe decomposition.** If one worker is best, name why.
4. Delegate code-writing to the `codex-terra` wrapper agent, which shells out to the Codex CLI (`codex exec --enable fast_mode -m gpt-5.6-terra -C <abs repo path> -o /tmp/codex/<slug>.md`), with a specific scope: file paths, the named data shape and its organizing structure per the **model-the-domain** principle skill (a state machine over scattered booleans, a table or registry over branching, a typed model over repeated shape assumptions, chosen before the delegate writes logic), and success criteria. Review its diff yourself. Tier by difficulty: `codex-luna` for trivial mechanical edits, `codex-terra` by default, `codex-astra` for a hard change you can specify to the letter, `fable-max` or `opus-xhigh` when the intent is vague or the call is a judgment one. Never pass an `isolation` parameter to a subagent; every value of it produces a worktree, and worktrees are banned. When the implementation admits multiple valid shapes (error handling, abstraction layer, test structure), run the **architect** skill instead so its candidate arms surface the alternatives and the synthesis guards the pick. Mandatory: no skip-with-reason escape, and Laziness Protocol does not override it (the gain is review separation, not lines saved). You can spawn a subagent even though you are one; "the app is small" and "a subagent cannot spawn one" are both wrong. A subagent forbidden to spawn satisfies this by owning the diff directly with the same review separation; no "standing by" reply that waits on a nested agent. Comments per **Comments**. Surgical edits, re-ground against the source for upstream-derived files. Port shared-primitive improvements to all consumers and verify each.
5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass; flag it.
6. Sequence the work into small verifiable units, building and verifying each before starting the next (**sequence-verifiable-units**). The whole change stays unstaged on one `feat/*` branch in the main tree. You never commit, never push, never stack.
7. If the design is contested, `interrogate` before shipping.
8. Run `handing-back.md`.

Code-coupled work (one feature, one migration) goes to a single owner with the checkpoint inline; that owner fans out internally after the blocking phase. Parent-level fan-out is for slices that produce independent artifacts (audits, cross-subsystem investigations, competing experiments). Rewrite the checkpoint at phase boundaries; spawn a fresh owner rather than chaining interrupts.

**Reply:** what you built, what you chose and why, open decisions. Tables for design alternatives.
