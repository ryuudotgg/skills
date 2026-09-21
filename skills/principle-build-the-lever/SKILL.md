---
name: principle-build-the-lever
description: "Apply to any non-trivial work, not just bulk work: edits, migrations, analyses, checks. Build the tool that does it or proves it (codemod, script, generator, or a skill your subagents follow) instead of working by hand. The tool is the artifact a reviewer can rerun."
disable-model-invocation: true
---

# Build the Lever

When the work isn't trivial, build the tool that does it instead of doing it by hand.

**Why:** Two payoffs. Throughput: a codemod, generator, or script does the work the same way every time and reruns for free. Confidence: the tool is one artifact a reviewer can read and rerun to check the work. Hand-done changes can only be re-verified by redoing them. A deterministic script turns "trust me" into "run this".

**Pattern:** Default to building the lever. Skip it only when the task is genuinely trivial, a couple of obvious edits you can see at a glance.

- Do the first unit by hand to learn the recipe, then build the tool. Prove it by rerunning it on that unit and diffing against your hand-done version. Make the lever safe to rerun. A reviewer will.
- Codemod or script for edits, generator for repetitive files, a dump-to-sqlite query for analysis, a rerunnable check for verification.
- A deterministic lever beats fan-out. If the tool can process every unit in one pass, run it yourself; don't fan out delegates to hand-apply what a script can do.
- When you fan work out to subagents, write the lever as a skill they all read: the recipe, the verification contract, and the do-not-touch fences in one artifact, so every delegate inherits the same hardened version instead of re-explaining it per prompt and watching each one drift. Keep it outside the delegates' write scope so they can't quietly edit the contract.
- Applying this principle produces a file, and the test is the diff. If you cited it and there is no codemod, script, generator, or delegate skill in it, you didn't apply it. One exception. A one-off command you ran to settle a question and never ran again still counts, provided the handover carries the command and what it showed. A script you wrote and deleted is not covered, because a reviewer cannot rerun what is gone, and "trust me" is what this rule exists to replace. Keep that one per the rule below.
- The lever serves the work in scope. A codemod that also repairs an unrelated pattern it happened to match has widened the fence: land the in-scope pass and report the rest open.
- Keep the lever in the tree, unstaged, when the work outlives the session, so the next run reruns it instead of redoing it. Name its path in the handover and let the human decide whether it lands.

**Balance:** The bar is triviality, not repetition. A one-off still earns a lever when the lever is what makes the work checkable. Per the **laziness-protocol** principle skill, build the smallest script that does or proves the job, never a framework.

Distinct from the **encode-lessons-in-structure** principle skill, which makes a recurring instruction a durable guardrail. This is throughput and reviewability on the work in front of you. For scripting the verification itself, see the **prove-it-works** principle skill.
