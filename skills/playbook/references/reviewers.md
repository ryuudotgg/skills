# Reviewers

A reviewer is a review bot the prs fix round works with, Greptile for example. It ships as an extension skill (`optional: true`, `requires: prs`) whose directory holds a `reviewer.conf`, and that file alone is what makes it a reviewer. Nothing outside a reviewer's own directory spells its login, handle or trigger: every shared script reads them through `../scripts/reviewers.sh`.

## The declaration

`reviewer.conf` holds one `KEY=value` per line. Blank lines and `#` lines are skipped. It is read with grep, never sourced.

| key | what it holds |
| --- | --- |
| `NAME` | the display name refusals print, `Greptile` |
| `LOGINS` | every login the bot posts under, space separated, in GraphQL form (`greptile-apps`) and REST form (`greptile-apps[bot]`) |
| `HANDLES` | each mention that summons the bot, space separated |
| `TRIGGER` | the one whole comment body that asks for a re-review, `@greptileai` |
| `CHECK` | the CheckRun or commit status context name, `Greptile Review` |
| `OUTSIDE_DIFF` | optional, the heading a reviewer's outside diff block opens with; non empty when present |
| `SETTING_<NAME>` | a setting's default and allowed ERE, separated by one space |

The first five keys are required, once, and non empty. A login is letters, digits and hyphens, with an optional `[bot]` suffix, and each bot is declared in both forms, plain and `[bot]`, so neither form goes unmatched. Nothing checks that a declared login belongs to a bot: a declaration is trusted like the scripts beside it, and a person's login in `LOGINS` makes that person's comments count as the reviewer's. A handle starts with `@`, and `TRIGGER` starts with one of the reviewer's own handles. A repeated key, a line that isn't `KEY=value`, or any of the rules above broken is a defect. A defect in any installed declaration fails `reviewers.sh` for every caller, and each caller then refuses: a broken file never widens what the agent may write.

`reviewers.sh [--active] <KEY>` prints `<name>\t<value>` per reviewer, sorted by directory name.

## Settings

`reviewers.sh [--active] --settings` prints `<reviewer>\t<setting>\t<default>\t<ERE>` in reviewer directory order and setting declaration order. Setting names are lowercase with hyphens. `--active` keeps only active reviewers.

Every reviewer declares `SETTING_ROLE=required required|advisory` or `SETTING_ROLE=advisory required|advisory`. Each setting key matches `SETTING_[A-Z][A-Z0-9]*(_[A-Z0-9]+)*`. Its default must be non empty, have no whitespace, and full match the ERE after the first space. An invalid ERE, missing role, or two declarations claiming the same skills config key is a defect.

`../scripts/settings.sh <reviewer>` prints `setting=value` in declaration order. It reads the default from `reviewer.conf`, then `<REVIEWER>_<SETTING>=value` in the skills config, then `git config --local skills.<reviewer>.<setting>` in the current repo. The last valid value wins. A value must be non empty, occur exactly once in its layer, have no CR or newline, and full match the ERE. Invalid and duplicate values get stderr notes and leave the prior value in place. An inactive reviewer's overrides get notes and do not apply. Unknown settings keys in the skills config get notes.

## Installed and active

**Installed** means the skills tree the playbook resolves to (its real path, so the repo when `install.sh` linked it) holds the reviewer's directory. **Active** means `delivery-mode.sh` lists it, which needs prs mode and a `WITH` entry.

| reader | reads | from |
| --- | --- | --- |
| `reply.sh`, `resolve.sh` | `LOGINS` | active reviewers |
| `reply.sh` handle guard | `HANDLES` | every installed reviewer |
| `below.sh`, the `/plans do` preflight | `LOGINS`, for who started the thread | every installed reviewer |
| the comment guard hook | `TRIGGER` | active reviewers, installed ones for the refusal |
| the watcher's review column | `CHECK` | every installed reviewer |

The handle guard reads installed declarations because a mention summons the bot on any repo that runs it, whatever `WITH` lists. The preflight does too, and it looks only at who started a thread: an unresolved thread a reviewer started holds the stack even after a human joined it, or while that reviewer is inactive, until the operator clears it.

`review-read.sh` and `watch-pr` read `OUTSIDE_DIFF` from every installed reviewer, active or not.

## Matching

- A login matches exactly, case insensitive. A human named `greptile-fan` is never a reviewer.
- A handle matches anywhere in a body, case insensitive, as a fixed string. `@greptile` catches `@greptileai` and `@greptile-apps`.
- A trigger matches the whole comment body exactly.
- A check matches when its name contains `CHECK`, case insensitive.

## Presence

