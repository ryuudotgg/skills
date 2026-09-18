---
name: how
description: 'Use for "how does X work", code walkthroughs before changing something, and placement questions ("where should this live", "which package owns this"). Explains subsystem architecture, runtime flow, and onboarding mental models.'
disable-model-invocation: true
---

# How

Explore the codebase to answer "how does X work?" questions. Produce clear architectural explanations at the level of a senior engineer onboarding onto a subsystem. Enough to build a working mental model, not annotated source code.

This skill is read only. It reads code and history, and it writes nothing but its answer. Every subagent it spawns is read only too. Never stage, commit or push, and never post to a remote: reading the remote with `gh` is fine, posting to it is not. Never create a worktree and never set an `isolation` parameter, in any form. Never kill, restart or hijack a process, server or database you did not start in this session.

Two modes:

1. **Explain** (default). Explore the codebase and produce a clear explanation
2. **Critique.** Explain first, then spawn multiple models to independently identify architectural issues

## Explain Mode

### Step 1. Understand the Question and Assess Complexity

Parse what the user is asking about:

- "How does the rate limiter work?", a subsystem
- "How do we handle billing for on-demand usage?", a feature flow
- "How is the auth service structured?", an architectural overview
- "Walk me through what happens when a user submits a form", a runtime trace

Identify the scope. If ambiguous, state your best-guess interpretation before exploring. Don't ask. Let the user redirect if you're off.

One kind of ambiguity is the exception. When the question is where new work should land, which surface, which tab, which package, public or private, who can see it, and the request does not name exactly one destination, stop and ask. Explaining how the existing code is laid out is still fair game; picking the destination is not. This overrides the **never-block-on-the-human** principle skill by name, and no amount of exploration settles it.

**Assess complexity to decide the approach:**

- **Simple** (a single module, a small utility, a narrow question like "how does function X work"): skip explorer agents; the explainer explores and explains in a single pass. Go to Step 2b.
- **Complex** (a subsystem spanning multiple files/services, a cross-cutting feature, a full architectural overview): spawn parallel explorer agents first, then hand off to the explainer. Go to Step 2a.

When in doubt, lean simple. You can always spawn explorers if the explainer hits a wall.

### Step 2a. Explore (complex questions only)

Decompose the question into 2-4 parallel exploration angles, each a distinct slice of the subsystem so explorers don't duplicate work. Example split for "how does the rate limiter work?":

- Explorer 1: data model and state management
- Explorer 2: request path and enforcement
- Explorer 3: configuration and metrics infrastructure

The right decomposition depends on the question. Use your judgment. Narrow questions: 2 explorers is fine. Broad subsystems: up to 4.

Run all explorers in one message as luna arms, `-s read-only`, each under its own slug `<task>-how-explorer-<n>`. The playbook skill's **Codex arms** section points at the invocation; name only the tier, the slug and the sandbox here. `-s read-only` is the read only enforcement: state in the prompt as well that the explorer writes no files and runs no mutating commands. With no `codex` on PATH, explore with whatever read only subagent the tool provides.

Each explorer gets the same base prompt from `references/explorer-prompt.md` plus a specific exploration angle naming its slice. Each explorer should:

- Start broad: Glob for relevant directories, Grep for key types/interfaces/class names
- Follow the thread: from an entry point, trace the call chain (callers, callees, data flow, type definitions)
- Read the actual code, don't guess from file names
- Stop when it can describe the full path from input to output (or trigger to effect) without hand-waving any step
- Note things that are surprising, non-obvious, or that a newcomer would get wrong

Each explorer returns structured findings: components found, flow traced, files read, anything non-obvious. Overlap between explorers is fine; the explainer reconciles.

Then proceed to Step 3.

### Step 2b. Direct Explain (simple questions)

Spawn a single Task subagent that explores and explains in one pass, with `subagent_type`: `fable-max`, the strongest available Claude tier. Tell it in the prompt that it reads only: no edits, no writes, no mutating commands. Any read only subagent works if that agent is absent. With no subagents at all (outside Claude Code), explore and explain yourself in one pass and say so in the reply.

