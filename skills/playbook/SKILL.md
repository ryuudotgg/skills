---
name: playbook
description: Route a task to the right engineering playbook. Applies the principles index.
disable-model-invocation: true
---

# Playbook

## Non-negotiables

**Start every multi-step task with a todolist whose first item is to read the Principles section below in full.** In your reply, name each principle that shaped a decision and the choice it changed. A citation with no decision behind it means you skipped its skill.

Classify a fork before asking the human, in this order:

1. **Destination and visibility.** Which surface, tab or route, public or private, who sees it, whose feed it enters. A prototype answers what it looks like, never where it lives. Ask and block until answered. This overrides **never-block-on-the-human** by name.
2. **Observable fact.** If running it would answer, sketch it via the Prototype playbook and let the result decide.
3. **Read-only Investigation.** Answer from the evidence, not a sketch.
4. **Product or preference call** no experiment can settle. Ask only here.

Outside class 1 a probe beats the ask, handing the human a result to react to instead of a decision.

- Nontrivial change, architecture decision, "are we sure?" → the **how** skill.
- Any code → name the data shape first, per the **model-the-domain** principle skill.
- Open alternatives across a function boundary → the **architect** skill first. The boundary alone is not the trigger. A settled shape (caller migration, extraction against a pinned contract, an established module pattern) skips it as `architect skipped: <reason>`.
- Parallel fan-out → the **figure-it-out** skill. Bakeoffs → the **architect** skill. Contested design → the **interrogate** skill. Nontrivial multi-step → the throughput checkpoint (Feature step 3).
- Any prose surface, your reply included → the **unslop** skill and Writing the reply. A SKILL.md is written directly against the frontmatter schema, not generated.
- Docs, RFCs, readmes, PR descriptions, commit messages → the **technical-writing** skill.
- Before handing back → the **no-comments** skill (XS and S fast path rows use the two comment hooks instead), then check: no comment restating the code, no dash as punctuation, no AI sounding copy, a blank line between the steps of a function body.
- Any browser-rendered surface → `references/ui-design.md` before designing and at verification, and drive the surface live through a browser MCP. Reproduce bugs yourself, bar the Bug fix step 1 exception.
- PR status ("check on PR X", "anything outstanding on X") → the Babysit playbook, never on merely opening a PR. Declare its mode before polling. Its step 1 owns the request-to-mode mapping.
- A review bot or agentic security review commented on the PR → skeptical posture. Triage fix, dismiss or ask per `references/review-triage.md`. Draft the reply for the user, never post it.
- Broken skill mid-task → fix it in place on its own `feat/*` branch, unstaged. Don't block, don't silently work around it.
- Long or autonomous work, or a user stepping away ("going to bed", "trust it when i'm back", "/loop until X") → a decision trail via the **show-me-your-work** skill, in the repo, unstaged.

## Principles

Read a principle's skill (`principle-<slug>`, also `/principle-<slug>`) in full before applying it.

| principle                                          | when                                             | rule                                                                       |
| -------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| principle-laziness-protocol                        | refactoring, diff size, new layers               | smallest change, delete first                                              |
| principle-foundational-thinking                    | before writing logic                             | data structures first                                                      |
| principle-redesign-from-first-principles           | a new requirement                                | redesign as if foundational                                                |
| principle-subtract-before-you-add                  | before adding or rewriting                       | remove dead weight first                                                   |
| principle-minimize-reader-load                     | hard to trace code                               | fewer layers, less hidden state                                            |
| principle-outcome-oriented-execution               | phased rewrites, migrations                      | converge, no throwaway states                                              |
| principle-experience-first                         | product, UX, scope tradeoffs                     | delight over convenience                                                   |
| principle-exhaust-the-design-space                 | no precedent                                     | compare 2 or 3 prototypes                                                  |
| principle-build-the-lever                          | non-trivial work                                 | build the tool, rerunnable                                                 |
| principle-model-the-domain                         | stateful logic, heavy branching, repeated shapes | a structure (state machine, table, typed model, reducer) over conditionals |
| principle-boundary-discipline                      | validation, errors, adapters                     | guard boundaries, trust inside                                             |
| principle-type-system-discipline                   | a type or signature                              | illegal states unrepresentable                                             |
| principle-make-operations-idempotent               | commands, loops amid retries                     | converge to one end state                                                  |
| principle-migrate-callers-then-delete-legacy-apis  | a new internal API                               | migrate and delete together                                                |
| principle-separate-before-serializing-shared-state | concurrent writers                               | eliminate sharing first                                                    |
| principle-prove-it-works                           | before declaring done                            | verify the real artifact                                                   |
| principle-fix-root-causes                          | debugging                                        | reproduce, ask why to the root                                             |
| principle-sequence-verifiable-units                | sweeps, migrations, delivery                     | verify each unit before the next                                           |
| principle-guard-the-context-window                 | large outputs, long files, fan-out               | bulk to subagents, summaries here                                          |
| principle-never-block-on-the-human                 | "should I?" on reversible work                   | proceed, present the result (class 1 excepted)                             |
| principle-encode-lessons-in-structure              | the same instruction twice                       | a lint, flag or script, not text                                           |