A reviewer is present on a PR when its `CHECK` is a CheckRun or commit status context on any commit of the PR, or one of its `LOGINS` authored a review or comment, or edited the PR body. Read presence from GitHub, never from the repo or config. The `grace-minutes` setting gives the reviewer time to appear after the PR opens or the last trigger. After that grace, `absent` means the reviewer has nothing to say on the PR. It counts toward the handoff state like `done`. Post nothing, not even a trigger.

## The round

`../scripts/round.sh` is the one entry point babysit and `/plans review` call. Nothing else runs a single reviewer's gate or decide scripts.

```
round.sh gate <pr> [--wait] [critical=true]
round.sh decide <pr> <branch> [critical=true] [<reviewer>=fixed|<reviewer>=dismissed ...]
```

For each active reviewer it runs `<reviewer>/scripts/verdict.sh` with the same phase. That script is the reviewer's own adapter over its gate and decide scripts, and every reviewer ships one; `scripts/validate.py` fails a `reviewer.conf` without it. It prints one verdict line. The gate phase reads the PR as it stands. The decide phase runs after the round's push and reads the pushed head fresh: a `<reviewer>=` argument names each reviewer whose gate said `triage`, and whether the round fixed at least one of its findings or dismissed them all. Every reviewer whose gate said `triage` gets one, and a triage with no findings counts as `dismissed`. A reviewer with no such argument had nothing triaged, so its decide reruns its gate. Both phases take `critical=true` when the plan's frontmatter says `critical: true`, or when the operator asked for 5/5 on a PR outside `/plans`; each reviewer reads it as its stricter floor.

It prints `<reviewer> <role> <verdict>` per reviewer, then one combined line. With no active reviewer it prints only `done` and calls no `gh`. A reviewer script that fails or prints anything outside the verdict vocabulary reads as `handback refused`, its stderr passed through. A defective declaration makes `round.sh` itself refuse.

**Roles.** A required reviewer holds the layer. An advisory reviewer's `triage` still joins the round, and its `wait`, `rereview` and `handback` never change the combined line. When no reviewer is required, or every required one says `absent`, the advisory ones count as required and the role printed says so. A required reviewer still inside its grace period (`wait absent`) promotes nobody, so an advisory reviewer's rate limit never hands back a layer whose required reviewer has not had its chance. `--wait` reaches only the reviewers counted as required.

**The fold**, over the counted verdicts, first match wins:

| counted verdicts include | combined |
| --- | --- |
| a `handback` | `handback <reviewer> <reason>`, the first in directory order |
| a `triage` | `triage` |
| a `rereview` | `rereview` |
| a `wait` | `wait` |
| only `done` and `absent`, or nothing | `done` |

`absent` meets the handoff state like `done`. The combined line carries no reason for `done`: a detail the handback must name, Greptile's `done large-fix` say, is on the reviewer's own line.

**Acting on it.**

| combined | babysit, `drive` or `threads-only` | `/plans review` |
| --- | --- | --- |
| `done` | The layer meets the reviewer half of the handoff state. | Nothing more from the reviewers this round. |
| `triage` | After the gate, triage every reviewer line that says `triage` in one fix round. After decide, run the next round. | The same, in this turn. |
| `rereview` | Post the triggers, then run the next round with the gate's `--wait`. | Post the triggers, then run the next round in this turn, gate with `--wait`. |
| `wait` | Run the next round; `--wait` already polled. | Report which reviewers have not finished. |
| `handback` | The layer is not at the handoff state: the babysit stops there. Report the reason. | Report the reason. |

**Triggers.** After decide, and only when the combined line is not a `handback`, post the trigger of each reviewer whose own line says `rereview`, advisory ones included, as its own command: `gh pr comment <pr> --body "<trigger>"`, the trigger read with `../scripts/reviewers.sh --active TRIGGER`. A trigger is never a question for the operator. The budget, the thresholds and what each verdict reason means stay in the reviewer's own skill.

## Reviewer threads

A reviewer thread is a review thread an active reviewer's login started, in which every comment comes from the active reviewers' combined `LOGINS`. Another bot commenting in it keeps it a reviewer thread. The agent posts as the operator's account, so its reply and a human's look the same: `reply.sh` posts and resolves in one step, and a thread holding any other login is a draft for the operator from then on.

In prs mode, with a reviewer active:

- `../scripts/reply.sh <pr> <url> <file>` posts the file as a reply in a reviewer thread and resolves it. It refuses before any write on a resolved thread, a thread that is not a reviewer thread, an empty body, or a body naming an installed reviewer's handle.
- `../scripts/resolve.sh <pr> <url>...` resolves each reviewer thread a pushed commit fixed and leaves open any with a reply from another login.
- The comment guard lets a top level `gh pr comment <n> --body "<trigger>"` through only for an active reviewer's `TRIGGER`. Whether to spend one is the reviewer skill's decision.

Everything else about publishing is `delivery.md`'s.
