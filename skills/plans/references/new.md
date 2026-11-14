## /plans new `[scope hint]`

Survey and write plans. Read only on source code. This verb never implements, never edits code, never branches.

The hint is optional and free text: a subsystem, a symptom, a goal, a pasted error. `/plans new` on its own surveys the whole project. Nothing else is an argument, because everything else is discoverable and the caller has not read the code yet.

- **The project is detected**, per Project detection above. Never ask for it when the working directory answers it.
- **The batch slug is derived** from what the survey actually found, not from what anyone guessed before looking. Name it after the subsystem or the invariant the batch shares.
- **The plan count falls out of the sizing rule in step c.** It is a result, never an input. A caller who asks for five plans is guessing at an answer the survey has not produced yet.

Bootstrap if needed: create `<plans>/<Project>/` and `done/`, create `index.tsv` with the header row, and if a prose `README.md` sits at the project root move it to `_archive/README.md`.

Plan files under `<plans>/<Project>/` with no index row are a batch that stopped before step f. With no hint, or a hint that names that batch, resume it at step c on those files and their ctx file instead of surveying again. With a hint for other work, name the stopped batch in the reply and survey as usual.

**a. Survey first, then ask where the work lands.** Never ask what you can read. The survey decides the batch boundary, the slug and the count. The one thing it cannot decide is destination: ask it with `AskUserQuestion` in Claude Code or `request_user_input` in Codex when the turn lists it, else in a final message whose first line is the question, naming the candidate surfaces you actually found (the specific tab, route, panel, package or worker, and whether it is public or private). Refuse to infer. This is the named override of never block on the human, and it is the only question that can stop a plan being written. Step e asks the rest, once, after it. A tab name that reads as the public profile, while a private directory of the same name sits next to it, is how a user's private breakdown ships to a public page. Refuse to write any plan whose `## Outcome` does not name exactly one destination surface.

- **Read the inbox.** Run `<playbook>/bin/skills issues list <Project>` before drafting any plan. Run `<playbook>/bin/skills issues show <Project>#<n>` on each listed ref. One that opens with `<Project>#<n> conflict: ...` is a number two machines filed apart and stays listed even when its first filing is closed: run `<playbook>/bin/skills issues renumber <Project>#<n>` until `issues show` prints no conflict line, then list again, so every filing is weighed under its own ref. Each line is then an open issue another project or the operator filed: treat it as work the survey found, weighed against the code like the rest, unless `<playbook>/bin/skills issues show <Project>#<n>` already lists a `resolves` line, since an open plan answers it then. The plan that answers it names the ref in its `## Notes` and gets `--resolves <Project>#<n>` on its step f `plans add`, so a batch resumed at step c still links it. An issue no plan in the batch answers stays open and is named in the reply.
- **Recall prior work.** With a hint, run `<playbook>/bin/skills recall <words>` on it before drafting any plan, and run it again in step b. Never pass `--project`: the work may already have landed in another project. A search keeps only the documents holding every word, so pass two to four of the hint's distinctive words, one search per thing the hint names (`share links signing`, then `share links revocation`, for `share links: signing and revocation`), never the whole sentence. Each hit line is project, ref, section, status, snippet and path. For each DONE or DROPPED hit that bears on the batch, read its Outcome and `## Landed` with `<playbook>/bin/skills plans show <Project> <ref>`, never from the printed path, since a trail hit prints `log.tsv` there. Recall informs the survey and never replaces reading the code: the code says whether a DONE plan's behaviour still holds, and a DONE plan whose behaviour is gone is work the survey found.

If the survey finds work spanning more than one unrelated subsystem, do not silently merge it into one batch and do not demand the operator pick up front. Propose the split you found, one line per batch, and write the one they confirm.

**b. Write the batch.** One plan per unit plus exactly one `ctx-<batch-slug>.md`. Everything the siblings would otherwise each restate goes in the ctx file once. A sibling that repeats two paragraphs of the ctx file is a defect, cut it and reference the name. A plan that touches auth, billing, data or migrations gets `critical: true`. Any other plan carries `critical: false` or leaves the line out, since absent means false. A plan only some machines can run carries `needs:` in its frontmatter, comma separated words of `macos`, `linux`, `xcode`, `android`, `docker` and `node` per ctx-machine-facts; with no line, every machine meets it.

Recall comes before the first write of this step. Draft each plan's Outcome as a sentence in your reasoning, not in a file, and run `<playbook>/bin/skills recall` once per draft on its distinctive words, as step a says; only then write the ctx and plan files. A search run on a plan file already written is too late, since its result can no longer stop that file. A draft whose behaviour a DONE plan already landed, with the code confirming it still holds, is not written. A draft that revives a DROPPED plan names it in its `## Notes`, with why it was dropped and what changed since. The ctx file's `## Prior work` lists every DONE or DROPPED plan the step a and step b searches found that bears on the batch, one line each in the ctx shape above, or holds `None found.`. Each line says what the plan landed or why it was dropped, never that anything waits on that id, since `plans lint` fails a closed id after `until`, `once`, `pending`, `waits on` or `will be`. When every draft is already DONE, write no plan and no ctx, skip the steps below, and reply with each prior plan as `<Project>/<id> <slug>` beside its Landed lines.

