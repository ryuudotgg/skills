---
name: architect
description: "Sketch types, signatures, and module structure before code, then stay in the loop while implementation fills in. Use for /architect, 'architect this', 'design this', or non-trivial work where jumping to code would lock in the wrong shape."
disable-model-invocation: true
---

# Architect

Design before implementing. Sketch types, function signatures, class shapes, and module boundaries with `not implemented` bodies and pseudocode. Synthesize across multiple model perspectives, then fill in code against the chosen sketch. If implementation proves the sketch wrong, throw it out and redesign.

## Start

Open a todolist with one entry per phase before starting. Autonomous mode without checkpoints needs the list to show phase position and keep phases from silently disappearing.

1. Ground
2. Sketch
3. Agree
4. Implement
5. Scrap

## Phase A: Ground the problem

Build a real mental model of every system the new code touches. Run the **how** skill over the relevant subsystems. Critique mode if existing structure is the constraint or the design must push back on it.

Naming a file isn't grounding. Produce the traced model `how` prescribes. If the design redefines ownership or layering, recover the rationale for the existing shape from the history (`git log -S` over the symbols, the PR that introduced them) so it enters the design as a constraint, not a guess.

Skip Phase A only when the work is genuinely greenfield with no surrounding system to integrate.

## Phase B: Sketch

Fan out the design-sketch task with the Phase A grounding artifacts attached. Pass `references/runner-prompt.md` as each runner's prompt. Each candidate produces a design package shaped per `references/rationale-template.md`: the caller's usage written first, then the type sketch, function signatures, module map, and prose rationale derived from it.

Run four candidate runners, one per arm. Each `subagent_type` is a wrapper agent that owns its own model choice, so name the role here and let the wrapper pick the tier:

| Runner | `subagent_type` | Role |
|--------|-----------------|------|
| Runner A | `fable-max` | Claude family, top reasoning tier |
| Runner B | `opus-xhigh` | Claude family, second perspective |
| Runner C | `codex-sol` | Codex family, top reasoning tier. Shells `codex exec --enable fast_mode -s read-only -C <abs repo path> -o /tmp/codex/architect-sol.md - <<PROMPT ... PROMPT` |
| Runner D | `codex-terra` | Codex family, everyday tier. Same invocation, its own output path |

The panel degrades gracefully. If a wrapper agent is not installed, drop that arm and run the rest. What matters is two or more independent perspectives, ideally from different families, not the exact roster.

Pass no `model` parameter, no `readonly` parameter, and no isolation parameter in any form. Candidates stay independent by writing to their own scratch directory under `/tmp/architect/<slug>/<runner>/`, never a worktree and never a second checkout.

Design it twice. Require at least two structurally distinct candidates before synthesis, even when the first looks sufficient. This is the **exhaust-the-design-space** principle skill made concrete. Whole-shape alternatives, not point fixes inside one shape.

Screen every candidate against [`references/design-red-flags.md`](references/design-red-flags.md) before synthesis. Reject or revise shallow modules, information leakage, temporal decomposition, and pass-through methods.

Compare viable candidates on interface depth. Prefer the design that hides more complexity behind a smaller, simpler public surface. A rich interface can keep call chains short by concentrating capability instead of scattering it across layers.

Read the four candidates yourself and synthesize one design package from them. Do not average them: pick the strongest shape and graft what the others got right. The synthesis decision populates the rationale's "Synthesis decision" section, naming the base candidate, what was grafted, and what was rejected.

## Phase C: Agree (opt-in)

Default: proceed directly to implementation with the synthesized design. No human checkpoint.

Opt in to a checkpoint when the invoker explicitly asks: "/architect with checkpoint," "stop and show me before implementing," or similar. Then surface the synthesized design and pause for sign-off.

The synthesis lands as its own reviewable step either way: the sketch files unstaged on the `feat/*` branch in the main tree, described in the reply. Do not commit it and do not push it. That is the "scaffold first" mode of the **foundational-thinking** principle skill; the fill-in that follows reads as bodies written against a stable contract. Planned and scoped breakage during fill-in is fine, per the **outcome-oriented-execution** principle skill. For adversarial pressure on the design before implementing, run the **interrogate** skill on the synthesized sketch.

If the human pushes back on the shape (in a checkpoint or after the fact), treat that as Phase A evidence. Re-ground and re-run Phase B before writing more code.

One question is always blocking, checkpoint or not: where the thing lands. Which surface, which tab, which package, public or private, who can see it. If the request does not name exactly one destination, stop and ask. This overrides the **never-block-on-the-human** principle skill by name, and a candidate design that picked a destination is not the answer. A prototype does not settle placement.

## Phase D: Implement against the sketch

Replace `not implemented` bodies with code, pseudocode with logic. The synthesized sketch is the contract.

Verify against whatever the project already has running. Never kill, restart or hijack a process, server or database you did not start in this session. If one is in the way, say so and ask. The fill-in stays unstaged on the `feat/*` branch in the main tree. Never stage, commit or push it, and never post to a remote.

Deviations from the sketch are signal worth surfacing, not friction to absorb silently. If a function needs a parameter the sketch didn't anticipate, ask whether the sketch was wrong, the requirement was missed, or the implementation is overreaching. Surface it; don't bolt it on.

## Phase E: Scrap when the architecture is wrong

If implementation keeps producing friction the sketch can't absorb, throw the sketch out. Don't bolt fixes onto a wrong design, per the **redesign-from-first-principles** and **fix-root-causes** principle skills.

The signal is a *pattern*, not single instances. Tells:

- The same shape of workaround appearing repeatedly across unrelated code.
- Multiple unrelated edge cases that all need special-case branches.
- Types that need escape hatches (`any`, casts, optional fields always set in practice) to compile.
- The "we need a lock" reflex when the sketch said the state wasn't shared.
- Callers having to know the abstraction's internal rules to use it.
- Two or more independent Phase D deviations of the same shape across the implementation. Surfacing deviations is Phase D's job; a repeated pattern of them is Phase E's trigger.

Use judgment. A few edge cases don't condemn an architecture. Some problems are legitimately complex; complexity in the data is not complexity in the design. The rewrite signal is repeated friction of the same shape, not single hard cases.

When you scrap:

1. Re-run the **how** skill over what's been built. The implementation lessons enter the new design as inputs, not vibes.
2. Redesign as if the new constraints had been day-one assumptions, per redesign-from-first-principles.
3. Subtract before adding, per the **subtract-before-you-add** principle skill. The new sketch should be smaller than the old one before it grows.
4. Return to Phase B and re-run the candidate fan-out.

## Outputs

The caller's usage is written first and the type sketch derived from it. One file with new types and signatures for small changes; module map plus type definitions for larger work. The rationale ships alongside, shaped per `references/rationale-template.md`, including the usage sketch and the synthesis decision.
