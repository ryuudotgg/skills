---
name: show-me-your-work
description: "Keep a reviewable decision trail for unattended work: a TSV log, one row per decision (project, plan, branch, evidence, result), local and uncommitted. Use for /show-me-your-work, autonomous runs, or work a human reviews later."
disable-model-invocation: true
---

# Show me your work

For work a human reviews after the fact, a decision trail lets them reconstruct what was decided, on what evidence, and how it turned out, without rerunning the work or reading the whole transcript. Keep one canonical log so the trail is consistent and a future agent can find it.

## The format

A single TSV file, one row per decision. TSV because `column -s$'\t' -t` and spreadsheets read it, and a row appends with one command. Cells stay single-line. Evidence is a pointer, not prose.

Copy `references/decision-log-template.tsv` (the header row) to start a clean log. Columns:

- **ts.** UTC ISO8601 timestamp. The timeline axis.
- **project.** The project name, the same one used for its backlog directory in the plans directory (default `~/Plans`, override with `PLANS_DIR`).
- **plan.** The plan this row belongs to, as `NNN-slug` matching `<plans dir>/<Project>/NNN-slug.md`. Write `none` for work with no plan behind it.
- **branch.** The `feat/*` branch the work sits on, so a row can be tied back to a diff.
- **evidence.** A link or path that proves it: a `file:line`, a script path, an artifact, a trace, a screenshot. Never a paragraph.
- **result.** What happened, in plain words: what was chosen or done and how it came out. `moved read state to the server, tests green`, `reverted, screenshots were blank`, `INCONCLUSIVE`, `open`.

An example, plain-spoken so a reviewer reads it at a glance. This is illustration only; don't copy these rows into a real log.

```
ts	project	plan	branch	evidence	result
2026-05-24T09:02:00Z	widgets	047-notify-queue	feat/notify-queue	docs/notify-queue.md	counted the work first, about 100 call sites and 5 things to sort out before starting
2026-05-24T09:40:00Z	widgets	047-notify-queue	feat/notify-queue	scripts/snapshot.sh, baseline/	took 120 reference screenshots of the old version so old and new can be compared
2026-05-24T11:15:00Z	widgets	047-notify-queue	feat/notify-queue	src/notify/queue.ts:88	moved the widget styles over without changing how it looks, pixel diff 0, tests pass
2026-05-24T12:30:00Z	widgets	047-notify-queue	feat/notify-queue	/tmp/figure-it-out/notify-queue/worker-2/	threw out a helper's work because its screenshots were blank, reverted and tightened the instructions
```

## Logging a row

Write each entry the way you'd tell a teammate what you did. Plain words, concrete actions, no AI speak or abstract jargon (the **unslop** skill applies to log text too). A reviewer should understand each row without decoding it.

Use the helper so rows stay well-formed: `scripts/log.sh <logfile> <project> <plan> <branch> <evidence> <result>`. It takes the log path as its first argument, so it writes wherever you point it and hardcodes no directory. It stamps `ts` in UTC, writes the header on first use, strips stray tabs, newlines, and carriage returns, and prefixes any cell starting with `=`, `+`, `-`, or `@` with a single quote so a reviewer opening the log in a spreadsheet doesn't trigger formula execution. A bare `printf` appending a row works too, but mind those same bytes if cells come from generated or user-supplied text.

Log decision points and checkpoints, not every action: a fork chosen, a unit completed with its verification result, a pivot or revert with its trigger, a blocker surfaced, a gate fixed. For loop runs, one row per iteration. Skip the trivial and self-evident.

## Where it lives

The log is a working artifact that stays out of the task's commit and PR in either delivery mode. Keep it at `decisions.tsv` in the work dir, or `.audit/<task-slug>.tsv` when several efforts run at once. Name its path in the reply so the reviewer can open it. The local log keeps the run honest and can be discarded after.

## Rules

- One row is one decision or checkpoint. If it doesn't fit on one line, the decision isn't crisp yet.
- Append-only. A wrong call gets a new row that supersedes it. Never edit or delete history.
- Prefer evidence produced by a script that lives in the repo over a hand-made one-off, so a reviewer can re-run it (the **encode-lessons-in-structure** principle skill).

## Audit the log against the transcript

At the end of the run, before handing back, check the log told the truth. In Claude Code this run's transcript is at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, where the encoded cwd is the working directory with every `/` turned into `-`. A run in `/home/you/code/widgets` reads from `~/.claude/projects/-home-you-code-widgets/`. Other agent tools store transcripts elsewhere; find this session's file before auditing against it.

Read only the one `.jsonl` whose name is this session's id. A `memory/` directory sits in that same project directory, so a naive glob picks up files that are not transcripts. Never glob across `~/.claude/projects/*/`; that reads unrelated private chats.

Walk the log against what actually happened:

- Every row maps to a real action. An invented or aspirational row gets a superseding row that says so.
- Each row's evidence resolves and shows what the row claims. If it does not, append the row that says what the evidence actually shows.
- A fork, pivot, or abandoned approach that shaped the work but isn't logged is a gap. Add it.
- Padding is a lesson for the next run, not an edit. Rows stay; the fix is to log decision points only from here on.

Fix the log, not the story. If the work diverged from what a row claims, append the row that says what actually happened. The wrong row stays as history, which is what makes the trail auditable.

## Reviewing the trail

Read top to bottom, follow the evidence pointers, spot-check. `column -s$'\t' -t decisions.tsv` renders it in a terminal. A row whose evidence doesn't resolve, or whose result is unverified, is the audit catching a gap.

## Composing this skill

Other skills route their audit trail here instead of inventing one. Reference it by name and let it own the format; don't restate the columns.