## Autonomy

**Just do it.** Reversible work proceeds without asking, and so do external actions the pause list does not name (evals, ticket updates). "Don't stop", "going to bed", "be fully autonomous" mean keep going within the pauses. Just do it covers the work you were asked for. A defect you find beside it that the request does not depend on gets reported open rather than repaired in the same diff, because widening the fence spends the operator's review attention on work they did not choose.

**Always pause** for force-push, deploys, data deletion, customer messages, team chat, and every write to the git remote, its history or the code host. You never stage, commit, push, open or comment on a PR, or merge. Work lands unstaged on a `feat/*` branch in the main tree.

**A tool that writes to production data needs an approved plan first**, one paragraph naming what it touches, the blast radius and how to reverse it. MCP tools that mutate production state count. When a name does not give the direction, read the description first.

Never stop, restart or take over a process you did not start this session. Say so and ask.

No is an acceptable answer. Push back when that is your real judgment. A recommendation is a judgment, not a validation, and agreement is not the default.

## Subagents and Codex arms

Delegate when parallel or isolated workstreams can proceed independently, or when bulk output would swamp this context. Work directly when the work is sequential, when it lands in a single file, when a few tool calls would settle the investigation, or when the context that matters lives only in this session. The recurring miss is an arm sent to explore what a direct search would answer sooner.

Any subagent you spawn inside a playbook step is `subagent_type: "playbook-agent"`. Routed skills (how, interrogate, architect, figure-it-out) set their own; do not override those.

Every Task call: `run_in_background: true`, file pointers, not inlined context, an explicit model per role. Never an `isolation` parameter or a worktree. Scratch under `/tmp/`. `readonly` is not a parameter, so state read only in the prompt.

- Prose, judgment, taste, cross-cutting design, gnarly concurrency, subtle algorithms, vague briefs → `fable-judgment`.
- Second opinion → `opus-review`, and the Codex review arm on the diff. The Codex half is what makes the pair independent: while the lead runs Opus, `opus-review` is that same model, so it brings a clean context window and not a second family.
- Comment sweep → `comment-sicko`.

### Codex arms

Codex tiers (luna, terra, sol, astra) are not Task models. A Codex arm is one background Bash call, then a Read of its output file. Run `command -v codex` once per task, and read `references/codex-arms.md` before firing one. It holds the tier table, the invocations and the rules.

## Writing the reply

Write it clean as you draft it. The cleanup pass afterward has been measured to fail. Dashes are banned as punctuation, and two cases keep recurring. A file-list bullet joined to its description by a dash becomes a sentence ("`main.js` owns persistence and the IPC handlers"). A bold header joined by a dash becomes its own sentence ("**Verification.** End to end via CDP").

The operator reads the diff, so name a change and stop. Explain a choice only where a real alternative existed, in one sentence. Every section the playbook's reply names stays, each as short as its content.

Name who the work is for and what changes for them, then what the next maintainer inherits, before any implementation detail. If you cannot say what either would notice, the work or the explanation is off.

Never fabricate a link, citation or transcript reference. Link only what you produced or read this session.

## Comments

The hooks name every comment line you add. Keep one only where it names an external constraint, a landmine, or why the obvious approach lost, and it is never flagged twice. The recurring case is a verify script narrating its phases: a `// Phase 1` line dies, the assertion string is the doc. This applies to every file you produce, the delegate's diff included.

## Playbooks

Open the matched playbook and copy its steps into the todolist verbatim, before any task-specific todos and before reasoning about the task. The failure mode is a bespoke plan that drops named steps (architect, the throughput checkpoint). A skipped step stays in the list as `skip: <reason>`. Large or cross-cutting work routes to the **figure-it-out** skill even when a narrower playbook fits, and so does anything no playbook fits.

- **Backlog item** (`/plans do <id>`). Probes the repo to re-derive current state from the plan's intent, then routes below. `playbooks/backlog-item.md`.
- **Investigation.** How does X work, are we sure about Z. `playbooks/investigation.md`.
- **Bug fix.** A defect, runtime evidence. `playbooks/bug-fix.md`.
- **Perf issue.** Measured slowness, a baseline. `playbooks/perf-issue.md`.
- **Feature.** `playbooks/feature.md`.
- **Refactoring.** Rename, extract, dedupe, move. `playbooks/refactoring.md`.
- **Prototype.** A throwaway sketch to settle an observable fork. `playbooks/prototype.md`.
- **Babysit.** `playbooks/babysit.md`.
- **Session pickup.** Resume prior work. `playbooks/session-pickup.md`.
- **Pause safely.** Suspend cleanly. `playbooks/pause-safely.md`.
- **Authoring or modifying a skill.** `playbooks/authoring-a-skill.md`.
- **Handing back.** Every playbook's last step: report, evidence, one commit message, stop. `playbooks/handing-back.md`.
