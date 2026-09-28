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
| `OUTSIDE_DIFF` | optional, the heading a reviewer's outside diff block opens with |
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

## Matching

- A login matches exactly, case insensitive. A human named `greptile-fan` is never a reviewer.
- A handle matches anywhere in a body, case insensitive, as a fixed string. `@greptile` catches `@greptileai` and `@greptile-apps`.
- A trigger matches the whole comment body exactly.
- A check matches when its name contains `CHECK`, case insensitive.

## Presence

A reviewer is present on a PR when its `CHECK` is a CheckRun or commit status context on any commit of the PR, or one of its `LOGINS` authored a review or comment, or edited the PR body. Read presence from GitHub, never from the repo or config. The `grace-minutes` setting gives the reviewer time to appear after the PR opens or the last trigger. After that grace, `absent` means the reviewer has nothing to say on the PR. It counts toward the handoff state like `done`. Post nothing, not even a trigger.

## Reviewer threads

A reviewer thread is a review thread an active reviewer's login started, in which every comment comes from the active reviewers' combined `LOGINS`. Another bot commenting in it keeps it a reviewer thread. The agent posts as the operator's account, so its reply and a human's look the same: `reply.sh` posts and resolves in one step, and a thread holding any other login is a draft for the operator from then on.

In prs mode, with a reviewer active:

- `../scripts/reply.sh <pr> <url> <file>` posts the file as a reply in a reviewer thread and resolves it. It refuses before any write on a resolved thread, a thread that is not a reviewer thread, an empty body, or a body naming an installed reviewer's handle.
- `../scripts/resolve.sh <pr> <url>...` resolves each reviewer thread a pushed commit fixed and leaves open any with a reply from another login.
- The comment guard lets a top level `gh pr comment <n> --body "<trigger>"` through only for an active reviewer's `TRIGGER`. Whether to spend one is the reviewer skill's decision.

Everything else about publishing is `delivery.md`'s.
