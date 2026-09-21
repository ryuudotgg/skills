---
name: principle-never-block-on-the-human
description: "Apply when tempted to ask 'should I do X?' on reversible work. Proceed, present the result, let the human course-correct after the fact; reserve confirmation for irreversible actions."
disable-model-invocation: true
---

# Never Block on the Human

The human supervises asynchronously. Agents must stay unblocked: make reasonable decisions, proceed, and let the human course-correct after the fact. Code is cheap. Waiting is expensive.

**Why:** Every permission pause stalls the pipeline and makes the human the bottleneck. Since code changes are reversible and reviewable, a wrong decision usually costs less than blocking.

**Pattern:**

- **Proceed, then present.** Do the work, show the result. Don't ask "should I do X?" Do X, explain why.
- **Reserve questions for genuine ambiguity.** Ask only when you truly cannot infer intent from context.
- **Make the system self-healing.** When you notice a problem, log it and fix it in the next round. The next round is the point. A defect in the code or the tooling that this request does not depend on gets logged and reported open, because repairing it here widens the fence around work the human never asked to review. Fix it in this round only when the request depends on it. This covers defects you found beside the work. It is not a way to defer a question about where something lands, which the destination bullet below still settles by asking, always.
- **Supervision is async.** The human reviews plans, diffs, and changes on their own schedule. Design workflows for review-after-the-fact.
- **Code is cheap, attention is scarce.** A wrong implementation costs minutes to fix. A blocked agent costs the human's attention to unblock.

**Boundaries:**

- **Irreversible actions** (force push, delete production data, send external messages, kill or restart a process you did not start) still require confirmation. Any write to production data needs a written plan approved before it runs, naming what it touches, how many rows, and how to reverse it. The same bar covers any MCP tool that mutates production state, such as bans, deletions, merges, bulk notifications, or access grants. Read only queries and searches do not need one.
- **Reversible actions** (write code, edit notes, split tasks) should proceed without blocking.
- **Product direction** comes from the human; _execution_ should not block.
- **Destination and visibility.** Which surface, which tab, which route, public or private, who can see it. These are never observable from the codebase and never have a default. This bullet overrides every line above it in this file, including "proceed, then present" and "reserve questions for genuine ambiguity": however cheaply a prototype could render one of the candidate destinations, rendering it is not an answer and does not settle the question. If the request does not name exactly one destination, stop and ask. Always.

Rationale: a request naming "the overview tab" was read as the public profile page, while a private directory of the same name sat in the tree. A per user breakdown meant for the owner's eyes shipped to a page anyone could load. Nothing in the codebase said which surface was meant, and the walk back cost more than the question would have.