The agent does its own exploration (Glob, Grep, Read) and writes the explanation directly. Read `references/explainer-prompt.md` for the communication style and output format. Same structure, just no explorer findings as input.

Proceed to Step 4.

### Step 3. Synthesize (complex questions only)

Once all explorers return, spawn a single Task subagent to synthesize their findings into one coherent explanation, with `subagent_type`: `fable-max`. Tell it in the prompt that it reads only. Without subagents, synthesize yourself against the same explainer prompt.

The explainer gets all explorers' findings and writes the human-facing explanation (output format below). Read `references/explainer-prompt.md` for the full prompt template. The explainer reconciles overlapping findings, resolves contradictions, and weaves the slices into a unified picture.

### Step 4. Present

Present the explainer's output to the user. You may lightly edit for clarity or add context from the conversation, but don't substantially rewrite. The explainer's communication is the product.

### Output Format

Follow this structure, adapted to the question. Not every section is needed for every question.

**Overview.** 1-2 paragraphs. What it is, what it does, why it exists. Enough to decide whether to keep reading.

**Key Concepts.** The important types, services, or abstractions. Brief definition of each. Not exhaustive, just the ones needed to understand the rest.

**How It Works.** The core of the explanation. Walk through the flow: what triggers it, what happens step by step, where data goes, the decision points. Prose, not pseudocode. Reference specific files and functions so the reader can go look, but don't dump code blocks unless a snippet is genuinely necessary.

**Where Things Live.** A brief map of the relevant files/directories. Not every file, just the ones needed to start working in this area.

**Gotchas.** Non-obvious or surprising things that would trip someone up. Historical context that explains why something looks weird. Known sharp edges.

## Critique Mode

Triggered when the user asks for architectural issues, problems, or improvements, not just understanding.

### Step 1. Explain First

Run the full explain flow above (Steps 1-4). You must understand the architecture before critiquing it.

### Step 2. Spawn Critics

After the explanation is complete, launch four architectural critics in a single message: two `Task` spawns and two Codex arms, per the **Codex arms** section:

| Critic   | Arm                           | Role                                                                             |
| -------- | ----------------------------- | -------------------------------------------------------------------------------- |
| Critic A | `subagent_type`: `fable-max`  | Claude family, top reasoning tier, reads only                                    |
| Critic B | `subagent_type`: `opus-xhigh` | Claude family, second perspective, reads only                                    |
| Critic C | astra arm                     | Codex family, top reasoning tier, `-s read-only`, slug `<task>-how-critic-astra` |
| Critic D | terra arm                     | Codex family, everyday tier, `-s read-only`, slug `<task>-how-critic-terra`      |

Pass no `model` parameter, no `readonly` parameter, and no isolation parameter in any form. Reasoning effort is fixed per arm. State read only in the prompt for the Claude arms; `-s read-only` enforces it for the Codex arms. The panel degrades gracefully: with no `codex` on PATH run the Claude arms only, drop any Claude agent that is not installed, run the rest, and say in the reply which arms ran and that a panel from one family is a single family verdict.

Read `references/critic-prompt.md` for the prompt template. Each critic gets:

1. The explanation from Step 1 (so they don't re-explore)
2. The relevant file paths (so they can read the actual code)
3. The architectural critique rubric from `references/critique-rubric.md`

### Step 3. Lead Judgment

Same framework as the interrogate skill. You're a pragmatic lead, not an aggregator.

Categorize findings:

- **Act on.** Architectural problems worth fixing now
- **Consider.** Real concerns, but the cost/benefit is unclear
- **Noted.** Valid observations, low priority
- **Dismissed.** Wrong, missing context, or style preference

Present the explanation first (from Step 1), then the critique verdict below it. The explanation should stand on its own; someone who just wants to understand the system shouldn't wade through critique.
