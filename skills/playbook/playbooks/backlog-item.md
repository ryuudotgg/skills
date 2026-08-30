### Backlog item

**You own the outcome the plan names, not the plan's prose. Gate, probe, route, verify, hand back.** Runs for `/plans do <id>`. The plan lives in the plans directory (default `~/Plans`, override with `PLANS_DIR`) at `<plans>/<Project>/NNN-slug.md`, and carries intent only. Current state is re-derived here at execution time, never read off the plan.

0. **Destination gate.** Before the probe, before opening a source file. Read the plan `## Outcome`. If it does not name exactly one destination surface, or if public versus private visibility is inferable from more than one place, stop and ask the operator. This is the one place that overrides the **never-block-on-the-human** principle skill, and it overrides it by name. The failure this gate exists for: a plan named a tab, a directory of the same name sat on disk holding the private version of that view, and the guess shipped a private breakdown onto the public page. The guess was the failure, not the plan. A prototype cannot settle a destination question, and neither can the nearest matching folder.
1. **Probe.** Run every command in the plan `## Probe` block verbatim, before reading anything else. Then state the current state in your own words. Three outcomes, all safe:
   - **(a) Every `## Acceptance` criterion already holds.** Mark the boxes, set the `<plans>/<Project>/index.tsv` row to DONE with a note capped at 100 chars, stop. Do not implement.
   - **(b) Criteria unmet.** Continue to step 2.
   - **(c) A probe returns nothing recognizable.** The subsystem moved. Stop and report what the probe expected and what it found.
   Outcome (c) is the only stop condition in this playbook. It fires on the subsystem having moved, never on a file having changed. A sibling plan in the same batch landing ahead of you changes files and is expected; that is not a stop. That inversion is what lets the plans in one batch survive each other.
2. **Route.** Match the item shape to Bug fix, Feature, Refactoring, Perf issue, Investigation or Prototype and copy that playbook's steps into the todolist verbatim, after the items above. Its terminal step, opening a PR, is replaced by `handing-back.md`.
3. **Throughput checkpoint.** The four items from Feature step 3 (blocking first steps, independent workstreams, shared mutable state, smallest safe decomposition), or the single line `throughput checkpoint: n/a, <reason>` when the item is read-only or single-file.
4. **Constrain.** Read the sections the plan `## Constraints` names from the project instructions file (`AGENTS.md` or `CLAUDE.md`). Follow them. Do not restate them into the todolist.
5. **Verify.** Each `## Acceptance` box gets its own evidence: a command and its output, a screenshot, a query result. Check a box only once its evidence exists. Evidence sits at rung 4 or rung 5 of the blast-radius ladder (you ran the real code, or you reproduced it in the running app), never rung 2 (you pointed at a line).
6. **Hand back.** Run `handing-back.md`. Work stays unstaged on the branch `/plans do` created, in the main tree. Append the closing row to `<plans>/log.tsv`.

`ctx-<batch>.md` is referenced, never copied into the todolist or the reply. The plan text itself is intent, so a step that contradicts what you found on disk loses to what you found on disk, except at step 0, where a contradiction is a question for the operator.

**Reply:** the plan id and slug, what the probe showed in your own words, each acceptance criterion beside its evidence, and the handover from `handing-back.md`.
