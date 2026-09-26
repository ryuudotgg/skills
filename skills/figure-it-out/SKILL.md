---
name: figure-it-out
description: "Design an auditable playbook when no narrower one fits. Scales rigor to the task, runs a hypothesis loop, and logs decisions via show-me-your-work. Use for /figure-it-out, 'figure it out', a large migration, or work a human reviews later."
disable-model-invocation: true
---

# Figure it out

When the task matches no playbook, design one. The deliverable before any code is the workflow itself: a sequence of phases that scales rigor to the task, runs the scientific method, and leaves a decision trail a human can audit after stepping away. Bias toward more rigor. The cost of building the wrong thing dwarfs the cost of being careful.

Don't reinvent a playbook you already have. A focused single-unit task that matches Bug fix, Perf issue, Feature, Refactoring, Investigation or Prototype routes there. But a large or cross-cutting version of one (a migration across many call sites, an ambitious multi-part change), or work the user reviews after stepping away, belongs here even though a single-unit version would be a Feature. The rigor and the audit trail are the point.

## Start

Open a todolist whose first item is to read the Principles section of the **playbook** skill. Then add the phases below as todos.

## Phase A: Frame

Ground first, then start. Don't begin the run until you can state:

- The definition of done as a falsifiable predicate (the **prove-it-works** principle skill). "Done well" has to be checkable.
- Scope, quantified: rough units and effort, plus the blockers grounding surfaced. Raise them before spending hours, not after fifty doomed edits.
- The rigor level, biased high. One-way doors and high blast radius get more; reversible low-stakes steps get less. Rigor is gates and artifacts, not "try harder".

Present the framing and tradeoffs before starting a long run. Reversible work proceeds (the **never-block-on-the-human** principle skill), but a multi-hour run earns one checkpoint.

Where the work lands is the one question that always blocks. Which surface, which tab, which package, public or private, who can see it. If the task does not name exactly one destination, stop and ask before writing code. This overrides the **never-block-on-the-human** principle skill by name. Do not settle it with a default, with the nearest plausible directory, or with a prototype. Anything that writes to production data blocks the same way and needs an approved plan first: the tables touched, the row count, and how to reverse it.

## Phase B: Design the workflow

Decompose into atomic, independently-landable units. Sequence riskiest-unknown-first so option value stays high. Scaffold and verification come before features (the **foundational-thinking** principle skill).

- Build the verification harness before the work, with the baseline captured from the pre-change state, so the check reads as "old value vs new value".
- For one-way-door design decisions, run the **architect** skill. Its Phase B fans out four opinionated candidates across two model families and synthesizes one. A one-way door earns two independent families, and four is the smallest panel that gives each a top tier and a second perspective. Skip it for mechanical work whose shape is already concrete. A second design pass over a settled design is over-engineering (the **laziness-protocol** principle skill).
- Decide what fans out. Parallelize only across genuine seams, and give each worker its own scratch directory under `/tmp/figure-it-out/<slug>/<worker>/` for artifacts, logs, and candidate output (the **separate-before-serializing-shared-state** principle skill). No worktrees, no second checkout, no per-worker branch. Never set an `isolation` parameter on a worker, in any form; every value of it produces a worktree. Workers that edit real files take disjoint file sets and land unstaged on the one `feat/*` branch in the main tree. Don't over-fan.
- Write the designed phase list down. That list is what the human reviews.

Then put the design into motion. Add its steps to the todolist as concrete items, after the Phase C entry and before Phase D. Run each under the Phase C loop discipline, and weave the Phase D log through them, a row as each step lands, rather than saving the whole trail for the end.

Reuse whatever the project already has running. Never kill, restart or hijack a process, server or database you did not start in this session. If one is in the way, say so and ask.

## Phase C: Run the loop

Each unit is an experiment: state the hypothesis, make the smallest change, measure against the predicate on the real artifact, keep it if it advanced, revert it if it didn't.
Apply the **sequence-verifiable-units** principle skill, verifying each unit before starting the next instead of batching checks at the end.

- Verify by inspecting the artifact, never a self-report. When something passes too easily, suspect the observation method before the system. A blank screenshot passes a lazy gate.
- Pair delegated work with a judge and audit the delegates' artifacts yourself before trusting them. If a worker games the gate, reset and harden the contract. If the gate itself is wrong, fix the gate in its own change rather than routing around it.
- A verdict is VERIFIED, NOT VERIFIED, or INCONCLUSIVE. Inconclusive is not a pass. Don't hide a negative.

## Phase D: Keep the audit trail

Log the run via the **show-me-your-work** skill, one canonical TSV with a row per decision and per unit, evidence as links. The trail is a working artifact: leave it unstaged with the rest of the change and name its path in the reply. It stays out of the task's commit and PR in either delivery mode. Prefer evidence produced by a script that lives in the repo over a hand-typed one-off, so a reviewer can re-run it. The trail plus the diff is what lets the human come back and trust the work.

## Phase E: Verify and hand back

Check the whole against the Phase A predicate on the real product, not just the harness. Encode any recurring correction as a gate, a lint rule, a check, or a script, so the win can't silently regress (the **encode-lessons-in-structure** principle skill).

Leave everything unstaged on the `feat/*` branch for the handback, the playbook skill's `playbooks/handing-back.md`; who stages, commits, pushes and posts is stated once, in its `references/delivery.md`.

**Reply:** the playbook you designed, the rigor level and why, the decision-trail path, what's verified against the predicate, and what's still open.
