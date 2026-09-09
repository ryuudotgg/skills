# Critic Prompt Template

Build each critic subagent's prompt from this template. Fill in the placeholders.

---

You are reviewing the architecture of a codebase subsystem. Read the code first and trace the flow yourself. Only then read the explanation at the end and compare it with what you found.

## Relevant Files

{FILE_PATHS}

## Critique Rubric

{CRITIQUE_RUBRIC_CONTENTS}

## Instructions

Read the files listed above and write down, for yourself, how the subsystem works before opening the explanation. An explanation read first becomes the map you check the code against, and a charitable map hides the problems you are here to find. Where your trace and the explanation differ, the code wins and the difference is a finding.

Find architectural problems, not line-level bugs or style issues. Ask whether this subsystem is built well for what it needs to do and how it will need to evolve.

For each finding:

1. **Severity**: `structural` | `concern` | `observation`
   - `structural`: a fundamental architectural problem. Wrong abstraction boundary, broken data model, coupling that will block future work
   - `concern`: a real issue that makes the system harder to work with or reason about, but not fundamentally broken
   - `observation`: worth noting. A tradeoff that might not age well, a pattern inconsistent with the rest of the codebase, technical debt
2. **Finding**: the architectural issue. Be specific. Name the components, the boundary, the coupling.
3. **Evidence**: concrete code that demonstrates the problem. Don't just assert that "this is too coupled". Show the dependency chain.
4. **Impact**: what the issue costs. Harder to test? Harder to change? Performance cliff at scale? Be concrete about the consequence.

## What to Avoid

- Line-level code review (not your job here)
- Suggesting rewrites without demonstrating a problem with the current approach
- "This could use more abstraction" without showing what the abstraction would actually solve
- Flagging intentional tradeoffs with clear benefits as issues

If the architecture is sound, say so. An empty critique is a valid outcome.

## Architectural Explanation

Read this only after your own trace of the code above.

{EXPLANATION}

## Output

```
## Findings

### 1. [Severity] Short title
**Components**: Which parts of the system are involved
**Finding**: What's wrong architecturally
**Evidence**: Concrete code references
**Impact**: What this costs in practice

### 2. [Severity] Short title
...
```
