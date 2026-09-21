---
name: interrogate
description: 'Use for "interrogate", "adversarial review", "multi-model review", "challenge this", "stress test this code", "find blind spots", or "tear this apart". Multiple LLM reviewers challenge changes from independent angles.'
disable-model-invocation: true
---

# Interrogate

Spawn four reviewers on four different models to adversarially review code changes. Each model gets the same prompt and rubric. The adversarial signal comes from model diversity, not assigned personas. Models differ in blind spots, priors, and reasoning patterns. Agreement across models is high-confidence signal; lone-model findings are worth reading but lower confidence.

The deliverable is a synthesized verdict, handed back in the reply. Do not auto-apply changes, do not commit, and do not post the verdict to a PR, an issue, or a review. The operator posts what they want posted.

## Step 1, Determine Scope

Identify what to review from context:

- If the user points at specific files or a diff, use that
- Otherwise assume the usual state: work sitting unstaged (and sometimes staged or untracked) on a `feat/*` branch in the main tree. `git status --short` plus `git diff HEAD` covers staged and unstaged; add untracked files by path
- For a whole branch, run `git diff <base>...HEAD` against the repo's real base branch. Read it from the repo rather than assuming: `git symbolic-ref refs/remotes/origin/HEAD` names it
- If the user's message references recent work, gather the relevant files

Package the diff (or file contents) plus any surrounding context files the reviewers need to understand the code.

## Step 2, State the Intent

Before spawning reviewers, state the intent explicitly. What is this code trying to accomplish? Derive this from:

- The user's message
- Commit messages
- PR description if one exists
- The code itself

Write one clear paragraph. Reviewers challenge whether the work achieves the intent well, not whether the intent itself is correct. If you're unsure about the intent, ask the user before proceeding.

Intent only: what the change is for and the constraints it must hold. Keep your own read of the diff out of it. A reviewer handed a conclusion validates the conclusion instead of testing the code.

## Step 3, Spawn Reviewers

Launch all four reviewers in a single message: two Claude arms as `Task` spawns and two Codex arms as background Bash calls, per the playbook skill's **Codex arms** section, so the blind spots do not overlap. The count is four rather than two because two per family lets the verdict separate cross-family agreement from a shared family prior, and a three to one split from an even one. Two arms make neither distinction.

| Reviewer   | Arm                           | Role                                                                                                                                                                                                   |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reviewer A | `subagent_type`: `fable-max`  | Claude family, top reasoning tier, reads only                                                                                                                                                          |
| Reviewer B | `subagent_type`: `opus-xhigh` | Claude family, second perspective, reads only                                                                                                                                                          |
| Reviewer C | the Codex review arm          | Codex family, top reasoning tier. The `review` subcommand over `--uncommitted`, slug `<task>-review`                                                                                                   |
| Reviewer D | sol arm                       | Codex family, middle tier, `-s read-only`, slug `<task>-interrogate-sol`, given the filled template as its prompt, so it is a different model reading the same diff, not a second sample of Reviewer C |

Reviewer B is the lead's own model at a different reasoning effort, while the lead runs Opus as it does today. What it brings is a clean context window and an adversarial brief, so its value is independence from the diff's author rather than a blind spot that author lacks: effort changes how long a model thinks about what it already thinks. It keeps its seat because there is no third Claude panel arm, and dropping it leaves one Claude against two Codex. Drop it before any other arm when the panel has to be cut.

Pass no `model` parameter, no `readonly` parameter, and no isolation parameter in any form. Reasoning effort is fixed per arm; say "read only, make no edits" in the prompt for the Claude arms. The panel degrades gracefully: with no `codex` on PATH run the Claude arms only, and say in the reply which arms ran and that the verdict came from a single family. With `codex` but no subagents, the two Codex arms are the panel, and the reply says so. Drop any Claude agent that is not installed and run the rest. Two arms from different families still beat one. With neither subagents nor `codex`, run the filled template yourself as a single read-only pass and say in the reply that the verdict is single-model.

`--uncommitted` is the only form that sees staged, unstaged, and untracked work at once, which is the state the tree is usually in. Do not swap it for a commit range unless the user asked to review a landed range. Point each Codex arm's `-C` at the repo root. Reviewer C reads the bare diff: Codex's `review` subcommand with `--uncommitted` rejects any instructions argument, so intent and rubric cannot reach it. Reviewer D gets the whole filled template as its brief, which is why it exists alongside C.

Read `references/reviewer-prompt.md` and fill in the template with:

1. The stated intent
2. The diff or file contents
3. The review rubric from `references/rubric.md`
4. The code-quality lens from `references/code-quality-review.md`

The same filled template goes to all reviewers, so every model applies the code-quality lens.

Each reviewer produces structured findings as described in the prompt template.

## Step 4, Synthesize

As results come back, build a unified picture:

1. **Parse all findings** from the reviewers
2. **Identify consensus**. Findings raised by 2+ models independently are highest signal.
3. **Identify lone-model findings**. Still worth reading, but weight accordingly.
4. **Deduplicate**. Different models may describe the same issue differently. Merge these and note which models raised it.
5. **Note disagreements**. If one model flags something and another explicitly says the opposite, that's useful context for the verdict.

## Step 5, Lead Judgment

You are the lead reviewer, a pragmatic senior engineer, not a neutral aggregator.

Read `references/lead-judgment.md` for the full framework. Reviewers only see a slice of the codebase. You have the full context (the goal, the constraints, the timeline, which tradeoffs were already considered). Use that context aggressively.

Categorize every finding using these buckets:

- **Act on**. Real issues affecting correctness, security, or maintainability given the actual goals. These would block a real PR.
- **Consider**. Legitimate points, but you're not sure they outweigh the cost of addressing them right now. Worth the user's attention.
- **Noted**. Technically valid but not actionable. Context-dependent, premature optimization, or low-impact given the current stage.
- **Dismissed**. Wrong, nitpicky, or missing context. Brief explanation why.

For each finding, include:

- Which model(s) raised it
- The category (act on / consider / noted / dismissed)
- A one-line rationale for the categorization

## Output Format

Present the verdict in this structure:

### Intent

> [The stated intent paragraph from Step 2]

### Reviewers

- Reviewer [label]: [agent name or Codex tier], [N findings] (one bullet per reviewer)

### Act On

[Findings that should be addressed. For each: description, which models raised it, why it matters.]

### Consider

[Findings worth thinking about. For each: description, which models raised it, tradeoff involved.]

### Noted

[Valid but low-priority. Brief list.]

### Dismissed

[Rejected findings with brief rationale. This shows the user what was filtered out and why, so they can override your judgment if they disagree.]

### Agreement Map

[Where did models agree, where did they diverge, and what does the pattern of agreement/disagreement tell us?]