**c. Unit sizing is a hard rule, and it is what sets the count.** At most three acceptance criteria and at most 4 KB per plan. A unit that needs more splits into two ids, so the count is whatever the work divides into under that cap. Check it with `<playbook>/bin/skills plans lint <Project>`, which fails a plan with no `surface:` value, with a `critical:` value other than `true` or `false`, over 4 KB above its `## Landed` heading, with more than three acceptance items, with a `needs:` word outside the capability set, or carrying a banned section. On a ctx file it also fails a line pointing forward at an id the index records as closed, and a line recording an intention with no id behind it.

Then run `<playbook>/bin/skills plans lint <Project> --overlap`. It reruns every open plan's `rg` probe commands read only, on the tree `/plans wave` probes, and prints `overlap <id> <id> <path>` for two plans whose hits share a path with no `blocked_by` chain between them, when at least one of the two has no index row yet. It also prints `unprobed <id>: <reason>` for each open plan whose probe could not run, since its overlaps went unchecked, and refuses two open plan files holding one id. Only an `overlap` line or a refusal fails it. Settle each `overlap` line in the plan files: give the plan with no row a `blocked_by` on the other, or merge the two when they are one change. Rewrite a probe that did not run, unless it names a path an earlier plan in the batch creates. Both checks pass before the step f row append, so a plan that fails never reaches `index.tsv`.

**d. One adversarial validation pass** over the written batch plus the ctx file, before any row is added. It runs on the lead's other family, read the way the playbook skill's `references/codex-arms.md` **Roster** reads an arm's: for a Claude lead, a sol arm per that skill's **Codex arms** section, `-s read-only`, slug `plans-<batch-slug>`, with `-C` pointed at the project's checkout; for a Codex lead, one read only `opus-review` arm started in that checkout. When the roster or the transports reach no second family, run the pass directly and say the batch had no reader outside the lead's family. The prompt:

```
Every plan and ctx file named below is in <absolute plans project directory>.
The code the batch plans against is origin/HEAD in the checkout you start in,
or its working tree when origin/HEAD does not exist. Judge what exists there.
Read ctx-<batch-slug>.md and every plan file in this batch.
For each plan: is every acceptance criterion independently verifiable by a
person with only this file, or does it rely on knowledge that is not written
down? Name the criteria that fail.
For each plan: name every path, package or symbol it relies on that does not
exist in that code and that no earlier id in this batch creates.
For each plan: name the open decisions, a product or behaviour choice the plan
leaves to whoever implements it (such as "admins or editors") that neither the
code nor the ctx file settles.
Across the batch: does any plan restate another plan, or restate the ctx file?
Name the duplicated pairs and which one should own the content.
Also flag any plan whose Outcome names zero destination surfaces or more than
one, any plan over 4 KB, and any plan carrying current code state, file:line
references, git workflow or a step list.
Report findings only. Do not rewrite the files.
```

Read the arm's output, its `-o` file or the harness task's result, and fold every finding into the plan files that the files alone can settle. A missing path the code answers, such as a package under another name, is one of those.

**e. One question round.** Each missing path the code cannot answer and each choice the pass found left unmade becomes one question, and every question goes in one `AskUserQuestion` call in Claude Code or one `request_user_input` call in Codex when the turn lists it, else in one final message whose first lines are the questions, after the step a destination question and never merged into it. Fold each answer into the plan it settles, then run both step c checks again. An answer changes a plan, never drops one: only the step a question can stop a plan being written. With no questions, skip the round.

**f. Append one row per plan with `<playbook>/bin/skills plans add <Project> <slug> <pri> <effort> <blocked_by> <ctx>`,** in id order, ending with `--resolves <Project>#<n>` for each plan whose `## Notes` names an inbox issue. It takes the id from the plan's file name and appends a TODO row with branch `-`. Rerun on a row it already added, it prints that row again. When another plan already holds the id, it refuses and names it: renumber the file, its `id:` line and every sibling or ctx reference to it, then run it again. Then stop.

Output: the paths written and the frontier delta, or, when every draft was already DONE, the prior plans and their Landed lines. Nothing else.

## Sections this format deliberately does not have

- **`## Current state`.** The drift engine. It is a snapshot of the code written at planning time, stale by the time the plan runs, and it teaches executors to trust it over the repo. Intent is durable, state is not. `## Probe` re-derives state at execution time.
- **`## Git workflow`.** Policy lives in the global agent instructions and applies everywhere. Restating it per plan means fifteen copies that can each drift out of agreement with the real rule.
- **`## Drift check`.** Replaced by `## Probe`. A `git diff --stat` against a planning time commit answers "did anything move", which is the wrong question. Ripgrep over symbols answers "is the thing I care about still there and still wrong", which is the question.
- **`## STOP conditions`.** Replaced by probe outcome c. One rule (symbols gone, stop and re-derive) beats a bespoke list per plan that nobody reads to the end.
- **`## Steps`.** The route decides steps at execution time, against the code as it exists then. A step list written days earlier is a guess with authority.
- **`## Commands you will need`.** They live in the acceptance criteria, attached to the claim each one proves, instead of floating in a section with no verdict attached.
