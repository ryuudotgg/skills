## 1.1.0

*November 7, 2026*

### 🚨 Heads up

- **Stacked publishing needs `gh stack` 0.2.0 or later** ([#204](https://github.com/ryuudotgg/skills/pull/204))\
  `skills publish` refuses to publish a stacked layer with an older `gh stack`, so run `gh extension upgrade stack` before the next one.
- **Stack verbs and the audit see hand edits only after an import** ([#198](https://github.com/ryuudotgg/skills/pull/198))\
  After a hand edit to `index.tsv` or `log.tsv`, run `skills plans import` before `fix-round`, `restack-layer`, `lease-rebase`, `pr retitle` or `skills audit`, since they now read the plans store.
- **Plans writes go through the store, so hand edits to the views refuse** ([#197](https://github.com/ryuudotgg/skills/pull/197))\
  `plans add`, `plans set-row`, `plans start`, `plans close`, `plans sweep`, `plans log` and `threads log` now record every change in `plans.db` and then rewrite `index.tsv` and `log.tsv` from it, importing the plans directory on first use. A hand edit to either file makes the next write refuse until `skills plans import` takes it in, and `plans log` refuses an event name outside the trail's set.

### ✨ New

- **Every plan keeps its history** ([#200](https://github.com/ryuudotgg/skills/pull/200))\
  Each plans verb that reads a plan or ctx file keeps its text in `plans.db`, across the move into `done/`. `skills plans history` lists those versions, `skills plans show --at <time>` prints one, and `skills plans checkout` restores a plan file that went missing.
- **Choose auto updates in `./install.sh`** ([#192](https://github.com/ryuudotgg/skills/pull/192))\
  At a terminal the installer asks whether skills updates itself, off, notify or on, right after the delivery mode, and saves the answer as `AUTO_UPDATE`. `--auto-update off|notify|on` sets it without a prompt, and a run that cannot ask prints a note while the choice is unset or invalid.
- **Frontier at a past time** ([#201](https://github.com/ryuudotgg/skills/pull/201))\
  `skills plans frontier --at <time>` prints the frontier as the store held it at that time, alone or with `--next` or `--stacks-on`, and refuses a time before the store first held the project.
- **`skills plans import` builds the plans store** ([#196](https://github.com/ryuudotgg/skills/pull/196))\
  `skills plans import` copies every index, trail line, plan and ctx file into `plans.db` at the root of the plans directory and proves both views render back byte for byte, and a rerun adds only what changed. Nothing reads the store yet, so every other plans verb behaves as before.
- **Update the checkout with `skills update`** ([#191](https://github.com/ryuudotgg/skills/pull/191))\
  `skills update` moves the skills checkout to the newest verified release on main and reruns the installer, and `skills update --check` says whether one is waiting. It refuses, changing nothing, when the checkout has local work, and puts the old release back if the installer fails.
- **Session start checks for updates** ([#193](https://github.com/ryuudotgg/skills/pull/193))\
  With `AUTO_UPDATE` at `notify` or `on`, session start runs `skills update --check`, or `skills update` under `on`, in the background once a day and shows its result on the next session start, and with the key unset it says so once a day. Claude Code and Codex also show the notice to you directly.

### 🎨 Improved

- **The docs explain the plans store** ([#203](https://github.com/ryuudotgg/skills/pull/203))\
  The Plans page says where `plans.db` lives, that `index.tsv` and `log.tsv` are views, what the first verb after an update imports, how `skills plans import` clears a refused view, and how `show`, `history`, `checkout` and `frontier --at` read the past. The session brief page says the brief reads the store.
- **New comments are settled before the code ships** ([#194](https://github.com/ryuudotgg/skills/pull/194))\
  In Claude Code and Codex the commit guard lists new comment lines once before an allowed commit, `skills publish` or `skills fix-round`, so they get deleted or kept before the push instead of after the final reply. A comment already flagged when it was written is not listed again.
- **A blocked reply comes back whole** ([#194](https://github.com/ryuudotgg/skills/pull/194))\
  When the reply guard blocks, the agent sends its whole reply again and says nothing about the check, so the last message of the turn is the one worth reading.
- **Plans readers work from the store, with or without the views** ([#199](https://github.com/ryuudotgg/skills/pull/199))\
  `plans frontier`, `plans handoff`, `plans wave`, `plans resume`, `threads resume`, `plans lint`, the brief, the sweep, `plans release`, `skills reap` and the session start hook read rows and the trail from `plans.db`, so they keep working when `index.tsv` or `log.tsv` is missing. A store that cannot open makes them refuse with the reason, and `plans sweep`, `plans release` and `skills reap` also refuse while a view holds an edit made outside the store.
- **Agent edits to plans are kept as revisions** ([#202](https://github.com/ryuudotgg/skills/pull/202))\
  An agent's edit to a plan or ctx file in Claude Code, Codex or OpenCode now lands in `skills plans history` as its own version. When `plans.db` is busy the edit waits in `.revisions-spool/` and is recorded the next time the store opens.
- **Each release installs its own dependencies** ([#205](https://github.com/ryuudotgg/skills/pull/205))\
  `./install.sh` installs the CLI's runtime dependencies before any of its code runs. From this release on, `skills update` leaves that step to the `install.sh` of the release it moves to, or on rollback the one it returns to.
- **`skills install` without `@clack` names `./install.sh`** ([#205](https://github.com/ryuudotgg/skills/pull/205))\
  Running `skills install` straight from a checkout whose dependencies are missing now refuses and names `./install.sh`, instead of installing `@clack` and restarting itself.
- **Eval snapshots leave the plans store out** ([#198](https://github.com/ryuudotgg/skills/pull/198))\
  An eval's `plans-after` snapshot keeps the text views and drops `plans.db`, so graders read what they read before.

### 🐛 Fixed

- **`skills publish` stacks a layer from a linked worktree** ([#204](https://github.com/ryuudotgg/skills/pull/204))\
  `skills publish` reads the stack state `gh stack` shares across worktrees, and adds a new layer from the worktree that holds its parent instead of failing on `gh stack init`.
- **Comment check skips comments from the branch it was cut from** ([#190](https://github.com/ryuudotgg/skills/pull/190))\
  On a branch cut from another branch such as `staging` with no recorded `skills-base`, the Stop hook lists only the comments this branch adds instead of every comment its parent holds over `main`, and names the base it diffed from.

## 1.0.0

*October 30, 2026*

### ✨ New

- **Versioned releases** ([#187](https://github.com/ryuudotgg/skills/pull/187))\
  Each release gets a `v<version>` tag and a GitHub release listing what changed, starting at 1.0.0.

### 🧰 Internal

- **Release through Tegami** ([#187](https://github.com/ryuudotgg/skills/pull/187))\
  Running the Release workflow on main opens a version PR from the notes in `.tegami/`, and merging it tags the release. Every PR now needs a note to pass the required Tegami Note check, and the Releases section of `AGENTS.md` says how to write one.
