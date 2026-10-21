---
name: interrogate
description: 'Use for "interrogate", "adversarial review", "multi-model review", "challenge this", "stress test this code", "find blind spots", or "tear this apart". Multiple LLM reviewers challenge changes from independent angles.'
disable-model-invocation: true
---

# Interrogate

Spawn reviewers on different models to adversarially review code changes. Each model gets the same prompt and rubric. The adversarial signal comes from model diversity, not assigned personas. Models differ in blind spots, priors, and reasoning patterns. Agreement across models is high-confidence signal; lone-model findings are worth reading but lower confidence.

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

Before launching, run `skills arms` (the playbook skill's `bin/skills arms`, by absolute path), then fill the seats below per the playbook skill's `references/codex-arms.md` **Roster** and **Panels** and launch the reviewers in a single message.

| Reviewer   | Arm                               | Role                                                                                                                                                                   |
| ---------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer A | `subagent_type`: `fable-judgment` | Judgment and prose arm, reads only                                                                                                                                     |
| Reviewer B | `subagent_type`: `opus-review`    | Second perspective, reads only                                                                                                                                         |
| Reviewer C | the Codex review arm              | Top tier (sol, astra on critical work), read only, slug `<task>-review`. Reads the whole uncommitted change without the intent                                         |
| Reviewer D | sol arm                           | `-s read-only`, slug `<task>-interrogate-sol`, given the filled template as its prompt, so it reads the same diff against the intent and rubric Reviewer C cannot take |

Reviewer B, the lead's own model under an Opus lead, brings independence from the author rather than a second family.

Pass no `model` parameter, no `readonly` parameter, and no isolation parameter in any form. Reasoning effort is fixed per arm; say "read only, make no edits" in each prompt. With no seat filled, run the filled template yourself as one read only pass and say in the reply that the verdict is single model.

Reviewers C and D review the whole uncommitted change, staged, unstaged, and untracked, which is the state the tree is usually in. Do not swap it for a commit range unless the user asked to review a landed range. Point each arm at the repo root. Reviewer C reads the change cold. Through a harness or OpenCode, its brief is the review arm's filled template with the Intent section cut. Under the Codex CLI, it is Codex's `review` subcommand, which rejects any instructions argument. Reviewer D gets the whole filled template as its brief, which is why it exists alongside C.

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

- Reviewer [label]: [arm], [family], [N findings] (one bullet per reviewer)

Families: <names>

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
