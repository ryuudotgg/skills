## 1.5.2

*November 26, 2026*

### 🐛 Fixed

- **Commit guard follows grouped producers and GNU parallel** ([#612](https://github.com/ryuudotgg/skills/pull/612))\
  The commit guard now blocks a commit or push that `xargs` builds from a group of `echo` and `printf` commands or past a redirect such as `-n 2>/dev/null 1`, and one GNU `parallel` builds from its `:::` arguments or piped lines, while jobs such as `parallel gzip ::: a.log` still pass.
- **Released checkouts look inside ignored folders** ([#614](https://github.com/ryuudotgg/skills/pull/614))\
  `skills plans release` frees a checkout whose ignored folder holds only disposable entries or empty folders, such as a removed workspace that keeps its `node_modules` or a `.wrangler/` with only `tmp/` in it.

## 1.5.1

*November 26, 2026*

### 🐛 Fixed

- **Comment scan reads YAML lines of any length** ([#608](https://github.com/ryuudotgg/skills/pull/608))\
  The edit guard and the stop sweep no longer throw or slow down on a YAML line of hundreds of kilobytes, and still report the comment lines that follow it.
- **Commit guard reads locale strings and split git words** ([#611](https://github.com/ryuudotgg/skills/pull/611))\
  The commit guard now blocks a commit or push whose git verb is spelled as a locale string, such as `git $"push"`, or that a producer piped to a shell prints from pieces, such as `printf g$'it push' | sh`.
- **Sweep closes a stacked layer merged onto the default branch** ([#609](https://github.com/ryuudotgg/skills/pull/609))\
  `plans sweep` closes a row whose PR still names a deleted parent branch as its base once that PR's own merge commit is on the default branch, stamping its own merge, where it used to print `elsewhere`.

## 1.5.0

*November 25, 2026*

### ✨ New

- **Close a plan that shipped outside the repo** ([#602](https://github.com/ryuudotgg/skills/pull/602))\
  `skills plans close <Project> <id> DONE <note> --no-merge` closes a plan whose change shipped outside the repo, such as a production setting, and stamps its landed draft `Closed without a merge (branch <branch>).` instead of a merge. It refuses while the branch holds a commit the default branch lacks or has its own PR open or merged.

### 🎨 Improved

- **`/plans close` says what it reads and refuses** ([#600](https://github.com/ryuudotgg/skills/pull/600))\
  The `/plans close` instructions now say that a DONE close stamping a landed draft reads the default branch from origin and the row's own PRs, stamps the newest merge into the default branch, refuses a landed draft naming another branch, and that a dry run prints the stamped line as `landed: <merged line>`.
- **Moving a Plan explains a move still waiting on the hub** ([#596](https://github.com/ryuudotgg/skills/pull/596))\
  Moving a Plan now explains `move: the move waits to reach the hub, run skills hub sync`: the sync runs on the machine the plan is leaving before the target adopts, and a store that sync finds restored or copied keeps the move off the hub until its recovery steps are done. Pause safely runs that sync before naming the adopt command.
- **Stacking text says what `plans start` and `fix-round` refuse** ([#597](https://github.com/ryuudotgg/skills/pull/597))\
  `/plans do` and the fix round now say that `plans start` checks the layers below and refuses on an open reviewer thread there, fixing nothing, and that `fix-round` refuses any layer above whose row is DOING.
- **Plan template names `critical:` as optional** ([#597](https://github.com/ryuudotgg/skills/pull/597))\
  The plan file template lists `needs:` and `critical:` as the optional frontmatter lines, with an absent `critical:` meaning false.
- **Hub status names every problem line to report** ([#597](https://github.com/ryuudotgg/skills/pull/597))\
  The hub skill lists all five problem lines `skills hub status` can print, the revoked and unknown device lines included, and leaves each repair to the operator.
- **Greptile replies point at the reviewer thread rules** ([#597](https://github.com/ryuudotgg/skills/pull/597))\
  Greptile's reply step points at the reviewer thread rules for every reason `skills review reply` refuses a body.

### 🐛 Fixed

- **Reap leaves container runtimes running** ([#603](https://github.com/ryuudotgg/skills/pull/603))\
  `skills reap` no longer stops OrbStack, Docker Desktop or another container runtime that listens on a port it forwards for a plan's container, which took Docker down whenever the runtime had been started from a plan's checkout. The plan's containers are still reaped through their compose project.
- **Reap still stops plan servers named like a runtime** ([#605](https://github.com/ryuudotgg/skills/pull/605))\
  `skills reap` now recognises container runtimes by their exact process names, so a plan's own server whose name only starts like one, such as `colima-api`, is reaped as before.

### 🧰 Internal

- **Check tests build only the files their rule reads** ([#601](https://github.com/ryuudotgg/skills/pull/601))\
  The single rule cases in `check.test.ts` write a small root of their own instead of copying the whole tracked tree, so the file runs in about half the time.
- **The version PR follows main** ([#604](https://github.com/ryuudotgg/skills/pull/604))\
  The Release workflow runs for every note pushed to main and updates the version PR, so it holds every pending note without a manual run.
- **Publish tags past a late note** ([#604](https://github.com/ryuudotgg/skills/pull/604))\
  Publish warns about a note merged after the version PR was cut and tags the release anyway, so the next version lists that note and no revert is needed.
- **Run dashboard test files in parallel** ([#607](https://github.com/ryuudotgg/skills/pull/607))\
  The dashboard suite runs its files with `--parallel`, which cuts it from about 58 s to 38 s locally and lets a failing file get the flaky rerun, and the live view's bun, dashboard and hub estimates match measured run times.
- **Diff selection covers every live test input** ([#598](https://github.com/ryuudotgg/skills/pull/598))\
  `skills test` on a diff now runs `bun` when only a playbook, an arms reference, CONTRIBUTING.md, an app manifest, a hub compose file or a bun eval case changed, and `dashboard` for every CLI module the spawned CLI loads, which a closure test in selection.test.ts keeps in step. The owner restatement test writes its own `do.md` and `review.md`, and the PTY tests find greptile wherever it sorts among the optional skills.
- **Eval and audit docs match the code** ([#599](https://github.com/ryuudotgg/skills/pull/599))\
  evals/README.md says a run records its `eval` event in the real plans store and names the evidence behind each hide verdict, and CONTRIBUTING.md lists `scripts/audit-memory.ts` with the manual verifiers.
- **Session folder helpers with no caller are gone** ([#599](https://github.com/ryuudotgg/skills/pull/599))\
  `projectsDir` and `encodedProjectDir` leave packages/cli/src/sessions/claude.ts, and audit.test.ts builds its session folders from `encodedName`.

## 1.4.1

*November 24, 2026*

### 🎨 Improved

- **Hub docs explain which project files sync** ([#558](https://github.com/ryuudotgg/skills/pull/558))\
  The Hub page says which project files sync carries, how a `.plansignore` keeps one on this machine, which files it skips and what it prints when both machines changed a file.
- **Machines page covers every adopt refusal and test devices** ([#575](https://github.com/ryuudotgg/skills/pull/575))\
  The Machines page lists all six refusals `skills plans adopt` makes, explains how to move a plan back to a machine it left, and has a Test Devices section on `skills device` and what `skills reap` cleans up.
- **Help after any verb prints its usage** ([#586](https://github.com/ryuudotgg/skills/pull/586))\
  `skills <verb> --help` now prints that verb's usage line and exits 0 without running the verb or syncing, for every verb. `skills pr watch --help` and `skills audit --help` keep their fuller help.
- **Hub sync skips the digest of a finished session** ([#514](https://github.com/ryuudotgg/skills/pull/514))\
  A long `skills hub sync` reads a finished session's transcript cursor without its digest, and loads the digest only once the transcript has new lines to cut.
- **Stack verbs start fewer git processes** ([#526](https://github.com/ryuudotgg/skills/pull/526))\
  `skills lease-rebase`, `skills restack-layer` and `skills fix-round` read the git common dir, the checkout's git dir and `core.bare` once per run, where every holder check used to read all three again. Each check still finds the holder and reads its HEAD afresh, and what the verbs print is unchanged.
- **`skills hub join` enrolls a store whose device keys are gone** ([#576](https://github.com/ryuudotgg/skills/pull/576))\
  On a store whose device keys did not come with it, `skills hub join` now holds the old device, joins under the invite as a new device and names the old one to revoke, the way `skills hub recover` does, instead of refusing that the keys are missing.
- **A rerun move keeps the chunks that did not change** ([#567](https://github.com/ryuudotgg/skills/pull/567))\
  Running `skills plans move` again after a failed upload sends only the pack chunks that changed or that the hub lacks, even when a new session id or an edit changed the pack since the last attempt.
- **Adopt fetches a hub pack's chunks together** ([#556](https://github.com/ryuudotgg/skills/pull/556))\
  `skills plans adopt` now downloads a hub pack's chunks several at a time instead of one after another, so adopting a large move waits on a few rounds of requests rather than one per chunk.
- **Recall reads only the plan copies that changed** ([#579](https://github.com/ryuudotgg/skills/pull/579))\
  `skills recall` and a long `skills hub sync` now read only the plan and ctx copies whose size or times changed since they were last recorded, so a recall over a large plans directory starts searching sooner.
- **Sol and astra arms run GPT-6.2** ([#593](https://github.com/ryuudotgg/skills/pull/593))\
  Sol arms and the review arm now run `gpt-6.2-sol`, and astra arms on critical work run `gpt-6.2-astra`, both at `high` effort. Terra and luna keep `gpt-6.1-terra` and `gpt-6-luna`, which have no 6.2 release.
- **`skills reap` and `skills device` work offline** ([#546](https://github.com/ryuudotgg/skills/pull/546))\
  Both read the default branch from the checkout's `origin/HEAD` and ask the remote only when it is unset, so a handback reaps and a device is found again with no network, a failing SSH agent or an unreachable origin.
- **Quiet syncs send queued events in batches** ([#524](https://github.com/ryuudotgg/skills/pull/524))\
  A quiet hub sync sends its queued events in as few requests as its 2 seconds allow, so a write verb no longer follows up with one request per event when the hub's speed is unknown.
- **Expired invites leave the store** ([#562](https://github.com/ryuudotgg/skills/pull/562))\
  An invite nobody used is deleted once it is more than five minutes past its expiry, and a sync with no live invite left stops asking the hub for pending joins.
- **Faster follow-up fixes in `skills audit --prs`** ([#591](https://github.com/ryuudotgg/skills/pull/591))\
  `skills audit --prs` runs one `git blame` per file a fix or revert PR changed instead of one per hunk, so the follow-up fixes table comes back sooner with the same values.
- **An idle `skills hub sync` skips files and leases that cannot have changed** ([#548](https://github.com/ryuudotgg/skills/pull/548))\
  A sync with nothing to send learns that a plans file is unchanged from its size and time without opening it, and settles only the leases it holds or could still hold on the hub, so the quiet sync after each write verb does far less disk and key work on a large plans folder.
- **Trail writes append instead of rewriting the log** ([#570](https://github.com/ryuudotgg/skills/pull/570))\
  `skills plans log`, `start`, `close` and the other trail writes add their lines to the end of `log.tsv` instead of rebuilding it from every trail event, so they stay quick as the trail grows. Anything that could leave the file out of step with the store still rebuilds it in full.
- **`skills hub status` lists each open conflict** ([#541](https://github.com/ryuudotgg/skills/pull/541))\
  Under its `conflicts <n>` line, status names every file this machine kept against a pulled edit, with the `skills plans show --conflict` command for a plan or ctx copy, so a conflict recorded by the sync that runs after a plans verb is no longer seen only as a count.
- **Round gate and decide end inside a foreground call** ([#519](https://github.com/ryuudotgg/skills/pull/519))\
  `skills round gate --wait` and a polling `skills round decide` stop at drive's cap, 570 s by default under `ROUND_DRIVE_CAP`, and clamp every read to 25 s past it, so one call returns within ten minutes and prints `wait` while a reviewer is still pending.
- **`skills hub sync` says what is left to pull** ([#549](https://github.com/ryuudotgg/skills/pull/549))\
  A `skills hub sync` that runs out of time while pulling ends its `left` line with `to pull <n> events, <n> blobs`, so a machine catching up on a large store sees those counts fall from run to run.
- **Frontier graph shows open plans only** ([#573](https://github.com/ryuudotgg/skills/pull/573))\
  The frontier graph draws open plans and open issues, leaving out done and dropped plans and their blocker lines, so the counts in its label match the picture.

### 🐛 Fixed

- **A long sync no longer starts a blob it cannot finish after one slow request** ([#520](https://github.com/ryuudotgg/skills/pull/520))\
  `skills hub sync` takes its rate only from uploads that outlast a round trip, so one slow small request no longer makes a short upload look fast and send a blob the link aborts. A shorter upload only lifts a slower saved rate, a blob judged by that alone waits for the next run instead of stopping as too slow, and the calibration resend uses the largest pushed blob up to 1 MiB so it measures the link wherever it can.
- **The commit guard reads ANSI-C quoted git subcommands** ([#522](https://github.com/ryuudotgg/skills/pull/522))\
  A git subcommand spelled with `$'...'` quoting, such as `git $'push'`, `git $'p'ush` or `git $'\x70ush'`, is now judged as the subcommand the shell runs in both modes, so pushes, commits, merges and pulls written that way are blocked like their plain spelling.
- **`skills hub sync` still sees a project whose `index.tsv` is missing** ([#543](https://github.com/ryuudotgg/skills/pull/543))\
  A project folder the store knows keeps syncing while its `index.tsv` is gone from disk, so an edit to a plan, a ctx file or any other file saved beside the missing view reaches the other machines instead of waiting for the view to come back.
- **`plans start` leaves batch members and BLOCKED rows alone** ([#511](https://github.com/ryuudotgg/skills/pull/511))\
  `skills plans start <Project> <id>` refuses a row DOING on a batch branch, so the member keeps its commits and its PR, and tells a BLOCKED row why it cannot start by quoting its note.
- **`skills device android` stops the emulator it gave up on** ([#551](https://github.com/ryuudotgg/skills/pull/551))\
  When the emulator it started never shows up in adb, turns out to run another AVD or never finishes booting, the refusal prints only after that emulator has exited, so the next call finds the AVD unlocked. An emulator that was already running is left alone.
- **Restack refuses a raced push without promising a rerun** ([#517](https://github.com/ryuudotgg/skills/pull/517))\
  When another push moves the branch while `skills restack-layer --push` is pushing it, the refusal now says origin moved since the rebase began and how to sync or drop the restack, and the rerun hint only follows an origin that could not be read.
- **Adopt takes files with any name and any count** ([#561](https://github.com/ryuudotgg/skills/pull/561))\
  `skills plans adopt` now adopts a pack with a file named like git pathspec magic, such as `:(review)`, and a pack of any size, where it used to stop with `git ls-files failed`. Its `already adopted here` answer also settles two adoptions on one clock tick the same way on every machine.
- **Hook prune stays quiet about personal files** ([#580](https://github.com/ryuudotgg/skills/pull/580))\
  An install or auto update no longer prints a `skip` line for files, links or folders in `~/.claude/hooks` that this repository never shipped, and leaves them where they are. A retired hook copy the prune reaches still gets its `skip` or `prune` line.
- **Commit guard blocks merges and pulls that commit** ([#513](https://github.com/ryuudotgg/skills/pull/513))\
  `git merge` and `git pull` are blocked in both modes when they can create a commit, so hands-off mode really blocks every commit. Prs mode points to `git merge --no-commit` then a shaped `git commit -m`, or to `git pull --ff-only`, and those forms, `git merge --squash` and `git merge --abort` still pass.
- **Forms that cannot commit pass only typed alone** ([#513](https://github.com/ryuudotgg/skills/pull/513))\
  `git cherry-pick -n`, `git revert --no-commit`, `git merge --ff-only` and the other forms that cannot commit pass only as one literal command, so a redirect, a chained command, a later `--` or a shell expansion can no longer slip `--commit` past the commit guard.
- **Republished renumbers keep their issue** ([#535](https://github.com/ryuudotgg/skills/pull/535))\
  `skills hub sync --publish-quarantine` now points a republished renumber, link or close at the new copy of the issue it was made for, so the renumbered issue comes back once under its new number with its links, its close and its first filed time instead of as a second issue.
- **`skills audit` counts OpenCode write arms** ([#590](https://github.com/ryuudotgg/skills/pull/590))\
  An OpenCode write arm counts as an edit when `skills audit` times a `/plans do` window, and under `--prs` a PR published after one succeeds goes to the arm's `-m` model instead of `lead`. A read only OpenCode arm counts as neither.
- **`skills audit` times a `-impl` delegate as an edit** ([#590](https://github.com/ryuudotgg/skills/pull/590))\
  A `delegate_task` whose title ends in `-impl` sets the first and last edit of its `/plans do` window, as it already set the implementer under `--prs`.
- **Blobs uploaded after a revocation are sealed under the new epoch** ([#527](https://github.com/ryuudotgg/skills/pull/527))\
  When a device is revoked while another machine is mid sync, the hub now refuses a new blob sealed under the old epoch, and the syncing machine reads the membership again and sends that blob once more under the current one. A CLI older than this release fails that one sync and succeeds on the next.
- **The commit guard sees git aliases set through the environment** ([#501](https://github.com/ryuudotgg/skills/pull/501))\
  A git alias set with `GIT_CONFIG_KEY_<n>` or `GIT_CONFIG_PARAMETERS`, as a prefix, after `env`, exported earlier in the command or nested in `sh -c`, now counts as a push in both modes, the same as `git -c alias.<name>=`.
- **`skills pr green` stops reading at its timeout** ([#547](https://github.com/ryuudotgg/skills/pull/547))\
  `skills pr green` and the `plans set-row` REVIEW gate count finding the current PR against their timeout and give each GitHub read only the time left, so a stalled `gh` no longer holds them past it. A PR the timeout cuts prints `unreadable timeout reached before reading PR status`.
- **`plans release` removes leftover trash wherever it sits** ([#544](https://github.com/ryuudotgg/skills/pull/544))\
  A run that could not delete the paths it parked now records them under the plans directory, and the next run without `--dry-run` deletes them or puts them back, also when the released checkout was the last one in its parent directory.
- **A rerun finishes a restack whose push outcome was unknown** ([#507](https://github.com/ryuudotgg/skills/pull/507))\
  When `skills lease-rebase`, `skills fix-round` or `skills restack-layer --push` lands its push but cannot read origin afterwards, running the same command again moves the local branches to the rebased tips origin already holds. It refuses, naming the layer and both recorded tips, when either side moved since.
- **A revoked machine's unfetched files stop being downloaded** ([#536](https://github.com/ryuudotgg/skills/pull/536))\
  When a sync quarantines a revision whose bytes have not arrived, it drops the queued download nothing visible still needs, and the first sync after the update drops the ones an older version left queued, so `fetching <n>` in `skills hub status` returns to 0. A revision that becomes visible again queues its bytes again.
- **The hub refuses a later event with a zero previous hash** ([#568](https://github.com/ryuudotgg/skills/pull/568))\
  A signed event of sequence 2 or more whose previous hash is zero now gets `event-chain` from the hub and is never stored.
- **Quarantine keeps every revoked device of a store** ([#557](https://github.com/ryuudotgg/skills/pull/557))\
  A store revoked as one device, enrolled again and revoked as the next now counts both devices' events in `quarantined <n>`, and `skills hub sync --publish-quarantine` republishes them all instead of only the first device's.
- **Hub sync refuses a pulled file named like a staging file** ([#564](https://github.com/ryuudotgg/skills/pull/564))\
  `skills hub sync` now refuses a file revision whose path looks like a temporary staging file, printing `refused path <path>: the event names a file only plan sync writes`, instead of writing it into the plans directory.
- **An edit survives a sync that dies while a close lands** ([#538](https://github.com/ryuudotgg/skills/pull/538))\
  When `skills hub sync` dies after moving an open plan copy out of the way to land a pulled close, the next sync puts that copy back and refuses the landing, so an edit made on this machine no longer stays hidden under a temp name. A copy that an earlier version left behind keeps its old temp name and is not picked up.
- **Renumbering one issue on two machines leaves one copy** ([#563](https://github.com/ryuudotgg/skills/pull/563))\
  When two machines run `skills issues renumber` on the same conflict before syncing, the moved issue ends under one number on both once they sync, the number the later renumber gave it, with no duplicate and no new conflict.
- **`skills reap` keeps a device that is in use** ([#545](https://github.com/ryuudotgg/skills/pull/545))\
  `skills reap` holds a simulator's or AVD's device lock from its stop through its delete, so it keeps one a `skills device` call is using, and it keeps an AVD an emulator started on after the listing.
- **`skills reap --mine` leaves a row that moved to another branch alone** ([#545](https://github.com/ryuudotgg/skills/pull/545))\
  `skills reap --mine` works out the checkout's owners again before each stop and each delete, so a row that left the branch after the listing keeps its devices and servers.
- **Replaced files keep their mode** ([#534](https://github.com/ryuudotgg/skills/pull/534))\
  A view, a plan or ctx copy a sync lands, and a plan `skills plans close` rewrites keep the exact mode they had, so a group writable file stays group writable whatever the umask.
- **Hub reruns print the device's own label** ([#565](https://github.com/ryuudotgg/skills/pull/565))\
  A rerun of `skills hub init` or `skills hub recover` that picks up an enrollment already on the chain names the device by the label every other machine shows, not the `--label` given to the rerun. The default label comes from the same computer name probe as the machine facts, so a hung `scutil` no longer hangs either verb.
- **No false fork line while another process adopts a chain entry** ([#562](https://github.com/ryuudotgg/skills/pull/562))\
  `skills hub status`, `devices`, the session brief and the lease calls of `plans start`, `pin`, `adopt` and `lease break` read the checkpoint and the chain from one moment, so they no longer print `fork detected` when another `skills` process adds an entry at the same time.
- **A slow reap no longer fails other plans verbs** ([#540](https://github.com/ryuudotgg/skills/pull/540))\
  `plans start`, `plans adopt`, `plans sweep`, `plans release` and a second `skills reap` now wait up to 70 seconds for the scratch lock and get it between two steps of a running reap, where they used to stop with `scratch stayed locked` after 10. A reap command that would run past its step's 60 seconds is cut off, and the artifact is listed as kept with a reason naming the limit.
- **Review, eval and brief events reach other machines at once** ([#552](https://github.com/ryuudotgg/skills/pull/552))\
  `skills pr green`, `skills round decide`, `skills round drive`, `skills eval`, `skills brief` and `skills plans wave` now sync with the hub when they finish, so what they record reaches the operator's other machines without waiting for the next unrelated write.
- **`skills reviewers` usage matches `skills --help`** ([#585](https://github.com/ryuudotgg/skills/pull/585))\
  A bad `skills reviewers` call prints `usage: skills reviewers [--active] (<KEY> | --settings)`, the line `skills --help` lists, and `skills --help` lists `skills audit` with the `-h` and argument names its own usage error prints.
- **`skills digest` returns the terminal after a stalled hub sync** ([#581](https://github.com/ryuudotgg/skills/pull/581))\
  When the hub sync `skills digest` runs before writing overruns its limit, the digest prints its line and exits straight away instead of holding the terminal until the stalled sync gives up. Session start and the sync after a write verb exit the same way.
- **Commit guard sees git words piped to xargs** ([#525](https://github.com/ryuudotgg/skills/pull/525))\
  A commit, push or `skills.*` git config command that `xargs git` builds from words an `echo` or `printf` pipes to it, or from a here string or heredoc, is now blocked like the same command nested in `sh -c`.
- **A row dropped with `plans set-row` stops holding its issues open** ([#510](https://github.com/ryuudotgg/skills/pull/510))\
  `skills plans set-row <Project> <id> DROPPED` now unlinks each listed row from the issues it resolves, so an issue closes as soon as its remaining resolvers are DONE, the same as after `plans close ... DROPPED`.
- **Checkouts with husky hooks are released** ([#594](https://github.com/ryuudotgg/skills/pull/594))\
  `skills plans release` now counts husky's generated `.husky/_` as disposable, and treats any directory that ignores itself through its own `.gitignore` as one path. A `PLANS_DISPOSABLE` name with a slash, such as `web/test-results`, matches that many trailing segments of an ignored path.
- **The Playbook page shows `bin/skills brief` as code** ([#587](https://github.com/ryuudotgg/skills/pull/587))\
  The Backlog item bullet in the docs site's playbook list renders `bin/skills brief` as inline code, and the page's markdown at `/workflow/playbook.md` and `/llms-full.txt` no longer escapes its backticks.
- **A slow link no longer times out the speed check of `skills hub sync`** ([#533](https://github.com/ryuudotgg/skills/pull/533))\
  When a long sync resends a pushed blob to measure the link before a large upload, it now stops waiting for that resend at the run's deadline. A link too slow to answer in time ends the run as a partial run with exit 75, where it used to end with `the hub did not answer in time`.
- **Events from a newly joined machine are no longer lost** ([#532](https://github.com/ryuudotgg/skills/pull/532))\
  A sync tries the events it could not verify again whenever a machine joins or is revoked, so events from a machine that joined during another machine's sync land on that other machine's next sync instead of staying refused for good.
- **An open session page follows its transcript** ([#583](https://github.com/ryuudotgg/skills/pull/583))\
  An open session page in `skills dash` reads its digest again every 5 seconds, so a transcript that grows shows its new prompts without a `skills sessions scan` or a reload.
- **Graph nodes keep the plan id visible** ([#573](https://github.com/ryuudotgg/skills/pull/573))\
  A graph node reads the id and slug over the project and status, so a long project name no longer hides the id, and wide characters and emoji clip by display width without breaking a character.

### 🧰 Internal

- **Short read deadlines wait 60 s under test** ([#528](https://github.com/ryuudotgg/skills/pull/528))\
  While the suite runs, `read` and `readSync` in `packages/cli/src/read.ts` wait at least 60 s before giving up, so a slow `git` or `gh` on a busy runner no longer fails a test that is not about a deadline. The installed CLI keeps every deadline as its caller passed it.
- **Hub sync drops its duplicate have reader** ([#553](https://github.com/ryuudotgg/skills/pull/553))\
  `restoreTombstones` reads the hub's tombstones through `holdings`, `BLIND_BYTES` lives once in `packages/cli/src/hub/run.ts`, and `pushBatch`, the test `Wire` and `startHubFixture` lose a result, a counter and an option nothing read.
- **Backlog sync tests run on simulated time** ([#512](https://github.com/ryuudotgg/skills/pull/512))\
  The wire paced backlog tests in hub/sync.test.ts now run on a Simulated wire in test/hub-machines.ts that moves the Sync clock instead of waiting, so they take seconds and runner load cannot fail them, while `Budget` admission gets direct unit tests in hub/run.test.ts.
- **Hub move tests share a smaller pack** ([#559](https://github.com/ryuudotgg/skills/pull/559))\
  The `hubMove` fixture in plans/move.test.ts packs a 2 MiB `big.bin` into three chunks, so the budget test still proves an upload outlives the 1 s sync budget across three serial chunk PUTs while paying about half the wire delay it did.
- **Restack pushed line in the verb grammar** ([#517](https://github.com/ryuudotgg/skills/pull/517))\
  The `<branch> is pushed, run skills restack-layer --push to finish the layers above` line a run without `--push` prints is listed in the `restack-layer` grammar that `skills check` validates.
- **Count the processes a command starts** ([#526](https://github.com/ryuudotgg/skills/pull/526))\
  `scripts/spawn-count.sh <command...>` runs a command with counting shims for `git` and `bun` first on PATH, prints `git <n>` and `bun <n>` once it ends and exits with its status.
- **`skills test` names flaky tests** ([#529](https://github.com/ryuudotgg/skills/pull/529))\
  When a `bun test` suite that isolates its files fails on five test files or fewer, packages/cli/src/test/runner.ts reruns each of those files once after every other suite has ended and prints a test that then passes as `flaky <file>: <test name>`. A suite whose failures were all flaky counts as `ok`, and the run's last line reads `ok <n> suites, <m> flaky`.
- **`plans start` lease paths tested through the verb** ([#518](https://github.com/ryuudotgg/skills/pull/518))\
  `start-leases.test.ts` runs `plans start` against a live hub fixture for a held lease, an offline hub, a failed cut and a batch with a held member, and the start rerun check is tested through a real rerun instead of through core's `lastEvent`, with the unused `registeredBelow` helper gone from `stack-verbs.test.ts`.
- **Issue tests run their verbs in process** ([#584](https://github.com/ryuudotgg/skills/pull/584))\
  The issue tests in plans/issues.test.ts call the issue and plans verbs directly with a capturing Io, and spawn the CLI only to prove the verbs are wired and to run the session brief hook. One `captureIo` in test/fixtures.ts replaces the four copies the import, revisions, sync and recall tests kept.
- **Core's lastEvent reads every event** ([#521](https://github.com/ryuudotgg/skills/pull/521))\
  `lastEvent` in skills-core returns the newest trail line of a row with no list of events to skip, since no caller passes one; the store's `lastTrailEvent` keeps its own.
- **Stack tests copy a prepared repository** ([#523](https://github.com/ryuudotgg/skills/pull/523))\
  `stackRepo` in `test/stack-fixture.ts` builds each repository shape once and gives every test its own copy, and the git shims, the ref snapshot helpers and the three layer spec the stack verb tests repeated now live in that fixture.
- **Reap and device tests share one fixture** ([#554](https://github.com/ryuudotgg/skills/pull/554))\
  The reap and device suites build their stub tools, repository and checkout through packages/cli/src/test/artifact-tree.ts and capture a verb's output through its one wrapper.
- **Grammars list every printed line** ([#592](https://github.com/ryuudotgg/skills/pull/592))\
  The registry grammars of `eval`, `audit`, `dash`, `pr green`, `pr watch`, `round drive`, `review read`, `plans frontier` and `plans history` now hold the lines those verbs print that they missed, and a registry test matches a sample of each against its grammar.
- **Core checks an authored event by one rule** ([#568](https://github.com/ryuudotgg/skills/pull/568))\
  `verifyEvent` takes a membership and an event and returns nothing, so the hub and the CLI no longer build a tail from the event under test, and the unused `committedRun` is gone from skills-core.
- **Store reader tests run once** ([#530](https://github.com/ryuudotgg/skills/pull/530))\
  `skills test --all` has no deleted-views suite: the 21 store reader test files run once, in the bun suite. Each test says through its fixture whether `index.tsv` and `log.tsv` stay on disk, with a `views` argument on `writeFixture`, `appendFixture` and `stackCase` that keeps them unless a call passes `"deleted"`.
- **One staged write for views, landing and file sync** ([#564](https://github.com/ryuudotgg/skills/pull/564))\
  View writes, landing, the first import and file sync now stage through `createDurably` and `replaceDurably` in index-tsv.ts, with one staging name from staging.ts and one `isOwnFile` rule in ignore.ts.
- **Core tests stamp plan events in one module** ([#566](https://github.com/ryuudotgg/skills/pull/566))\
  The issues, leases, digest, stats, board, frontiers and move tests in packages/core/test build their events through plan-events.ts, so a new stamp field on stored events is set there once.
- **Hub key and status tests run isolated and fast** ([#572](https://github.com/ryuudotgg/skills/pull/572))\
  The file key store tests in keys.test.ts write only under their own temporary directory with random device ids, and the stalled body status test in verbs.test.ts reaches its deadline in about 250 ms instead of waiting out the 2 s budget.
- **Timing tests hold on loaded runners** ([#515](https://github.com/ryuudotgg/skills/pull/515))\
  The redact test on a four megabyte image now compares its cost to a sixteenth of the image instead of a fixed time, and the lease tests in `leases.test.ts` give real requests a budget only the faked clock spends.
- **Machine tests build only the fixture they use** ([#571](https://github.com/ryuudotgg/skills/pull/571))\
  machine.test.ts builds a fixture only for the tests that read a store and never builds one twice, and machine-fixture.ts creates its second plans directory only when passed `--two-stores`, which adopt.test.ts does.
- **One check for a draft naming another branch** ([#542](https://github.com/ryuudotgg/skills/pull/542))\
  `closePlan` in `packages/cli/src/plans/verbs.ts` now refuses a landed draft that names another branch than the row's, ahead of the stamp, so `plans close` and the sweep no longer each carry the rule. A `Stamp` takes the branch and the row's history, and a sweep test covers the refusal.
- **Tests no longer fail on a slow machine's clock** ([#539](https://github.com/ryuudotgg/skills/pull/539))\
  The 28 assertions that compared real elapsed time with a fixed number are gone from the tests under `packages/cli/src`: each now asserts the outcome its deadline produces, or compares two runs it measures itself through `test/scaling.ts`. `test/elapsed-bounds.test.ts` fails when a new one is added outside `read.test.ts`, `read-faults.test.ts` and `hub/sync.test.ts`.
- **Usage lines live only in the registry** ([#585](https://github.com/ryuudotgg/skills/pull/585))\
  Each verb's usage line is written once in its `packages/cli/src/areas` entry, and the handlers for `round`, `reviewers`, `settings`, `audit`, `eval`, `dash`, `update`, `pr green`, `log` and `check` print that line instead of a copy of their own.
- **Diff runs of `skills test` run only the tests a change can reach** ([#537](https://github.com/ryuudotgg/skills/pull/537))\
  Without `--all`, the bun suite runs the test files that import a changed file under packages/cli/src or packages/core/src, plus every test that may start repository code as its own process, and still runs every file when the diff holds a change the import graph cannot answer for. The CLI wrapper cases of the stack tests now live in packages/cli/src/stack/wrappers.test.ts, so those files run in process.
- **Rule override key and levels have one home** ([#582](https://github.com/ryuudotgg/skills/pull/582))\
  `overrideKey` and the new `levelsFor` live in `packages/cli/src/deny-set.ts`, and the installer, its Customize prompt and the Rule Levels docs table all read them from there.
- **Pr tests share one fake clock** ([#550](https://github.com/ryuudotgg/skills/pull/550))\
  The pr test suites build their fake clock and watcher dependencies through `fakeClock` and `fakeDependencies` in `packages/cli/src/pr/fakes.ts`, and policy.test.ts reads plain snapshots through `openSnapshot`.
- **One reader and writer for the plans meta table** ([#560](https://github.com/ryuudotgg/skills/pull/560))\
  `plans/store.ts` owns the read and the write of the meta table, the unused `sequence` sync key is no longer written, and the outbox queries in `plans/outbox.ts` state each rule once.
- **Publish drops two leftover parameters** ([#509](https://github.com/ryuudotgg/skills/pull/509))\
  `clearGeneratedBody` in publish/stack.ts takes only the body and the template, and `stageSelected` in publish/commit.ts takes the staged selection its callers already read instead of reading it again.
- **Hook prune and Codex rules tested as units** ([#589](https://github.com/ryuudotgg/skills/pull/589))\
  `pruneHooks` lives in prune-hooks.ts with its own suite on a stub history, and codex-rules.test.ts drives the Codex renderer in process, so install.test.ts spawns `skills install` far less often.
- **Installer strings and manifest write in one place** ([#577](https://github.com/ryuudotgg/skills/pull/577))\
  The install usage line and the hub join line come from the registry strings in areas/install.ts and areas/hub.ts, and the OpenCode manifest is written through the same replace helper as every other owned OpenCode file.
- **Publish and start-close tests copy a prepared repository** ([#531](https://github.com/ryuudotgg/skills/pull/531))\
  `publish.test.ts` and `plans/start-close.test.ts` build their repository once and give every test its own copy. `stackRepo` in `test/stack-fixture.ts` builds and copies through the same `test/repo-template.ts`.
- **Docs site builds its tables through one module** ([#587](https://github.com/ryuudotgg/skills/pull/587))\
  The remark plugins under `apps/docs/lib` build their table rows, cells, text and inline code with the builders in `mdast.ts`, and the docs drop the unused locale handling, the Lucide icon plugin and their direct `lucide-react` and `@base-ui/react` dependencies.
- **One first line reader for the sessions readers** ([#516](https://github.com/ryuudotgg/skills/pull/516))\
  The scan, `readDigest` and the Chunker share one `firstLine` in sessions/transcripts.ts, which reads 64 KiB before it falls back to the Line reader.
- **Drop unread reap and device options** ([#555](https://github.com/ryuudotgg/skills/pull/555))\
  `skills device` no longer takes a scratch root it never used, and the named `skills reap` read no longer fills a placeholder branch, since the owner read in owner.ts now takes a base without the scratch root.
- **One host list, claim selector and policy fold in skills-core** ([#574](https://github.com/ryuudotgg/skills/pull/574))\
  skills-core exports the Host list, the ruling claim behind `leaseState` and the board, and the policy fold behind the screen, stats, the board and digests, so each rule lives in one place.
- **Drop the plans readers only tests called** ([#569](https://github.com/ryuudotgg/skills/pull/569))\
  The tolerant index and trail file readers are gone, with their tests moved onto `parseIndexText`, `parseTrailText` and `decodeUtf8`. `Recorded` in record.ts lists the seven events `recordEvent` accepts, so a new store event no longer needs an edit there.
- **Dashboard tests share their Shell render and dash start** ([#588](https://github.com/ryuudotgg/skills/pull/588))\
  The dashboard tests render the Shell through `apps/dashboard/test/render.ts` and start `skills dash` through `apps/dashboard/test/dash.ts`, and the no hub case of `sync.test.ts` checks the hub log without its 11 second wait.
- **Plan page sessions share the sessions table** ([#578](https://github.com/ryuudotgg/skills/pull/578))\
  The plan page draws its Sessions section from `sessionList` through the sessions view's `Table` and `Row`, with its eight columns picked from one keyed cell table, and `planPage` no longer folds sessions of its own. `planSessions` in skills-core keeps a plan's sessions, oldest first.

## 1.4.0

*November 20, 2026*

### ✨ New

- **`plans set-row` takes a list of ids** ([#500](https://github.com/ryuudotgg/skills/pull/500))\
  `skills plans set-row` accepts comma separated ids and writes every listed row at once, so a batch branch's rows reach REVIEW behind one green check of their PR instead of one 30 second wait each.
- **Eval runs can leave skills out** ([#479](https://github.com/ryuudotgg/skills/pull/479))\
  `skills eval <case> --without <skills>` runs a case with the named skills missing from the work tree, so running it both ways shows whether a skill changes the grade. The run prints and saves the withheld names and stores no `eval` event.

### 🎨 Improved

- **Publish names the move for a merged ancestor** ([#498](https://github.com/ryuudotgg/skills/pull/498))\
  `skills publish` on a stacked layer whose parent's PR already merged now refuses with the `skills restack-layer --onto` command that moves the layer onto the trunk, instead of saying the parent has no open PR.
- **Restore holds one chunk at a time** ([#495](https://github.com/ryuudotgg/skills/pull/495))\
  `skills sessions restore` writes each session chunk by chunk, so restoring a long transcript no longer holds the whole history in memory several times over.

### 🐛 Fixed

- **`skills plans close` finishes on Bun older than 1.4.4** ([#506](https://github.com/ryuudotgg/skills/pull/506))\
  On Bun 1.4.0 through 1.4.3, closing a plan that has a trail no longer stops with `bad parameter or other API misuse` after moving the plan file, and a plan left half closed that way finishes when you run the close again. A hub run from source on those versions also serves the event page after one cut at the byte budget.
- **Deny Rules no longer understates OpenCode edit rules** ([#486](https://github.com/ryuudotgg/skills/pull/486))\
  The Deny Rules page summarises the Claude Code and OpenCode rule management and links to Rule Levels and the OpenCode page for the detail, so it no longer says OpenCode edit rules miss nested relative paths.
- **Edit guards scan heredocs with a dollar delimiter** ([#499](https://github.com/ryuudotgg/skills/pull/499))\
  A heredoc whose delimiter is written `$'D'` or `$"D"` is now read as a script, so a patch inside it still gets the comment and dash checks. Codex only.
- **Stack verbs read git the same under any config** ([#488](https://github.com/ryuudotgg/skills/pull/488))\
  `skills publish` and `skills fix-round` commit signed work with `log.showSignature` on, `skills restack-layer --push` catches a leftover conflict marker whatever the diff settings, and a layer whose name ends like another origin branch counts as not on origin.
- **Edit guards read every heredoc patch** ([#481](https://github.com/ryuudotgg/skills/pull/481))\
  When one Bash command line opens several `apply_patch` heredocs, the comment guard, the dash guard and plan revision recording now see every patched file, and an `apply_patch` quoted inside a file written through `cat` or `tee` is no longer read as an edit. Codex only.
- **A move too big for the pack names the real cause** ([#483](https://github.com/ryuudotgg/skills/pull/483))\
  `skills plans move` says `the tracked changes are over 128 MiB` when the tracked diff alone is over the cap, and names the largest untracked file only when untracked files push the work over it.
- **`skills fast-mode` says why a bad skills.conf reads off** ([#472](https://github.com/ryuudotgg/skills/pull/472))\
  An invalid skills.conf now prints its reason on stderr from `skills fast-mode` too, and the malformed line note reads `<conf>: line <n>: malformed` everywhere, without claiming the whole file is ignored.
- **A failed pack write leaves no partial file** ([#494](https://github.com/ryuudotgg/skills/pull/494))\
  `skills plans move --file` that fails while writing the pack now removes the half written temporary file beside the destination before it refuses.
- **Sessions page names every sync that sends** ([#492](https://github.com/ryuudotgg/skills/pull/492))\
  The Sessions page now says session events and blob deletions travel on every hub sync, the quiet one after a writing verb included, and that `skills sessions policy` tries the deletion itself before `skills hub sync` reports it.
- **Restored sessions keep the stats of the machine that recorded them** ([#482](https://github.com/ryuudotgg/skills/pull/482))\
  A session `skills sessions restore` wrote adds no stats and uploads no chunks from this machine until a host resumes it here, and from then on its stats are the ones restore found plus what it gains on this machine.
- **A merge from before a row's start no longer counts as its PR** ([#503](https://github.com/ryuudotgg/skills/pull/503))\
  `plans set-row ... REVIEW`, `plans stack-base`, `plans start` and `plans below` count only the PRs of a row's current start, so a row started again on a branch that already merged refuses until it has an open PR or one merged after its latest start, instead of passing on the old merge or cutting a dependent from trunk without its work.
- **A fix round finishes after its push failed** ([#493](https://github.com/ryuudotgg/skills/pull/493))\
  Running the same `skills fix-round` command again after `git push failed` now sends the round commit it left on the branch and restacks the layers above, where it used to refuse that there was nothing to commit.
- **Re-review triggers are never cut short** ([#487](https://github.com/ryuudotgg/skills/pull/487))\
  `skills round drive` posts each re-review trigger with no deadline, so a trigger GitHub accepted near the hard stop no longer ends the round as `refused`. Every read drive makes keeps its deadline.
- **Comment checks skip more tool directives** ([#489](https://github.com/ryuudotgg/skills/pull/489))\
  The comment guard and the Stop and commit sweeps no longer count directives for oxlint, Deno lint, stylelint, v8 coverage, pyright, ruff, mypy and RuboCop, a TypeScript `/// <reference` line or a Dockerfile `syntax`, `check` or `escape` line as comments, while prose that merely starts with one of those words still does.
- **YAML block scalars hold no comments** ([#489](https://github.com/ryuudotgg/skills/pull/489))\
  In `.yaml` and `.yml` files a `#` line inside a `|` or `>` block scalar, such as a shell comment in a GitHub Actions `run: |` step, is string content and no longer reported, and a `#` line after the scalar ends is reported again.
- **Stack verbs leave the default branch alone** ([#497](https://github.com/ryuudotgg/skills/pull/497))\
  `skills fix-round` and `skills restack-layer` stop with `cannot rebase the default branch <default>` where they used to rebase and push a layer above the current branch that origin calls its default branch, before they stage, rebase or push anything.
- **Moves refuse a store whose sync is stopped** ([#476](https://github.com/ryuudotgg/skills/pull/476))\
  `skills plans move` through the hub now refuses with `move: sync is stopped on this machine, run skills hub sync` before it uploads anything, instead of recording a move that could never reach the hub.
- **Session scan ignores quarantined events** ([#496](https://github.com/ryuudotgg/skills/pull/496))\
  `skills sessions scan` files new stats under the newest session event still out of quarantine, and a session whose newest stats were quarantined gets a replacement on the next scan even when its transcript did not change.
- **Commands piped into a shell stay blocked** ([#490](https://github.com/ryuudotgg/skills/pull/490))\
  The commit guard now blocks a commit, push, PR comment or `skills.*` git config command that is piped into `bash`, `sh` or another shell, or handed to one as a here string, the same way it blocks one inside `bash -c`.
- **Move and adopt accept a group writable scratch directory** ([#491](https://github.com/ryuudotgg/skills/pull/491))\
  `skills plans move` and `skills plans adopt` now clear the group and other write bits on your own `/tmp/plans-<id>` directory and carry on, so a scratch directory made under umask 002 no longer stops them.
- **Indented frontmatter is checked like frontmatter at column zero** ([#484](https://github.com/ryuudotgg/skills/pull/484))\
  Frontmatter whose keys are all indented now has a repeated key refused and every key's line known, so an optional skill with a doubled `requires` is never installed, `skills check` names the right line, and the OpenCode installer skips such an agent.
- **Docs match the installer and update rollback** ([#475](https://github.com/ryuudotgg/skills/pull/475))\
  Other Tools says those tools need Bun, the configuration reference names the two prompts a flagged install still shows, and the README and Getting Started say a rollback saves tracked edits under `refs/skills-update/edits/` or stops when git cannot save them.
- **Reviewer settings stay blocked however the key is spelled** ([#470](https://github.com/ryuudotgg/skills/pull/470))\
  The commit guard now blocks a `git config` command on a `skills.*` key even when the key is quoted, escaped or continued onto the next line, and lets a search or message that only mentions such a command through.
- **Publish without gh stack checks the parent's PR first** ([#502](https://github.com/ryuudotgg/skills/pull/502))\
  Without `gh stack`, `skills publish` on a stacked branch refuses before its first push when the parent branch has no open PR, naming the `skills restack-layer` move when that PR merged, so no PR opens against a dead base.
- **A merged stack layer no longer blocks a publish** ([#502](https://github.com/ryuudotgg/skills/pull/502))\
  With `gh stack`, a layer it marks merged is left out of the origin tip comparison, so its origin branch running ahead or its local branch being gone no longer refuses the publish of another layer.
- **An unpublished layer follows its merged parent** ([#480](https://github.com/ryuudotgg/skills/pull/480))\
  `skills restack-layer` now rebases a layer origin does not hold yet, `--onto` included, and ends on `then skills publish` with the new parent recorded as its base, where it used to refuse until the layer was published.

### 🧰 Internal

- **Leaner review verb tests** ([#485](https://github.com/ryuudotgg/skills/pull/485))\
  `review.test.ts` drops three tests that repeated another case or checked only their own fake, builds its reviewer declarations with the shared `declarationText`, and halves the thread recheck matrix to the one code path both readers share.
- **Trim the round fixtures further** ([#477](https://github.com/ryuudotgg/skills/pull/477))\
  The round's test fixtures drop their duplicate rows, unread fields, the second rate limited PR and the reviewer copies of the usage tests, and `legacy-fixtures.json` writes its 100 commit case with `{repeat, node}`, which `expand` in `fixtures.ts` now spreads inside an array.
- **Reviewer kit reads trigger times once** ([#474](https://github.com/ryuudotgg/skills/pull/474))\
  `triggerTimes` in `reviewer-kit.ts` holds the rule for which comments are a reviewer's trigger, and presence and the Greptile, CodeRabbit and Macroscope modules read the times from it.
- **Hub sync reads one injected clock** ([#505](https://github.com/ryuudotgg/skills/pull/505))\
  The sync Budget, the hub client's deadlines and request timeouts, the file walk, file landing, session scan and chunker read time through the clock and timeout factory `Deps` carries, so a test can run a Budget out or time a request out without waiting.
- **Review verbs keep each piece in one place** ([#478](https://github.com/ryuudotgg/skills/pull/478))\
  The resolve write lives in one `resolveThread` in `review/threads.ts`, and each review verb's usage string lives only in `areas/review.ts`, which hands it to the verb through one shared run helper.

## 1.3.0

*November 20, 2026*

### 🚨 Heads up

- **Update every synced machine together** ([#406](https://github.com/ryuudotgg/skills/pull/406))\
  A machine still on an older `skills` puts every link and close on the earliest filing of a number in conflict, so it can release plans the updated machines still hold: run `skills update` on each machine that syncs the plans store.

### ✨ New

- **Issues filed apart under one number all survive sync** ([#342](https://github.com/ryuudotgg/skills/pull/342))\
  When two machines file the same `<Project>#<n>` while apart, both filings stay after sync, and the INBOX, the dashboard and `skills issues show` print the number as a conflict. `skills issues renumber <Project>#<n>` moves the latest filing to the next free number.
- **Taking over a PR carries its author's commits** ([#412](https://github.com/ryuudotgg/skills/pull/412))\
  `skills takeover <pr>` carries another author's PR commits onto your branch in prs mode, each with its author line and message unchanged, and a conflict stops it in the checkout for `skills takeover --continue` or `skills takeover --abort`.

### 🎨 Improved

- **Reviewer skills point at the shared round rules** ([#335](https://github.com/ryuudotgg/skills/pull/335))\
  The CodeRabbit and Macroscope skills no longer restate how the review round reads the PR and decides, and the Reviewers docs page lists Macroscope among the reviewers that ship.
- **Session pickup reads prior work through `skills sessions`** ([#460](https://github.com/ryuudotgg/skills/pull/460))\
  A pickup finds the earlier session with `skills sessions list` and reads it with `skills sessions show --digest` on Claude Code and Codex alike, and falls back to the raw transcript, whose Codex location it now names, only when the digest cannot serve.
- **Allowed draft note reads plainly** ([#419](https://github.com/ryuudotgg/skills/pull/419))\
  `skills pr watch --allow-draft --pretty` ends a READY on a draft with `note=draft allowed (--allow-draft), leave it a draft and do not mark it ready`.
- **Security reports go to a private channel** ([#462](https://github.com/ryuudotgg/skills/pull/462))\
  The repository now has a security policy that GitHub's Security tab shows, and it sends vulnerability reports to a private advisory or security@ryuu.gg instead of a public issue.
- **Session scans skip silenced transcripts** ([#328](https://github.com/ryuudotgg/skills/pull/328))\
  `skills sessions scan` no longer reads the transcripts of a session under an `off` policy, so a silenced project costs the scan at most a file check per transcript, and loosening the policy still records everything written meanwhile.
- **Backlog item probe stops on a surface found twice** ([#332](https://github.com/ryuudotgg/skills/pull/332))\
  A `/plans do` probe that finds the plan's surface in two places, or as a public and a private copy, stops with the destination question before any edit.
- **Perf issue and refactoring use `skills device`** ([#332](https://github.com/ryuudotgg/skills/pull/332))\
  iOS and Android traces and checks in the perf issue and refactoring playbooks run on the device `skills device` prints, as bug fix and feature already do.
- **Babysit drops a `--json` flag the watcher never had** ([#332](https://github.com/ryuudotgg/skills/pull/332))\
  Babysit describes `skills pr watch` as it is, NDJSON by default and `--pretty` for humans, with no warning about a `--json` flag it never took.
- **One off lessons go to the harness's own memory** ([#332](https://github.com/ryuudotgg/skills/pull/332))\
  Encode lessons in structure sends a one off lesson to Claude Code's auto memory, AGENTS.md or the host's equivalent, in place of a brain note no harness has.
- **Type system discipline names no missing skill** ([#332](https://github.com/ryuudotgg/skills/pull/332))\
  Type system discipline no longer points at a `typescript-best-practices` skill that is not installed.
- **Session start reads only its own project** ([#432](https://github.com/ryuudotgg/skills/pull/432))\
  The session brief reads its own project's rows and inbox, and stops reading the trail once it has the three lines it prints, so a session start no longer slows down as the plans store grows and an unreadable event in another project no longer replaces the brief with an error.
- **Hub join leaves hub.lock free while it waits** ([#431](https://github.com/ryuudotgg/skills/pull/431))\
  `skills hub join` holds `hub.lock` only to record its request and to adopt the chain, so syncs and policy changes on the joining machine run while it waits for approval. A join whose store another hub verb enrolled or changed meanwhile refuses and adopts nothing.
- **Stop and PostToolUse hooks start faster** ([#317](https://github.com/ryuudotgg/skills/pull/317))\
  A Stop or PostToolUse call that has nothing to record skips loading the plans store, so it finishes about 6 ms sooner.
- **Investigations end without a PR** ([#446](https://github.com/ryuudotgg/skills/pull/446))\
  A `/plans do` whose route changed no file writes its answer under `## Landed`, logs `handback` and leaves the row for `/plans close`, with no publish, review tail or babysit. `skills brief` for an investigation prints that finish in place of the handing back steps and seats no review arm.
- **`/how` explains through the roster** ([#356](https://github.com/ryuudotgg/skills/pull/356))\
  `/how` reads `skills arms` before its first spawn and runs `fable-judgment` as the explainer only when the roster chooses Claude, explaining directly and saying so otherwise. Its critics now get the file paths first and the explanation last, matching the critic prompt.
- **Restored hubs get their deletions back faster** ([#418](https://github.com/ryuudotgg/skills/pull/418))\
  `skills hub sync` against a hub restored from a backup resends the blob deletions the backup lost several at a time, so a hub with many of them needs fewer partial runs.
- **Security page states the join request limit** ([#357](https://github.com/ryuudotgg/skills/pull/357))\
  The hub Security page now says that anyone who can reach `POST /v1/pair` can fill every join slot for up to a week, which refuses `skills hub join` on a new machine meanwhile, and that a hub reachable only over your tailnet or private network keeps strangers off the route, while a proxy rate limit in `public` mode only slows them.
- **Session digests in the dashboard read only what is new** ([#324](https://github.com/ryuudotgg/skills/pull/324))\
  While `skills dash` runs, asking again for a session's digest reads only the lines the transcript gained since the last answer, so a long session no longer gets slower to open each time it grows. A replaced transcript or a change to the checkout's `.env` values still reads the whole file again.
- **Auto-update says when it held rule changes** ([#420](https://github.com/ryuudotgg/skills/pull/420))\
  With `AUTO_UPDATE=on`, the update notice at the next session start counts the rule changes the background installer held and asks you to run `./install.sh` at a terminal to apply them.
- **`skills hub status` names a halted copy** ([#343](https://github.com/ryuudotgg/skills/pull/343))\
  On a store restored or copied from another machine, `skills hub status` now ends with the same stop sentence `skills hub sync` gives, naming this device's label, instead of a quiet `last sync` and a growing queue.
- **Each /plans verb loads only its own instructions** ([#333](https://github.com/ryuudotgg/skills/pull/333))\
  A `/plans` subcommand now reads the plans skill's shared rules plus its own verb's references, instead of the whole 89 KB skill, and bare `/plans` reads no reference at all.
- **Configuration reference states the hub repeat rule** ([#437](https://github.com/ryuudotgg/skills/pull/437))\
  The Hub section of the configuration reference says a repeated `HUB_URL` or `HUB_NETWORK` in `skills.conf` uses its last line, as `AUTO_UPDATE` does.
- **Audit memory stays flat over long histories** ([#318](https://github.com/ryuudotgg/skills/pull/318))\
  `skills audit`, with or without `--prs`, now reads one Claude transcript at a time, so its memory follows the largest transcript rather than the whole selected history. On the same stores, every number, row and note it reports is the same as before.
- **Codex arms load without the OpenCode reference** ([#455](https://github.com/ryuudotgg/skills/pull/455))\
  A task firing Codex arms no longer reads the OpenCode run line or its permission sets, which now live in the playbook's `opencode-arms.md` and load only when a seat goes to OpenCode.
- **Architect called by another skill stops at the design** ([#362](https://github.com/ryuudotgg/skills/pull/362))\
  An architect run that another skill or a playbook step started now ends once it has synthesized the design, leaves the sketches unstaged and hands the design back, so the caller implements it. `/architect` typed on its own still goes straight on to implementation.
- **Waiting `pr green` lines have a next step** ([#346](https://github.com/ryuudotgg/skills/pull/346))\
  The delivery rules now say that a `no checks yet` or `mergeability unknown` line a second full `pr green` run still prints sends the row to BLOCKED, the same as a lasting `pending` or `unreadable` line.
- **`/no-comments` sweeps without comment-sicko** ([#355](https://github.com/ryuudotgg/skills/pull/355))\
  Where `comment-sicko` cannot be spawned, on a host with no `Task` tool, an install without the agent or a roster that leaves Claude out, `/no-comments` sends the same brief to a read only terra arm. With no arm either, the two comment hooks are the whole sweep and the report says no fresh reader ran.
- **Playbook steps defer to the architect trigger** ([#364](https://github.com/ryuudotgg/skills/pull/364))\
  Bug fix, Perf issue and Refactoring call `architect` only when the playbook's architect trigger fires and record a settled shape as skipped, and Prototype step 4 points at the variant rules in `ui-design.md` instead of keeping its own copy.
- **Hub sync requests read only what they answer** ([#307](https://github.com/ryuudotgg/skills/pull/307))\
  The hub answers `/v1/blobs/have` without loading blob contents, stops reading a page of events once it fills the 8 MiB budget, and reports author heads only on an empty history push, so `skills hub sync` holds the hub's write lock for less time on a large store.
- **Long dashboard lists show one page at a time** ([#407](https://github.com/ryuudotgg/skills/pull/407))\
  The sessions list draws the newest 200 sessions, and Tokens per plan and each effort band on the stats page draw their largest 20 and longest 10, each with a count of what is left out and a button that shows more.
- **Idle dashboard polls skip decoding the feed** ([#403](https://github.com/ryuudotgg/skills/pull/403))\
  An open dashboard no longer decodes the whole feed again on every poll that brings nothing new, so views that do not read the clock, the sessions list included, keep their results until an event arrives.

### 🐛 Fixed

- **Every plan reader skips the same fenced blocks** ([#442](https://github.com/ryuudotgg/skills/pull/442))\
  `plans lint` and `skills recall` treat a tilde block, and a longer fence holding a shorter one, as quoted text, and a `## ` line inside a fenced Probe block no longer drops the `rg` lines after it.
- **Push guard ignores an inherited git env** ([#452](https://github.com/ryuudotgg/skills/pull/452))\
  A shell that exports `GIT_DIR`, `GIT_COMMON_DIR` or another repository redirecting variable no longer makes the push guard or the comment check read the wrong repository, so a typed push is judged against the checkout it names.
- **Moves refuse work inside submodules** ([#467](https://github.com/ryuudotgg/skills/pull/467))\
  `skills plans move` refuses, naming the submodule, when a submodule holds edits, untracked files or a commit the branch does not record, instead of printing `moved` for a pack that left that work behind.
- **Issue links and closes stay with their own filing** ([#406](https://github.com/ryuudotgg/skills/pull/406))\
  When two machines file the same issue number apart, `skills issues show` prints each filing with its own state and links, no plan waiting on the number is released until `skills issues renumber` settles it, and the renumber carries the moved filing's state and links to its new ref and points each plan it blocks there, including a plan another machine set waiting on the old number before it synced the renumber.
- **Spaced tokens are redacted in session text** ([#457](https://github.com/ryuudotgg/skills/pull/457))\
  A hex string or UUID right after a name like `--token`, `--auth-token` or `Bearer`, with only spaces or quotes between, becomes `[redacted:entropy]`, while shas and UUIDs in prose stay untouched.
- **Basic auth headers are redacted outside curl** ([#457](https://github.com/ryuudotgg/skills/pull/457))\
  The credential of an `Authorization: Basic` header in a log line, a `wget` command or a JSON headers object becomes `[redacted:auth-header]`.
- **An interrupted `skills update` finishes on the next run** ([#375](https://github.com/ryuudotgg/skills/pull/375))\
  An update killed during its installer or its rollback no longer reads as `current` afterwards. The next `skills update` reruns the installer it stopped in, or refuses with `update lock is held` while that installer is still running.
- **Session digests list only the prompts you sent** ([#308](https://github.com/ryuudotgg/skills/pull/308))\
  `skills sessions show --digest` now counts a Claude prompt sent with an image as a prompt, and no longer lists task notifications or the AGENTS.md and environment blocks Codex injects as prompts. Digests already stored keep their old turns until their series restarts.
- **Recall finds every filing of an issue number** ([#425](https://github.com/ryuudotgg/skills/pull/425))\
  `skills recall` indexes each filing of an issue number that was filed more than once, each with its own open or closed status, and a renumber moves the entry to its new number.
- **A changed sessions policy reaches other machines at once** ([#341](https://github.com/ryuudotgg/skills/pull/341))\
  `skills sessions policy` and `skills sessions scan` now run the short hub sync after they run, like every other verb that writes, so a tightened policy reaches your other machines right away instead of waiting for the next unrelated write or session start.
- **`skills check` reads options as the programs do** ([#387](https://github.com/ryuudotgg/skills/pull/387))\
  A Codex invocation's options count only before `--`, a config value such as the effort counts only when `-c` or `--config` sets it, the last one winning, and a `skills` command that starts with an option other than `--root <dir>` or `--help` is reported as one `skills` does not accept.
- **Plans views with bytes that are not UTF-8 refuse cleanly** ([#303](https://github.com/ryuudotgg/skills/pull/303))\
  An `index.tsv` or `log.tsv` holding bytes that are not valid UTF-8 now gets the usual `changed outside the store` or `is not in the store yet` sentence from every plans writer and checked read, where it used to crash with an encoding error. Such a view left pending by another project no longer blocks a write elsewhere.
- **`skills plans pin` and `skills plans lease break` name a fork** ([#445](https://github.com/ryuudotgg/skills/pull/445))\
  On a store whose membership chain forked, both verbs now refuse with `fork detected`, and with the sentence of any other chain or key failure, instead of `hub offline`, which they keep for a hub they could not reach.
- **`skills plans pin` leaves a plan that moved while it waited** ([#445](https://github.com/ryuudotgg/skills/pull/445))\
  A pin whose plan moved to another machine while the pin waited on the hub now refuses with `<id> is moving to <label>`, records no pin, and gives back the lease it took, so the target machine can adopt the plan.
- **`skills pr watch` handles a PR with no checks** ([#426](https://github.com/ryuudotgg/skills/pull/426))\
  A PR whose head has no checks now shows `no checks` in the `--status-only` table, and a polling watch waits two minutes on that head, then decides from GitHub's merge state, so a repository without CI reaches `READY` instead of retrying until it fails.
- **OpenCode rule removals wait for a confirm unless proven safe** ([#405](https://github.com/ryuudotgg/skills/pull/405))\
  Removing or lowering an owned OpenCode deny or ask now counts as weakening unless a surviving rule provably keeps every command it matched at least as strict, so personal rules that only cover the installer's sample commands no longer let the change through without a terminal confirm.
- **Stacked publish never opens an unreported PR** ([#326](https://github.com/ryuudotgg/skills/pull/326))\
  On a stacked branch, `skills publish` now refuses with `<layer> has no open PR, publish it first` before any push when another layer of the stack has no open PR, instead of letting `gh stack submit` open one with a generated title and body. Merged layers are left out, since submit skips them.
- **Stacked publish keeps prose that links gh-stack** ([#326](https://github.com/ryuudotgg/skills/pull/326))\
  With the PR body key off, a stacked publish clears an existing PR's body only when it ends with the footer gh-stack writes or matches the repo's PR template, so a description that merely links the gh-stack repository stays.
- **Each lease call gets its own time budget** ([#441](https://github.com/ryuudotgg/skills/pull/441))\
  `skills plans pin` with many ids pins every id the hub grants on a slow link, and `plans start` or `plans adopt` takes the lease instead of going provisional when the time budget ran out between its two hub requests.
- **Session redaction hides hub recovery codes** ([#348](https://github.com/ryuudotgg/skills/pull/348))\
  A hub recovery code in a transcript, spaced as `skills hub init` prints it or hyphenated as typed, in either letter case, now comes back as `[redacted:recovery-code]` in redacted sessions, digests and `skills sessions show`, and `skills publish` and `skills review reply` refuse text that holds one.
- **A lost recovery rotation is always reported** ([#423](https://github.com/ryuudotgg/skills/pull/423))\
  When a background sync settles a recovery rotation whose code was never shown, the next `skills hub sync`, `invite`, `revoke` or `recovery rotate` now prints the line telling you to rotate again, instead of the notice vanishing into the quiet run.
- **Playbook spawns leave pinned models alone** ([#369](https://github.com/ryuudotgg/skills/pull/369))\
  The playbook asks for a Task `model` per role unless the agent's frontmatter pins one or a routed skill settles it, which agrees with the panel skills, and its routed skills list now names blast-radius and no-comments. The authoring playbook's model list includes `inherit`.
- **Hub sync keeps plan and ctx edits saved while it lands a pull** ([#334](https://github.com/ryuudotgg/skills/pull/334))\
  `skills hub sync` checks a plan or ctx file again just before it writes a pulled revision over it or moves it into `done`, so an edit saved meanwhile stays on disk and the next sync weighs it against the pull.
- **Plan and ctx files that cannot land say why** ([#334](https://github.com/ryuudotgg/skills/pull/334))\
  A plan or ctx file that `skills hub sync` cannot land, such as one the CLI cannot read, now prints `refused path <path>: <reason>` on every sync until it lands, where it used to be skipped without a word.
- **Brief prints the probe that the wave runs** ([#305](https://github.com/ryuudotgg/skills/pull/305))\
  `skills brief`, `plans wave` and `plans lint --overlap` read a plan's `## Probe` the same way, so a sentence above a fenced `rg` command is never printed as the probe. Tab indented lines and `~~~` fences count as probe commands for all three.
- **Greptile and CodeRabbit see their check past the first page** ([#466](https://github.com/ryuudotgg/skills/pull/466))\
  `skills round` now reads the `Greptile Review` run and the `CodeRabbit` status even when the head carries more than 100 checks, so a pending review waits and Greptile's dashboard threshold still applies.
- **CodeRabbit stops re-reviewing PRs with over 100 commits** ([#466](https://github.com/ryuudotgg/skills/pull/466))\
  On a PR with more commits than the round can see, CodeRabbit reads its re-review budget as spent, as Macroscope already does.
- **Lease conflicts stay in every `skills hub sync`** ([#428](https://github.com/ryuudotgg/skills/pull/428))\
  `skills hub sync` prints each standing lease conflict and counts it until the lease is broken or the holder releases, including one the sync after a plans verb recorded.
- **Redaction stays fast on already redacted text** ([#297](https://github.com/ryuudotgg/skills/pull/297))\
  Transcripts that quote earlier redacted output, holding thousands of redaction markers, now redact in time proportional to their length instead of slowing down quadratically.
- **Quarantined machine events no longer supply facts** ([#354](https://github.com/ryuudotgg/skills/pull/354))\
  A synced `machine` event quarantined as malformed, out of sequence, off chain or revoked no longer gives a machine its checkout paths, capabilities, label or place in a `run on` list, and `skills sessions list` falls back to the newest visible label, or `-`.
- **`plans close` stamps the row's own merge** ([#316](https://github.com/ryuudotgg/skills/pull/316))\
  `plans close` stamps the newest merge of the row's branch into the default branch since the row started, and refuses a landed draft that names another branch.
- **Fork PRs no longer count as a row's PR** ([#316](https://github.com/ryuudotgg/skills/pull/316))\
  `plans set-row`, `plans start` and `plans below` ignore a PR from a fork that shares the row's branch name.
- **Install keeps agent and hook copies saved while it runs** ([#456](https://github.com/ryuudotgg/skills/pull/456))\
  An agent or hook copy that changes while `./install.sh` is deciding whether it owns it is left in place, with a `skip` line saying it changed while install.sh ran, instead of being overwritten or pruned.
- **Update rollback never resets over unsaved edits** ([#304](https://github.com/ryuudotgg/skills/pull/304))\
  When `skills update` rolls back a failed release and git cannot snapshot your tracked edits, it now stops with `rollback stopped to keep edits` and leaves the checkout as it is, instead of resetting over them.
- **Rollback removes what the failed release added** ([#304](https://github.com/ryuudotgg/skills/pull/304))\
  A rollback after a failed `skills update` now prunes the Claude agents and hooks that only the failed release installed, when their bytes still match what it shipped.
- **Session upload stops on time past oversized lines** ([#315](https://github.com/ryuudotgg/skills/pull/315))\
  A transcript full of lines too large to upload no longer keeps `skills hub sync` past its deadline: each run sets aside at most one such line once time is up and leaves the rest for the next run.
- **Rule notes print on every install** ([#380](https://github.com/ryuudotgg/skills/pull/380))\
  A bad `AGENT_RULES` value or override in skills.conf now prints its note on every install run, machines with only Codex or only OpenCode included, and each note prints once. The Codex rules output no longer says `already holds every skills rule` while it leaves a change on a `left   codex` line.
- **The playbook's process rule allows `skills reap`** ([#332](https://github.com/ryuudotgg/skills/pull/332))\
  The playbook's Autonomy rule now names `skills reap` as the one exception to never stopping a process you did not start, so a handback that reaps its own simulators, containers and servers no longer reads as breaking it.
- **Babysit reports layers a late `lease-rebase` refusal moved** ([#332](https://github.com/ryuudotgg/skills/pull/332))\
  Babysit now says a `lease-rebase` refusal after its push leaves the layers it printed moved and pushed, and reports them as rewritten, instead of claiming a refusal moves nothing.
- **Audit times review only windows and subagent waits honestly** ([#469](https://github.com/ryuudotgg/skills/pull/469))\
  `skills audit` no longer reads a review only window as an edit when a read only seat's brief or a prompt mentions `workspace-write`, and its waiting on subagents share now counts the time a foreground Agent call runs.
- **Restacks leave a switched holder's branch alone** ([#322](https://github.com/ryuudotgg/skills/pull/322))\
  When a checkout holding a layer switches to another branch while `skills lease-rebase`, `skills fix-round` or `skills restack-layer` moves that layer, the other branch is put back where it was and the run refuses naming both branches, or says it could not restore it.
- **Lease-rebase refuses every DOING layer it does not own** ([#322](https://github.com/ryuudotgg/skills/pull/322))\
  `skills lease-rebase` refuses any layer with a DOING row outside `SKILLS_OWN_ROWS` before it fetches or moves anything, whether another checkout, the calling one or none holds it.
- **Workflow agents count as subagents** ([#444](https://github.com/ryuudotgg/skills/pull/444))\
  `skills sessions scan` now folds the tokens and tool calls of each Workflow agent into its session's stats and subagent count, and `skills audit` lists Workflow agents in its subagent table, while the `journal.jsonl` beside them is never read as a transcript.
- **A waiting invite prints the device a sync approved** ([#431](https://github.com/ryuudotgg/skills/pull/431))\
  `skills hub invite` prints `device <label> added by <label>` before it returns, also when a background sync approved the join for it.
- **A plan that turns out unnecessary closes fully** ([#389](https://github.com/ryuudotgg/skills/pull/389))\
  When `/plans do` finds every acceptance criterion already holds, the thread writes the plan's `## Landed` section and runs `plans close ... DROPPED`, so the plan file moves to `done/`, the thread stops counting as live and any issue it resolved loses it as a resolver.
- **Env values stay redacted after a worktree is removed** ([#465](https://github.com/ryuudotgg/skills/pull/465))\
  `skills hub sync` and `skills sessions show` keep replacing `.env` values in a session whose worktree was merged and removed, reading them from this machine's checkout of the session's project instead.
- **A DOING plan keeps its heartbeat when index.tsv is missing** ([#317](https://github.com/ryuudotgg/skills/pull/317))\
  The heartbeat reads the branch's DOING rows from the plans store, so a missing or stale `index.tsv` no longer leaves the row looking stale.
- **Hub start command quotes paths holding >** ([#386](https://github.com/ryuudotgg/skills/pull/386))\
  The hub start and logs commands the installer prints now single quote a checkout path that holds `<` or `>`, so pasting them no longer redirects the shell.
- **Hub verbs say what happened on a failed call** ([#339](https://github.com/ryuudotgg/skills/pull/339))\
  A hub answer cut off mid read now reports the hub as unreachable, a proxy error is no longer sent twice, and a `skills hub sync` stopped by an item too large to send still prints its landed, conflict and summary lines before the error.
- **Dashboard fetch refuses a stuck gh instead of hanging** ([#300](https://github.com/ryuudotgg/skills/pull/300))\
  `skills update` and `skills dash fetch` now refuse within a second when `gh` exits while a child process still holds its output, where they used to wait on that child, and name the signal when `gh` is killed by one.
- **OpenCode asks no longer loosen a personal deny unasked** ([#313](https://github.com/ryuudotgg/skills/pull/313))\
  A managed OpenCode ask that would override part of a personal deny now counts as weakening, even when personal allows for the exact commands sit between them, so a flag run leaves it on a `left` line and only a confirm at a terminal writes it. OpenCode only.
- **A failed adopt keeps edits made while it ran** ([#351](https://github.com/ryuudotgg/skills/pull/351))\
  When `skills plans adopt` fails, it undoes only its own changes, so a file edited or created in the checkout while it ran stays as it was. When it cannot switch the checkout back, it leaves the plan's branch in place and says so.
- **Reply leaves a thread open when someone joins as it posts** ([#449](https://github.com/ryuudotgg/skills/pull/449))\
  `skills review reply` reads the thread again after its reply posts, so a comment someone added in the meantime keeps the thread open and the verb exits 1 instead of resolving it.
- **Install docs list every installer question** ([#345](https://github.com/ryuudotgg/skills/pull/345))\
  Getting Started and the Rule Levels reference say the rules prompt comes when the Claude Code, Codex or OpenCode directory exists, and Getting Started names the hub and arm roster questions. The Delivery Modes installer tab turns on Macroscope and Linear, and its hands-off line works whichever extensions you saved.
- **Agents overview says where rules are enforced** ([#345](https://github.com/ryuudotgg/skills/pull/345))\
  The overview's matrix shows what `AGENT_RULES` writes for Claude Code, Codex and OpenCode, in place of the claim that nothing enforces the rules outside Claude Code.
- **Hook pages match the reply guard and session brief** ([#345](https://github.com/ryuudotgg/skills/pull/345))\
  The reply guard page says a drafted reply names no plan id, and the session brief page lists the hub membership lines that end the brief.
- **Review rounds read triggers and Macroscope checks on every page** ([#330](https://github.com/ryuudotgg/skills/pull/330))\
  `skills round` now sees a reviewer trigger buried under more than 100 later comments and a `Macroscope - Correctness Check` past the head's first 100 checks.
- **Macroscope waits when a head check read can succeed later** ([#330](https://github.com/ryuudotgg/skills/pull/330))\
  A head check read that fails for a reason that can pass on retry makes Macroscope read `wait unreadable` instead of `handback refused`, and the other reviewers decide as usual.
- **`/plans wave` and the sweep call T3 tools that exist** ([#299](https://github.com/ryuudotgg/skills/pull/299))\
  In T3 Code, `/plans wave` reads its thread's model with `t3_thread_configure` and the sweep reads a thread's queue with `t3_queue`, and the plans skill's usage lines and resume, batch and sweep sentences match what the CLI prints.
- **Outgoing text check refuses file URLs to a home path** ([#468](https://github.com/ryuudotgg/skills/pull/468))\
  `skills review reply` and `skills publish` now refuse a body holding a `file:` URL whose decoded path is a home path, and judge a plan id the way the drafted reply guard does, ignoring `http` and `https` URLs and counting any decimal digits.
- **Typed pushes check the repository they push from** ([#320](https://github.com/ryuudotgg/skills/pull/320))\
  In prs mode the commit guard reads a typed push's repository the way the shell resolves it: `git -C ~/<dir> push` expands against your home directory, a Codex push run from a `workdir` is checked there instead of the session's cwd, and a `-C` path that bash and zsh would read differently is refused.
- **README describes the installer as it runs** ([#378](https://github.com/ryuudotgg/skills/pull/378))\
  The README says the rules prompt appears when the Claude, Codex or OpenCode directory exists, and quotes the `bun install` flags `install.sh` passes.
- **A moved transcript keeps its upload place beside a copy** ([#381](https://github.com/ryuudotgg/skills/pull/381))\
  When a session has a copy elsewhere and you rename the project folder holding the transcript that `skills hub sync` uploads, the sync carries on where it stopped instead of uploading the transcript again from its first line, and lines written under `stats` stay local.
- **Agents find transcripts for dotted paths** ([#296](https://github.com/ryuudotgg/skills/pull/296))\
  The playbook agent, Session pickup and `show-me-your-work` now say every character other than an ASCII letter or digit becomes `-` in a transcript directory name, so a checkout like `/Users/you/.t3/worktrees/app` resolves to the right folder.
- **Playbook agent knows the plans store** ([#296](https://github.com/ryuudotgg/skills/pull/296))\
  The playbook agent now lists the `REVIEW` status, names `plans.db` as the store and treats `log.tsv` and `index.tsv` as views, changing rows only through the `skills plans` verbs.
- **A failing eval grade fails the run** ([#448](https://github.com/ryuudotgg/skills/pull/448))\
  `skills eval <case> --grade` now exits 1 when the grader's last line is a failing count or holds no count, and says which in its last `eval failed:` line.
- **A refused command no longer counts as hidden** ([#448](https://github.com/ryuudotgg/skills/pull/448))\
  The `skills eval` hide check reads `UNCHECKED` for a direct run of the hidden command that Claude Code refused, or whose miss names it only inside a path.
- **Skill links survive unusual install layouts** ([#311](https://github.com/ryuudotgg/skills/pull/311))\
  `./install.sh` skips a tool directory that resolves to the skills store, so a store at `~/.claude/skills` or behind a symlink keeps every link pointing at the checkout. It also finds the Cursor, OpenCode and Copilot skills directories under a home path with a space, and a rerun leaves a link that already points at the right place untouched.
- **Commit guard judges the push git will really run** ([#352](https://github.com/ryuudotgg/skills/pull/352))\
  The commit guard now counts `git --config-env alias.<name>=<envvar>` as a push in both modes, also nested or hard to parse, and refuses a typed push whose refspec the shell could rewrite, such as an unquoted `{main,topic}` or `#x`. Where `push.default` is `upstream` or `tracking`, the plain `git push origin <branch>` is refused with a block naming the `refs/heads/<branch>:refs/heads/<branch>` form, which still passes.
- **Skipped `PR_BODY` and `AGENT_DISCLOSURE` values get a settings note** ([#413](https://github.com/ryuudotgg/skills/pull/413))\
  `skills review reply` and `skills publish` print a `settings:` line on stderr when a `PR_BODY` or `AGENT_DISCLOSURE` value in `skills.conf` or git config is invalid or set twice, so `AGENT_DISCLOSURE=yes` no longer reads as off without a word.
- **`plans wave` probes what the plan's shell would run** ([#447](https://github.com/ryuudotgg/skills/pull/447))\
  A probe with an unquoted glob in its pattern or a flag, or a `$` or backtick expansion inside double quotes, now shows as unprobed in `plans wave` and `plans lint --overlap` instead of running `rg` on a word the plan's own shell would have rewritten.
- **`skills check` reads prompt lines in code fences** ([#368](https://github.com/ryuudotgg/skills/pull/368))\
  A fenced command line written with a shell prompt, `$ skills <verb> ...`, now gets the same verb and flag check as the line without the prompt, so a stale `$ skills` example fails the check.
- **Single layer fix rounds work on an older git** ([#298](https://github.com/ryuudotgg/skills/pull/298))\
  `skills fix-round` and `skills restack-layer` on a branch with no layer above it no longer refuse with `git replay lacks --ref-action`; only a run that replays an upper layer needs a `git replay` that supports it.
- **An open dashboard drops revoked events without a reload** ([#398](https://github.com/ryuudotgg/skills/pull/398))\
  When a hub sync quarantines events a revoked device wrote, or restores ones it had quarantined, an open `skills dash` page catches up within one feed poll instead of keeping what it already showed.
- **Install keeps skills.conf edits made during its prompts** ([#373](https://github.com/ryuudotgg/skills/pull/373))\
  A line added to skills.conf while `./install.sh` waits at a prompt stays in the file next to the choices made there. If the file changes again just before the write, the installer leaves it alone and says so in one `install.sh:` line.
- **Weekly digest counts imported events in the week they happened** ([#353](https://github.com/ryuudotgg/skills/pull/353))\
  `skills digest` places closes and phase times by when each event was recorded, as `/stats` does, so plans whose trail lines were imported after the week ended still show in that week and in the next digest's prior week figures.
- **Macroscope waits on a queued approvability check past the first page** ([#454](https://github.com/ryuudotgg/skills/pull/454))\
  On a head with more than 100 checks, a queued `Macroscope - Approvability Check` now reads `wait approval-pending` under the cap, as it does on the first page, so a critical plan can still reach `handback not-approved`.
- **Watch names a changes requested review** ([#430](https://github.com/ryuudotgg/skills/pull/430))\
  `skills pr watch` ends a blocked PR whose checks pass but whose review asks for changes as `changes-requested` with exit code 6, instead of reporting failing checks.
- **The hub drops a moved plan's pack once it is no longer needed** ([#394](https://github.com/ryuudotgg/skills/pull/394))\
  A pack `skills plans move` uploads no longer stays on the hub for good: once the move is adopted, started again, replaced by changed work or refused before it records, the machine that ended it deletes the pack's chunks at its next `skills hub sync`.
- **`skills publish` refuses on reads it cannot trust** ([#301](https://github.com/ryuudotgg/skills/pull/301))\
  `skills publish` stops before pushing when it cannot read the branch's origin tip, when a single commit's title breaks the message rule, or when `gh stack` is installed but fails. A branch cut from the trunk no longer asks about `gh stack` at all.
- **Untimed transcript lines next to a `stats` period stay local** ([#371](https://github.com/ryuudotgg/skills/pull/371))\
  A transcript line with no recorded time now stays on this machine when a `stats` period falls anywhere between the timed lines around it. Loosening a project from `stats` with `skills sessions policy` also refuses when a transcript folder exists but cannot be listed.
- **`plans log` refuses an id with no row** ([#377](https://github.com/ryuudotgg/skills/pull/377))\
  `skills plans log` now refuses an id the project's index holds no row for, such as `12` for `012`, naming the index and writing nothing, so a handback can no longer land on a row that does not exist. The ad hoc id `-` still logs with no row.
- **Session scans count a moved transcript once** ([#321](https://github.com/ryuudotgg/skills/pull/321))\
  `skills sessions scan` picks up where it left off after a Claude project folder is renamed or `CLAUDE_CONFIG_DIR` or `CODEX_HOME` moves, so a session's tokens no longer double and the move alone records no new stats.
- **A shared thread gets one nudge per stall** ([#450](https://github.com/ryuudotgg/skills/pull/450))\
  `/plans resume` and `/plans threads resume` send one message per stall to a thread that a batch's rows or a stack's layers share, and a nudge logged under any of them holds the rest, with the hourly limit and the idle cap counted once for the thread.
- **Deny rules stop lease pushes and the relative installer** ([#397](https://github.com/ryuudotgg/skills/pull/397))\
  The permission rules now stop `git push --force-with-lease` and the installer run as `skills/playbook/bin/skills install` or `update` without the leading `./`, in Claude Code, Codex and OpenCode. The entries arrive on the next `./install.sh` or `skills update`.
- **Stacked merges close once their parent lands** ([#372](https://github.com/ryuudotgg/skills/pull/372))\
  `plans sweep` closes a plan whose PR merged into a parent branch once that parent's PR merges into the default branch, stamping the landed draft with the parent's merge, and `plans start` lets the plans it blocked start on the default branch. A parent whose PRs cannot be read stops the sweep with `unreadable` instead of reporting `elsewhere`.
- **`skills eval` stays inside its run directory when `GIT_DIR` is set** ([#347](https://github.com/ryuudotgg/skills/pull/347))\
  A run started from a shell that exports `GIT_DIR`, `GIT_WORK_TREE` or another repository selector builds and pushes its own repositories and leaves the one those variables name untouched. Other git settings such as `GIT_SSH_COMMAND` still reach the agent and the grader.
- **Adopted plans keep their new files tracked** ([#399](https://github.com/ryuudotgg/skills/pull/399))\
  `skills plans adopt` marks each file the moved plan added as intent to add, so `git status` shows it as ` A` and `git commit -a` includes it, while modified files still arrive unstaged.
- **Wave holds plans leased on another machine** ([#344](https://github.com/ryuudotgg/skills/pull/344))\
  `skills plans wave` no longer launches a ready plan another device has pinned or whose lease is in conflict. It prints `held <id>: pinned by <label>` or `held <id>: conflict with <label>` instead, the same mark `plans frontier` shows, and a sibling that overlapped only that plan now launches.
- **Moved transcripts resume their upload** ([#349](https://github.com/ryuudotgg/skills/pull/349))\
  After a project folder rename or a new `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, `skills hub sync` carries on uploading a transcript where it stopped instead of sending the whole history again as a new series. Lines withheld before the move stay withheld.
- **Hub pages match the code** ([#435](https://github.com/ryuudotgg/skills/pull/435))\
  The Leases, Recovery, Security and hub overview pages, and the `/plans wave` row of The Loop, now say how wave holds pinned and conflicting rows, what `skills hub status` prints on a copied store, and who signs each chain entry. A hub run with Compose now takes `LITESTREAM_RESTORE_TIMEOUT` from its host, and the Backups table lists it with its 300 second default.
- **`skills pr green` waits for a settled merge state** ([#338](https://github.com/ryuudotgg/skills/pull/338))\
  A PR whose merge state GitHub has not computed yet holds with `mergeability unknown` instead of reading green, and a head that moves on every pass stops at the timeout with exit 1 instead of polling forever.
- **Run on lists skip machines without the project** ([#390](https://github.com/ryuudotgg/skills/pull/390))\
  A plan's `run on` list no longer names a machine that has no checkout of a project called `constructor` or `__proto__`.
- **The dashboard names a feed line that is not JSON** ([#390](https://github.com/ryuudotgg/skills/pull/390))\
  When the hub sends a feed line that is not JSON, the dashboard shows `feed line N is not an event` as the unreachable reason instead of the parser's own error.
- **Audit reads the stores set by CLAUDE_CONFIG_DIR and CODEX_HOME** ([#318](https://github.com/ryuudotgg/skills/pull/318))\
  `skills audit` now finds Claude projects under `CLAUDE_CONFIG_DIR` and Codex sessions under `CODEX_HOME` when either is set, as `skills sessions` already did, and `--project-dir` still overrides the Claude side.
- **Rules skip lines name an unreadable skills.conf** ([#414](https://github.com/ryuudotgg/skills/pull/414))\
  When skills.conf cannot be read, the Codex and OpenCode rules skip lines name its path instead of printing `( is invalid)`, and OpenCode no longer offers an empty rule set to paste.
- **`skills round drive` sees human activity past the newest 100** ([#440](https://github.com/ryuudotgg/skills/pull/440))\
  Before handing off, drive now reads every page of comments and reviews made since the head arrived, so a human comment or review buried under 100 later bot or author entries still stops the call, and an earlier page it cannot read ends in `wait` instead of `handoff`.
- **An index or trail saved during a plans write keeps its bytes** ([#453](https://github.com/ryuudotgg/skills/pull/453))\
  A plans write that finds `index.tsv` or `log.tsv` saved while it was writing them now keeps the saved file and refuses with the sentence that names `skills plans import`, and `skills plans import` that finds a missing index recreated while it restores it keeps that file and asks to be run again.
- **Agents rerun a partial hub sync** ([#325](https://github.com/ryuudotgg/skills/pull/325))\
  The hub skill says a `skills hub sync` that exits 75 with a `left` line made progress and should run again until it exits 0, and every line it and the hub verbs print is now in their grammar.
- **Hub moves finish however long the upload takes** ([#323](https://github.com/ryuudotgg/skills/pull/323))\
  `skills plans move` and `skills plans adopt` through the hub no longer give up 30 seconds after they start, so a large pack on a slow link reaches the other machine; each request still times out on its own when the hub stops answering.
- **A failed hub move resumes where it stopped** ([#323](https://github.com/ryuudotgg/skills/pull/323))\
  Running `skills plans move` again after an upload failed sends only the pack chunks the hub does not hold yet, instead of the whole pack under new names.
- **Moves no longer wait on unrelated hub work** ([#323](https://github.com/ryuudotgg/skills/pull/323))\
  `skills plans move` prints that the move waits to reach the hub only when its own move or the plan's lease has not reached the hub, not because other uploads are still queued.
- **`skills reap` keeps servers an ad hoc run still uses** ([#416](https://github.com/ryuudotgg/skills/pull/416))\
  A listener or compose project working in a closed plan's checkout is kept while an ad hoc run on that branch has not handed back, and reaped once it has.
- **Reap keeps a new run on a reused branch name** ([#424](https://github.com/ryuudotgg/skills/pull/424))\
  `skills reap` no longer frees an ad hoc branch's simulator, AVD, servers or compose project because an earlier run under the same name handed back: a local branch created after that handback is held until it hands back itself.
- **Plans with unread needs wait instead of starting** ([#384](https://github.com/ryuudotgg/skills/pull/384))\
  A ready plan with no file on disk whose newest revision has no bytes on this machine now shows `needs unknown` in the frontier, and `skills plans start`, `skills plans wave` and ctx batches hold it back instead of starting it as if it had no needs.
- **`skills round` names an unknown `skills.conf` key once** ([#336](https://github.com/ryuudotgg/skills/pull/336))\
  An unknown key in `skills.conf` now gets one `settings:` line from `skills round`, where it used to repeat once per active reviewer. `PLANS_DISPOSABLE` counts as a known key, so neither `skills round` nor `skills settings` calls it unknown anymore.
- **Interrogate reviews only the files you name** ([#471](https://github.com/ryuudotgg/skills/pull/471))\
  When `/interrogate` is pointed at specific files or a diff, every reviewer, Codex included, reads only that scope instead of the whole dirty tree, and the code quality lens reports every finding with its severity rather than holding back small ones.
- **Sweep flags checkouts it cannot read** ([#376](https://github.com/ryuudotgg/skills/pull/376))\
  `skills plans sweep` prints `unreadable` and exits 1 when it cannot read a closed plan's PR or compare its checkout with that PR's head, instead of reporting the checkout as `unpushed`.
- **Flag runs confirm Codex rule changes** ([#438](https://github.com/ryuudotgg/skills/pull/438))\
  `./install.sh` with flags at a terminal now applies a weakening Codex rule change you accepted in the Claude prompt, and asks `Apply these Codex changes?` for the rest, instead of leaving them on `left codex` lines.
- **Lines written under stats stay local after the policy loosens** ([#361](https://github.com/ryuudotgg/skills/pull/361))\
  `skills hub sync` holds back every transcript line a session wrote while its policy was `stats`, even when no sync ran during that time or the change came from another machine. Loosening a policy with `skills sessions policy` first passes over what the project's sessions already have on disk.
- **`plans set-row` REVIEW keeps a row moved during the check** ([#436](https://github.com/ryuudotgg/skills/pull/436))\
  In prs mode `skills plans set-row <Project> <id> REVIEW` writes nothing when another writer changes the row's status, branch or start while its PR is checked, and asks to set REVIEW again, so a row moved to a new branch, closed or started again is never marked REVIEW on the old branch's green result.
- **Quarantined events no longer hide new pr and round records** ([#415](https://github.com/ryuudotgg/skills/pull/415))\
  A `pr` or `round` event the hub quarantined no longer stops the same outcome from being recorded again, and the newest pick breaks ties the way every other store read does.
- **OpenCode catalog reads stop hanging on a held pipe** ([#451](https://github.com/ryuudotgg/skills/pull/451))\
  `skills arms` and the install roster step report a service `opencode` left holding its output within about a second, instead of waiting 15 s for "did not finish", and an `opencode` that ignores SIGTERM no longer outlives the CLI.
- **A hung tailscale no longer holds hub status** ([#421](https://github.com/ryuudotgg/skills/pull/421))\
  `skills hub status` and the installer give up on `tailscale status` after two seconds even when tailscale ignores the stop signal or leaves a child holding its output, and report the tailnet as unread.
- **`skills plans import` skips a removed project folder** ([#433](https://github.com/ryuudotgg/skills/pull/433))\
  When a project folder is deleted from the plans directory, the import treats that project as retired. It still takes in edits to every other view and file, and it does not recreate the folder.
- **Update leaves a checkout that moved mid run alone** ([#350](https://github.com/ryuudotgg/skills/pull/350))\
  `skills update` checks the checkout again right before it moves it, so a branch switch, a new commit or an edit made while the release was being verified refuses instead of being swept into the update. A rollback after a failed installer no longer resets a branch that was switched to or committed on during the update, and prints `rollback stopped because the checkout moved` instead.
- **Session digests hide secrets added after a turn was saved** ([#360](https://github.com/ryuudotgg/skills/pull/360))\
  Every uploaded session digest redacts its earlier prompts and replies again with the secrets known when it is built, so a `.env` value the redactor hides, added later in the session, no longer appears in the next chunk's digest.
- **Session redaction catches `.env` values in JSON numbers and markers** ([#360](https://github.com/ryuudotgg/skills/pull/360))\
  A `.env` value written as a number on a JSON line, or inside text shaped like `[redacted:<value>]`, now becomes `[redacted:env]` like anywhere else in a transcript.
- **Session digests list only what you typed** ([#360](https://github.com/ryuudotgg/skills/pull/360))\
  A Claude session's digest no longer shows a compaction summary or a block of local command output as a prompt, in the upload and in `skills sessions show --digest`, the dashboard and `plans adopt`.
- **A waiting hub invite no longer blocks sync** ([#319](https://github.com/ryuudotgg/skills/pull/319))\
  While `skills hub invite` waits for its join, `skills hub sync`, the quiet sync, `plans move`, `plans adopt` and other hub verbs on the same machine run instead of refusing, since the invite holds the store's lock only while it writes.
- **Dashboard fetch writes nothing until the build checks out** ([#395](https://github.com/ryuudotgg/skills/pull/395))\
  `skills update` and `skills dash` download and check the dashboard build before they create any directory, so a failed download or a bad sum leaves the dashboard folder untouched, and a slow download can no longer be swept away by another run.
- **Slow adopts still check the hub lease** ([#314](https://github.com/ryuudotgg/skills/pull/314))\
  `skills plans adopt` asks the hub for the plan's lease however long its pull and unpack took, so another machine's lease still refuses it and `lease provisional, hub offline` prints only when the hub is really down.
- **Merged BLOCKED rows close and their branches hold the wave** ([#358](https://github.com/ryuudotgg/skills/pull/358))\
  `plans sweep` closes a BLOCKED row with a branch once its PR merges into the default branch, and stays quiet about one whose PR is open, closed or missing. `plans wave` holds every ready plan that shares a probe path with such a row, or all of them while its probe cannot run.
- **`skills recall --limit` prints more than 50 hits** ([#306](https://github.com/ryuudotgg/skills/pull/306))\
  `skills recall <query> --limit <n>` now prints `n` hits whenever that many documents match, where any limit above 50 used to stop at 50.
- **`skills check` judges review arm invocations** ([#379](https://github.com/ryuudotgg/skills/pull/379))\
  A review arm line is now flag checked even when an option value holds spaces, such as `-C <abs working directory>`, and it fails unless its last `sandbox_mode` config override is `read-only`.
- **OpenCode confirmations expire when your rules change** ([#408](https://github.com/ryuudotgg/skills/pull/408))\
  A loosened OpenCode rule you accepted at the prompt is no longer written when any personal permission, policy or legacy permission key changed in either global config file after the preview. The group stays as it was and the run names it on a `left` line, so a deny you add later always wins.
- **Eval hide check needs a real miss** ([#312](https://github.com/ryuudotgg/skills/pull/312))\
  `skills eval` now marks a hidden command `HIDDEN` only when a `which` or `command -v` lookup came back empty or printed a miss for it. A lookup Claude Code refused to run, or one that resolved the name to a shell function or alias, reports `UNCHECKED` and fails the run.
- **`skills pr green` keeps a review blocked PR green when only a reviewer check failed** ([#429](https://github.com/ryuudotgg/skills/pull/429))\
  A failed reviewer check under a review block no longer turns the verdict red, and a failed check the list shows prints its `failing` line alone. `blocked <rollup>` now appears only for a failed run the check list hides.
- **Hub requests survive a device joining or leaving** ([#331](https://github.com/ryuudotgg/skills/pull/331))\
  A request that reaches the hub while a device is admitted or revoked now gets its normal answer, checked against the updated membership, instead of a `chain-moved` refusal, so a `skills hub join` poll no longer fails at the moment its device is admitted.
- **A founded hub refuses vault posts unread** ([#359](https://github.com/ryuudotgg/skills/pull/359))\
  A hub that already holds a vault answers `POST /v1/vault` with 409 `vault-exists` before it reads the request body, so a caller with no credential can no longer make it hold up to 32 MiB per request.
- **Recovery works on long chains** ([#327](https://github.com/ryuudotgg/skills/pull/327))\
  `skills hub recover` enrolls a device however many epochs the vault has rotated through, where the hub used to refuse its entry as too large once the chain grew long.
- **Join requests no longer grow the hub without limit** ([#310](https://github.com/ryuudotgg/skills/pull/310))\
  The hub now admits a join request only while it holds fewer than 1024, live and expired together, deleting the oldest expired ones to make room, and a table over that size from an earlier release shrinks by up to 256 a request, so unauthenticated `POST /v1/pair` calls can no longer fill its database.

### 🧰 Internal

- **Hook tests prove no update run by state** ([#434](https://github.com/ryuudotgg/skills/pull/434))\
  The session start tests that expect no update run read the update state file as soon as the hook returns instead of sleeping 300 ms, and the heartbeat test for the default branch drops the `index.tsv` rows no assertion read.
- **Plans verbs share one checkout owner module** ([#402](https://github.com/ryuudotgg/skills/pull/402))\
  The checkout owner rule `skills reap`, `skills device`, `plans schedule` and `threads resume` share now lives in packages/cli/src/plans/owner.ts, lint.ts and overlap.ts reuse the one `PLAN_FILE` and `asciiLower`, and eleven values only their own module reads lose their export.
- **Pr modules hold each piece once** ([#419](https://github.com/ryuudotgg/skills/pull/419))\
  `GhGitHubReader` reads the origin remote through its injected runner, `pr watch` and `pr green` share `systemClock` from policy.ts, the watch loops share its clamped `remainingBudget`, `reviewerDeclarations` lives in reviewers/declaration.ts, the dead check detail code and unused types are gone, and the `pr green` grammar lists its `rule unmet` line.
- **Diff selection runs every suite that reads a changed path** ([#329](https://github.com/ryuudotgg/skills/pull/329))\
  `skills test` now runs bun for an agent definition, bun and typecheck for the OpenCode plugin and reviewer modules, and the dashboard suite for the hub server, the CLI hub client, the plans and sessions verbs and the live hub harness. The deleted-views suite runs its files in parallel.
- **Quiet sync skips session reads it does not need** ([#443](https://github.com/ryuudotgg/skills/pull/443))\
  The push gate opens `sessions-scan.db` and builds the session policy map only once a session record is pending, a deletion pass with nothing new to tombstone opens no write transaction, `sessions show` reads only its own session's scan row, and the duplicated transcript helpers in packages/cli/src/sessions and packages/cli/src/evals have one copy each.
- **Eval stubs name the command that ran** ([#443](https://github.com/ryuudotgg/skills/pull/443))\
  A fixture miss in an eval stub now reports `opencode stub:` or `gh stub:` after the command the stub stands in for, where every stub used to say `gh stub:`.
- **Test commands end their leftover children** ([#400](https://github.com/ryuudotgg/skills/pull/400))\
  packages/cli/src/test/process.ts ends whatever a command left running in its own process group before the result settles, so `skills test` no longer removes a suite's TMPDIR under a background child or waits out the pipe grace for one.
- **Stack verbs and publish share their git plumbing** ([#409](https://github.com/ryuudotgg/skills/pull/409))\
  `skills publish` reads the recorded base through the stack verbs' reader, one write core in src/write.ts backs both process runners, and one `fetchRemoteTip` serves every stack verb's origin read. The push outcome and read fault tests share one three layer spec, and restack.test.ts moved into lease-rebase.test.ts.
- **Installer tests ignore your exported settings** ([#391](https://github.com/ryuudotgg/skills/pull/391))\
  The installer fixtures share one environment from `installerEnvironment` in packages/cli/src/test/process.ts, which clears every variable the installer reads, so an exported `SEED_DIRS` or `PLANS_DIR` no longer leaks into a test run. The dashboard lock case waits on a stdin handshake instead of fixed sleeps, and the hung `codex execpolicy check` case calls `applyCodexRules` with a 200 ms timeout.
- **One Session key builder in skills-core** ([#396](https://github.com/ryuudotgg/skills/pull/396))\
  skills-core exports `sessionKey` from sessions.ts, and the CLI's sessions code, `sessionKeyOf`, the plan page and the stats page all build Session keys through it.
- **Transcript reader copies a long line once** ([#315](https://github.com/ryuudotgg/skills/pull/315))\
  `lines` in packages/cli/src/sessions/transcripts.ts keeps an unfinished line as the reads it came in and joins them once at its newline, so a line spanning many reads costs its length instead of its square.
- **Version PR fits the GitHub description limit** ([#459](https://github.com/ryuudotgg/skills/pull/459))\
  The Release run opens the version PR even when the pending notes outgrow the 65,536 character limit GitHub puts on a description. The description drops the text of its last categories first, then lists only as many titles as fit, and the changelog still holds every note.
- **Read fault tests skip two real waits** ([#370](https://github.com/ryuudotgg/skills/pull/370))\
  The PostToolUse and `skills check` cases in read-faults.test.ts inject the held `readSync` failure in process instead of waiting out the 5 s deadline, so the file runs about 10 s faster.
- **Placeholder check test no longer spends the playbook cap** ([#332](https://github.com/ryuudotgg/skills/pull/332))\
  The `skills check` placeholder test appends its script paths to a playbook file instead of `skills/playbook/SKILL.md`, so it stops failing whenever that file sits within a few hundred bytes of its 14000 byte cap.
- **One isFile and one active reviewer rule** ([#422](https://github.com/ryuudotgg/skills/pull/422))\
  The CLI's identical `isFile` copies collapse into the one io.ts exports, and the round, drive, review reply and resolve, `skills reviewers --active` and `skills settings` decide who is active through `isActiveReviewer` in delivery.ts.
- **Docs build accepts the CLI's .ts imports** ([#422](https://github.com/ryuudotgg/skills/pull/422))\
  The docs tsconfig sets `allowImportingTsExtensions` like every other project in the repo, so the docs type check passes when a CLI module it imports has a value import ending in `.ts`.
- **prs-delivery eval expects no gh stack probe** ([#363](https://github.com/ryuudotgg/skills/pull/363))\
  The prs-delivery expectation tells the grader that `skills publish` on a branch cut from the trunk makes no `stack` or `extension` call, matching what publish.test.ts pins, so a run without a `stack --version` line passes.
- **One shell quoting rule for the installer** ([#386](https://github.com/ryuudotgg/skills/pull/386))\
  The installer, hook commands and session restore quote words through one `shellWord` in shell.ts, `commandFor` renders every hook command, and install.ts stops mutating the rules input it shares with the Codex and OpenCode planners.
- **The hung read watch test runs in one second** ([#366](https://github.com/ryuudotgg/skills/pull/366))\
  The spawned `skills pr watch` test in whole-pr.test.ts now runs with `--timeout 1`, checks that its `gh` shim started before the deadline cut the read, and finishes in about a second instead of five.
- **Drop dead CLI exports** ([#461](https://github.com/ryuudotgg/skills/pull/461))\
  `WRITE_LIKE` leaves hooks/payload.ts, and the helpers only their own file calls in arms.ts, delivery.ts and fast-mode.ts are no longer exported.
- **OpenCode verifier shares its shell and model helpers** ([#392](https://github.com/ryuudotgg/skills/pull/392))\
  scripts/verify-opencode.ts sends its forced push case through `shellRun` like the other shell cases, and one helper splits the model id for both sessions that need it.
- **Store reads cost what they return** ([#393](https://github.com/ryuudotgg/skills/pull/393))\
  Project reads in `packages/cli/src/plans/projection.ts` skip the trail, a pulled file's gone check reads only its own path, and the newest heartbeat or start per plan and the brief's lease line come out of SQL scoped to what they print.
- **Note check reads the merge result** ([#388](https://github.com/ryuudotgg/skills/pull/388))\
  The Tegami Note check counts only notes the pull request's merge result adds over its first parent, so a pull request stacked on a squash merged parent needs its own note.
- **Tests keep plan scratch out of /tmp** ([#427](https://github.com/ryuudotgg/skills/pull/427))\
  Every plan scratch path the CLI makes or cleans resolves under one root, and the test preload points it at a fresh directory for each run, so `bun test` never touches a real `/tmp/plans-<id>`.
- **Hub and plans tests share their fixtures** ([#404](https://github.com/ryuudotgg/skills/pull/404))\
  The move, adopt, files and leases tests take their git, store and hub helpers from test/hub-checkout.ts and test/hub-machines.ts, lease tests ask the hub through a fresh leaser after each sync, and `skills plans pin` and `skills plans lease break` have tests for their usage errors and refusals.
- **Contributor docs match the code** ([#378](https://github.com/ryuudotgg/skills/pull/378))\
  CONTRIBUTING lists every path the style checks cover, AGENTS.md says when the Latest Image job moves `:latest`, `evals/README.md` describes the `arms` file once, and the eval fixtures use `P1` in their pri column.
- **Trim the reviewer test suites** ([#439](https://github.com/ryuudotgg/skills/pull/439))\
  The Greptile ledger drops its 18 skipped usage rows, the CodeRabbit case table drops two unread fields, one threshold pattern test in `reviewers/declaration.test.ts` covers all three reviewers, and the round and review suites take their git and result helpers from the shared fixtures, with test names that say what each asserts.
- **Hub client keeps one copy of its byte helpers** ([#418](https://github.com/ryuudotgg/skills/pull/418))\
  The hub client's base64 helpers live in hub/base64.ts, enroll.ts compares bytes with skills-core's `equal`, plans/adopt.ts and plans/pack.ts hash with the `sha256` from plans/store.ts, and names used only in their own file are no longer exported.
- **Plans tests share one repo builder** ([#417](https://github.com/ryuudotgg/skills/pull/417))\
  The plans, cross-project, wave and issues tests build their repositories through `initRepo` in test/fixtures.ts with no signing flag, and the session start notify test proves no second update run starts by reading the state file instead of sleeping.
- **Update tests share the dashboard release fixture** ([#401](https://github.com/ryuudotgg/skills/pull/401))\
  The `skills update` suite builds its dashboard releases through the shared `dashboardRelease` test helper, so packing a build, its asset stubs and its broken sums live in one place.
- **Verifier scripts under the style checks** ([#383](https://github.com/ryuudotgg/skills/pull/383))\
  The typecheck, `lint`, `format` and `stanza` now cover `scripts/*.ts`, and CONTRIBUTING.md has a Manual verifiers section saying what `scripts/verify-claude-rules.ts` and `scripts/verify-update-move.sh` prove and how to run them.
- **CONTRIBUTING says where the Codex flag check runs** ([#368](https://github.com/ryuudotgg/skills/pull/368))\
  The Checks section states that the Codex flag check reads the installed `codex --help` and is skipped wherever `codex` is not on PATH, the CI Checks job included.
- **The sessions ledger suite runs in process** ([#374](https://github.com/ryuudotgg/skills/pull/374))\
  packages/cli/src/sessions/ledger.test.ts calls the scan, list and policy verbs and the session start recording directly on a machine built by `ledgerMachine()`, and starts the CLI only for the hook's own output and the OpenCode plugin, so the file runs in under a third of its old time. The test preload drops every `GIT_*` variable, so in process git calls see the fixture checkout even when bun runs inside a git hook.
- **Plans verbs run in process** ([#410](https://github.com/ryuudotgg/skills/pull/410))\
  `plans frontier`, `add`, `log`, `close` and `lint` in verbs.ts take an Io for their output, working directory, environment and project detection, so the close tests drive them in process instead of spawning the CLI.
- **Closed status defined once** ([#385](https://github.com/ryuudotgg/skills/pull/385))\
  `isClosed` in packages/core/src/rows.ts is the one rule for DONE and DROPPED, and plan selection, blocker release, lease release, issue folding, the pr and round dedupe and stats all call it instead of keeping their own set.
- **Plans store rules live in one place** ([#411](https://github.com/ryuudotgg/skills/pull/411))\
  plans/copies.ts holds the copy key rules, the event row decoder and the newest first order, store.ts `renderView` renders both views for every write, round trip and restore, and trail.ts names the trail file once. Disk reads of working copies and views share `readIfPresent`, and `blobBytes` is the only blob reader.
- **Drop dead docs files and share the plugin helpers** ([#302](https://github.com/ryuudotgg/skills/pull/302))\
  The docs app loses its unused page dump script, its `cn` reexport, the unused `TypeTable` and `useMDXComponents` registrations and its `cn` dependency, and its remark plugins share `repoRoot` and `readNamedFrontmatter` from `apps/docs/lib/repo.ts`. The root `.gitignore` drops its Python lines, since the repo holds no Python.
- **Restraint evals get control twins** ([#463](https://github.com/ryuudotgg/skills/pull/463))\
  `named-destination` and `stale-assertion` keep the prompts of `wrong-destination` and `weakened-assertion` but make the opposite action correct, so a skill edit that always asks or never touches a test fails a case.
- **`wrong-destination` grades the gate it runs** ([#463](https://github.com/ryuudotgg/skills/pull/463))\
  Its first expectation now looks for the destination gate's `plans lint` before the question, since the gate runs before `plans start` cuts the branch and a correct run has no branch to show.
- **Cap the plans skill size** ([#333](https://github.com/ryuudotgg/skills/pull/333))\
  `skills check` fails when `skills/plans/SKILL.md` grows past 22000 bytes, beside the existing playbook cap.
- **One reader for skills.conf values** ([#437](https://github.com/ryuudotgg/skills/pull/437))\
  The skills.conf key readers in packages/cli/src take their values from `confValues` in delivery.ts instead of each filtering and slicing `KEY=` rows.
- **One payload guard module in skills-core** ([#390](https://github.com/ryuudotgg/skills/pull/390))\
  skills-core reads unknown payloads through the record and text guards in `packages/core/src/payload.ts`, and `statsOf` drops a silenced project's tokens by reading the silenced set alone.
- **Releases refuse notes merged after the version run** ([#382](https://github.com/ryuudotgg/skills/pull/382))\
  The Publish workflow stops before the tag when the release commit still holds a note no changelog section consumed, and the version PR's Tegami Note fails early on the same check, each naming the notes and the recovery in the Releasing section of AGENTS.md.
- **One isDirectory and one state file writer** ([#464](https://github.com/ryuudotgg/skills/pull/464))\
  `packages/cli/src/io.ts` exports `isDirectory` and `writeJsonAtomic`, which replace seven private directory checks and the temporary file writers of the heartbeat throttle, the reply guard state, the machine refresh marker and `skills-update.json`, so all four state files now end with a newline.
- **Rule groups table moves to its own reference** ([#346](https://github.com/ryuudotgg/skills/pull/346))\
  The installer now reads the permission rule groups from `skills/playbook/references/rule-groups.md`, and `deny-set.ts` names that file in its refusals, so delivery.md carries only the rules an agent acts on.
- **Reviewer modules share one kit** ([#309](https://github.com/ryuudotgg/skills/pull/309))\
  The login matcher, the worst level pick and the open thread read live in `packages/cli/src/round/reviewer-kit.ts`, and CodeRabbit drops its `disabled` skip, which never changed a verdict.
- **PTY install tests skip the timers and the full store copy** ([#458](https://github.com/ryuudotgg/skills/pull/458))\
  interactive.test.ts types each answer on the next tick instead of after 40 ms, and its bootstrap case seeds Bun's cache with only the packages `skills-cli` installs in production, walked from packages/cli/package.json, instead of the whole store.
- **Hub tests cover pairing and lease refusals** ([#340](https://github.com/ryuudotgg/skills/pull/340))\
  The hub suite now checks the expired invite, full invite and full pending table refusals, joiners reading `expired`, a lapsed lease passing to another device, the purge of lease operations after 30 days, and the purge of signature digests after ten minutes, moving time with the hub clock.
- **Drop unused hub request leftovers** ([#365](https://github.com/ryuudotgg/skills/pull/365))\
  The hub's request core loses the unread `logged` match field, the `Context` type parameter and the unreachable `vault-exists` arm in `settled`, with every reply unchanged.
- **The recover read drops its wraps list** ([#327](https://github.com/ryuudotgg/skills/pull/327))\
  `GET /v1/recover` in apps/hub/src/chain.ts answers with the head and the entries only, since no reader used the wraps it also sent.
- **Hub routes share one member access rule** ([#337](https://github.com/ryuudotgg/skills/pull/337))\
  The hub routes admitting only members now name one `MEMBER` access from route.ts, blobs.ts reads a tombstone through one helper, and seven names used only inside their own modules are no longer exported.
- **The hub suite runs the long chain test on request** ([#367](https://github.com/ryuudotgg/skills/pull/367))\
  The recovery test that signs a chain up to the last epoch now runs only with `HUB_TEST_LONG_CHAIN=1`, and the default run checks the recover route's body cap in membership.test.ts with one large junk entry instead.
- **One route builder and one poll loop in the dashboard** ([#403](https://github.com/ryuudotgg/skills/pull/403))\
  apps/dashboard/src/links.ts builds every `/plan` and `/sessions` path, `/withheld` and `/sync` share one private loop in client.ts, and views drop the unused `empty` fallback text.

## 1.2.1

*November 14, 2026*

### 🎨 Improved

- **Docs cover the hub** ([#290](https://github.com/ryuudotgg/skills/pull/290))\
  The docs site has a Hub section on joining or starting a hub, the three network modes, what the hub can and cannot see, the recovery code and backups, and leases. The configuration reference adds `HUB_URL`, `HUB_NETWORK` and `HUB_KEYS`.

### 🐛 Fixed

- **Long hub syncs drain a big backlog** ([#294](https://github.com/ryuudotgg/skills/pull/294))\
  `skills hub sync` with more backlog than one run can move now stops inside its budget, records the run for `skills hub status`, and exits 75 after a `left` line naming the events, blobs and transcript bytes still to go, so rerunning it while it exits 75 drains the queue. Uploads are no longer cut off mid body, and a blob too large to send in any run stops the sync with a sentence naming its size.
- **Hub verbs name a stalled reply instead of a raw timeout** ([#291](https://github.com/ryuudotgg/skills/pull/291))\
  When the hub starts answering but its reply stalls past the deadline, `skills hub` verbs now say the hub did not answer in time, where they used to print `The operation timed out.` with no context.
- **`skills hub init` and `skills hub recover` ask for the code at a terminal** ([#293](https://github.com/ryuudotgg/skills/pull/293))\
  At a terminal, `init` without `--code` and `recover` print a prompt, read the code without echoing it and go on after Return, where they used to wait silently for Ctrl-D. An empty line or Ctrl-D stops with a sentence saying how else to pass the code, and a piped code or `--code` works as before.
- **Hub logs a dropped request as aborted** ([#292](https://github.com/ryuudotgg/skills/pull/292))\
  A request whose connection drops before the hub answers now logs `aborted` in place of a status, and an upload cut off mid body writes no `hub internal error`, so a 500 in the hub's logs always means a real fault.

## 1.2.0

*November 12, 2026*

### 🚨 Heads up

- **Codex invokes hand invoked skills only as $name** ([#232](https://github.com/ryuudotgg/skills/pull/232))\
  Codex no longer lists the hand invoked skills or opens one because a prompt describes it, so saying "challenge this" stops firing `interrogate` there. Type the skill as `$name`, such as `$interrogate`, to open it.

### ✨ New

- **Read one session with `skills sessions show`** ([#282](https://github.com/ryuudotgg/skills/pull/282))\
  `skills sessions show <id>` prints a session's fields, its models and its tools, and with `--digest` its prompts and final replies read from the local transcript, redacted and clipped. `skills plans adopt` now ends with the digest of each session linked to the adopted plan.
- **Issues block and resolve plans** ([#237](https://github.com/ryuudotgg/skills/pull/237))\
  `skills issues file --blocks` makes a plan wait on the new issue, `skills issues link` and `skills plans add --resolves` name the plans that resolve one, and closing those plans closes the issue and frees every plan waiting on it. `skills plans frontier` ends with the project's open inbox, and the session brief counts it.
- **Releases ship the dashboard build** ([#265](https://github.com/ryuudotgg/skills/pull/265))\
  Each release carries the dashboard and a `SHA256SUMS` file, and `skills update`, `./install.sh` and `skills dash` download it, check its sha256 and unpack it into `~/.agents/dashboard/<version>/`. A missing asset or a bad sum prints one line and never fails the update or the install.
- **One plan runs on one machine at a time** ([#268](https://github.com/ryuudotgg/skills/pull/268))\
  With a hub, `skills plans start` refuses a plan another machine holds, records a provisional lease when the hub is offline, and `skills plans pin` reserves a plan for up to 30 days. The frontier names the machine holding each plan, and `skills plans lease break` settles a conflict.
- **Enroll machines in a plans hub** ([#251](https://github.com/ryuudotgg/skills/pull/251))\
  `skills hub init`, `invite`, `join`, `devices`, `revoke`, `recover`, `recovery rotate`, `sync` and `status` found a vault on a hub, enroll and revoke machines, and recover or rotate the recovery code, verifying the membership chain before every signature. Only `join`, `devices`, `status` and `sync` carry an allow rule, since the others change who can read the vault.
- **Sync plans between machines through the hub** ([#260](https://github.com/ryuudotgg/skills/pull/260))\
  Enrolled machines now share events, plan files and their revisions through the hub, encrypted and signed on the machine that wrote them: every plans write and session start syncs in the background for up to two seconds, `skills hub sync` runs a full pass and prints what moved, and `skills hub status` shows the queue, quarantined, fetching, history and conflict counts. An edit made on two machines at once stays on both disks as a conflict that `skills plans show --conflict` prints, and a restored or replaced hub is reconciled on the next sync.
- **Disclose agent posts with `AGENT_DISCLOSURE`** ([#255](https://github.com/ryuudotgg/skills/pull/255))\
  With `AGENT_DISCLOSURE=on` in skills.conf, or `skills.agent-disclosure` in a repository's local git config, each reviewer thread reply and agent written PR body starts with "An agent posted this on behalf of this account." and a blank line. Left unset, replies and bodies post as written.
- **Issue inbox for each project** ([#217](https://github.com/ryuudotgg/skills/pull/217))\
  `skills issues file` files a request into another project's inbox and prints its ref, such as `Beta#1`, and `skills issues list`, `skills issues show` and `skills issues close` read and close it. Issues live only in the plans store, so no index, plan file or `log.tsv` line changes.
- **Per project transcript policy with `skills sessions policy`** ([#248](https://github.com/ryuudotgg/skills/pull/248))\
  `skills sessions policy <Project> full|redacted|stats|off` sets how much of a project's sessions may be recorded and shared, and `skills sessions list` shows each session's policy in a last column. Under `off` nothing new is recorded for that project's sessions and `sessions list` hides them; the verb has no allow rule, so your agent host asks you before an agent changes a policy.
- **Frontier view in the dashboard** ([#244](https://github.com/ryuudotgg/skills/pull/244))\
  The `/frontier` route of `skills dash` lists each project's ready, blocked, review and doing rows in the order `skills plans frontier` prints them, with blockers in other projects and issues resolved the same way, each project's open issues, and a graph of what blocks what.
- **Stalled plans show as stale** ([#269](https://github.com/ryuudotgg/skills/pull/269))\
  The post tool use and stop hooks record a heartbeat for the plan on the current branch at most every 5 minutes, and `/plans` and the session brief mark a DOING plan with no heartbeat for 30 minutes as `(<label>, stale <n> min)`.
- **`skills recall` searches plans across projects** ([#249](https://github.com/ryuudotgg/skills/pull/249))\
  `skills recall <query>` finds the plans, ctx files, closed plans, trail lines and issues that mention a thing across every project on this machine, best match first, with `--project`, `--limit` and `--json`. It records edited plan files first, so a change made a moment ago is found by its new text.
- **Pick up another machine's session with `skills sessions restore`** ([#277](https://github.com/ryuudotgg/skills/pull/277))\
  `skills sessions restore` writes each Claude Code or Codex session another machine shared through the hub into this machine's own transcript folders, with that machine's paths moved to your checkout and home, and prints the `claude --resume` or `codex resume` line to continue it. It never overwrites a file the host already has, and `--project` and `--since` narrow what it restores.
- **The plans store knows the machine it runs on** ([#211](https://github.com/ryuudotgg/skills/pull/211))\
  `skills machine show`, `label` and `refresh` print and record this machine's label, OS, tool versions and project checkouts, and the session start hook adds a `Machine` line to the session context and refreshes those facts in the background once a day.
- **Plans can say which machines run them** ([#218](https://github.com/ryuudotgg/skills/pull/218))\
  A plan can carry `needs: xcode, docker` and the like in its frontmatter. `plans start` then refuses it on a machine that lacks one and names the machines that can run it, the frontier shows the needs and `--next` skips the plan, `/plans wave` holds it, and `plans lint` names any word outside the set.
- **`skills dash` serves a local dashboard** ([#215](https://github.com/ryuudotgg/skills/pull/215))\
  `skills dash --dist <dir>` serves a dashboard build on 127.0.0.1 behind a token it prints in the URL, and the browser reads this machine's plans store through an authenticated, read only feed. The app shell has its seven views, each still an empty state, plus a time travel control; without `--dist` the verb refuses with a reason until releases ship the build.
- **Eval history in the dashboard** ([#220](https://github.com/ryuudotgg/skills/pull/220))\
  The `/evals` page of `skills dash` lists each eval case's runs newest first with models, roster, exit code, result, grade, duration and machine, shows the results in time order as a strip, narrows to one model or one roster, and marks a case `regressed` when a run failed right after a pass.
- **Weekly digest with `skills digest`** ([#270](https://github.com/ryuudotgg/skills/pull/270))\
  `skills digest [--week <YYYY-MM-DD>]` writes one digest per ISO week into the plans store: closes, phase times against the prior week, plans that came back from review, recurring hook blocks, the slowest phase, tokens per model, eval regressions and lessons for `/plans new`. With `DIGEST_WEEKLY=on`, `/plans schedule` registers it for Monday at 09:00.
- **Digests page in `skills dash`** ([#270](https://github.com/ryuudotgg/skills/pull/270))\
  The dashboard's Digests view shows one digest per week, newest first, and marks a digest written before its week ended as partial.
- **Hub sync uploads session transcripts** ([#271](https://github.com/ryuudotgg/skills/pull/271))\
  `skills hub sync` scans sessions first, then uploads redacted transcript chunks and their digests for every session its project's policy allows, and lowering a project to `stats` or `off` deletes the chunks already sent and prints `deleted <n> blobs`. `skills hub status` adds `transcripts: <n> chunks pending, <m> withheld`.
- **The dashboard lists sessions and shows each one's digest** ([#283](https://github.com/ryuudotgg/skills/pull/283))\
  The Sessions view in `skills dash` lists every session newest first with its plan, models, tokens, tool calls, duration and machine, and opens one as its prompts, final replies, tool calls and tokens: from this machine's transcript, or from the synced digest for a session another machine recorded. A project under policy `stats` shows only the numbers, and one under `off` disappears from every view, its name included.
- **Each release publishes the hub image** ([#257](https://github.com/ryuudotgg/skills/pull/257))\
  Every release pushes `ghcr.io/ryuudotgg/skills-hub:<version>`, built for amd64 and arm64 from the tagged commit, and the newest release also moves `:latest`.
- **`skills dash` keeps the hub sync running and shows its state** ([#286](https://github.com/ryuudotgg/skills/pull/286))\
  With a hub configured, `skills dash` syncs at start and every 5 seconds, so events from your other machines appear without a reload, and every view shows `synced`, the queue and conflicts, or `offline:` with the reason `skills hub status` gives. With no hub the dashboard reads `local only` and never contacts one.
- **Session ledger with `skills sessions scan` and `skills sessions list`** ([#219](https://github.com/ryuudotgg/skills/pull/219))\
  Every Claude Code, Codex and OpenCode session start is recorded in the plans store and linked to the plans on its branch, and `skills sessions scan` reads the token, model and tool counts out of local transcripts so `skills sessions list` can show them per session or per plan.
- **Plans can wait on another project's plan** ([#210](https://github.com/ryuudotgg/skills/pull/210))\
  `blocked_by` accepts refs such as `Stanza/168`, checked by `skills plans add`, and the frontier holds the row with `waits on Stanza/168` until that plan is DONE or DROPPED in its own project, while `/plans do` refuses to start it before then.
- **Pick up a moved plan on this machine** ([#278](https://github.com/ryuudotgg/skills/pull/278))\
  `skills plans adopt <Project> <id>` takes a plan that `plans move` sent, from the hub or from the file `--file` names, and checks its branch out in this machine's recorded checkout with the moved commits, edits, untracked files and resume note, then takes the lease and prints the `/plans do <id>` line to carry on. A pack that fails its checksum, a dirty checkout, an existing branch or a base origin lacks refuses before anything changes, and a failure partway puts the checkout back as it was.
- **`/plans new` checks closed plans before writing** ([#263](https://github.com/ryuudotgg/skills/pull/263))\
  `/plans new` searches every project's closed plans with `skills recall` before it writes a batch, skips any plan a done one already landed, and lists what it found under `## Prior work` in the batch's ctx file.
- **Hub sync carries every project file** ([#267](https://github.com/ryuudotgg/skills/pull/267))\
  `skills hub sync` now carries every other file under a plans project, such as assets, evidence and baselines, in encrypted 1 MiB chunks, so an edit uploads only the chunks it changed. A `.plansignore` in the plans directory or a project takes gitignore patterns, symlinks are skipped and listed, and a pulled file never replaces a local edit or writes through a symlink.
- **Agent written PR bodies with `PR_BODY`** ([#247](https://github.com/ryuudotgg/skills/pull/247))\
  With `PR_BODY=agent` in skills.conf, or `skills.pr-body` in a repository's local git config, `skills publish --body <file>` sets the file as the PR description after the outgoing text check, and keeps any body someone already wrote. Left unset, publish opens every PR with an empty body as before.
- **Join or start a plans hub from the installer** ([#266](https://github.com/ryuudotgg/skills/pull/266))\
  `./install.sh --with hub` at a terminal asks whether to join an existing hub or start a new one, then runs the join or prints the compose command and the `skills hub init` step. Without a terminal, `--hub-url` and `--hub-network` write `HUB_URL` and `HUB_NETWORK`, and `--without hub` removes them.
- **Plan page in the dashboard** ([#233](https://github.com/ryuudotgg/skills/pull/233))\
  The `/plan/<Project>/<id>` page of `skills dash` shows the plan's newest text, a timeline of its row changes, trail events, PR verdicts and review rounds, every recorded revision with a diff between any two, and the sessions that worked on it with their tokens, all stopping at the chosen time under time travel.
- **Reviewers gain a `role` setting** ([#224](https://github.com/ryuudotgg/skills/pull/224))\
  `skills settings <reviewer>` prints `role=required` by default, and `<REVIEWER>_ROLE=advisory` in `skills.conf` or `skills.<reviewer>.role` in local git config changes it. Nothing acts on the value yet, so every round ends the way it does today.
- **Move a half done plan to another machine** ([#276](https://github.com/ryuudotgg/skills/pull/276))\
  `skills plans move <Project> <id>` packs a DOING plan's commits, edits, untracked files and resume note into one archive and sends it through the hub to a machine named with `--to`, or to any machine, or writes it to the file `--file` names. The checkout is left as it was, the frontier shows the row as moving, and `plans start` refuses it everywhere but the target.
- **Board view in `skills dash`** ([#275](https://github.com/ryuudotgg/skills/pull/275))\
  The dashboard's Board view now lists every plan in progress across projects with its machine, thread link, branch, PR state, heartbeat age and any lease conflict, and marks stale heartbeats and conflicts in the accent colour.
- **Stats page in `skills dash`** ([#264](https://github.com/ryuudotgg/skills/pull/264))\
  The dashboard's Stats view now shows median queue, build and review times, effort against time per closed plan, tokens per model and per plan, plans launched and closed per week, hook blocks per rule and reviewer outcomes, for 7, 30 or 90 days and all projects or one.

### 🎨 Improved

- **The Reviewers page explains roles** ([#253](https://github.com/ryuudotgg/skills/pull/253))\
  The Reviewers page and the configuration reference now say what a required and an advisory reviewer each do to a PR, with an example of each set per repo, and a fix round asks an advisory reviewer for no re-review once the required ones are done.
- **Hooks and verbs record their outcomes for the dashboard** ([#212](https://github.com/ryuudotgg/skills/pull/212))\
  Hook blocks, `skills round decide`, `skills pr green`, `skills round drive`, the plans sweep and `skills eval` now record what they decided in the plans store on this machine, a PR or review round only when it changed. None of it reaches `log.tsv`, and a busy or broken store never changes a hook's verdict.
- **Babysit waits without `/loop` on Codex and OpenCode** ([#246](https://github.com/ryuudotgg/skills/pull/246))\
  A hands-off babysit in `drive` or `background` mode on Codex or OpenCode now waits with one foreground `skills pr watch --timeout 540` call, rerun in the same turn on `TIMEOUT`, instead of being told to run a `/loop` skill those hosts lack; `background` runs as `drive` there.
- **`/plans do` resumes a plan adopted from another machine** ([#280](https://github.com/ryuudotgg/skills/pull/280))\
  `/plans do <id>` on a plan `skills plans adopt` brought onto this machine skips `plans start`, reads the resume note first and carries on from it with the adopted changes left in place. Pause safely runs `plans move` when you name the machine or file the plan goes to, and otherwise names the command in its reply.
- **`/plans wave` runs the close sweep before it launches** ([#279](https://github.com/ryuudotgg/skills/pull/279))\
  `/plans wave` first runs the same sweep as `/plans close` with no id, so each merged plan it closes stops holding the ready plans that share its files before the wave picks what to launch. You no longer run `/plans close` before each wave.
- **`/plans close` with no id leaves its own thread open** ([#279](https://github.com/ryuudotgg/skills/pull/279))\
  The sweep still settles the threads of the plans it closes, but no longer the thread it runs in, so an orchestration thread stays in your active list. The scheduled sweep task settles its own thread as before.
- **Docs cover cross project blockers and the issue inbox** ([#254](https://github.com/ryuudotgg/skills/pull/254))\
  The Plans page explains plan refs and issue refs in `blocked_by`, what releases each, and the `skills issues` verbs, and the session brief page names its `Inbox:` line.
- **A stale layer whose work already landed is reported, not rebased** ([#243](https://github.com/ryuudotgg/skills/pull/243))\
  In prs mode, `/plans review` judges a restacked layer against its goal before pushing, and when the base already does the work or a hunk needs a design call, the layer is not pushed and its row stays BLOCKED with `superseded by <short sha>` or `design conflict in <path>`.
- **`/plans new` reads the inbox and `/plans do` files issues** ([#250](https://github.com/ryuudotgg/skills/pull/250))\
  `/plans new` runs `skills issues list` in its survey and adds the plan that answers an open issue with `--resolves`. `/plans do` files an issue into another project's inbox when its work needs that project's change, then hands back BLOCKED naming the ref, and the index schema documents plan refs and issue refs in `blocked_by`.
- **Terra arms run the terra model** ([#225](https://github.com/ryuudotgg/skills/pull/225))\
  A terra arm now runs `gpt-6.1-terra` at `medium` effort instead of borrowing the sol model, and the tier table is still the one place that pairs each model with its effort.
- **Docs explain the dashboard and the weekly digest** ([#287](https://github.com/ryuudotgg/skills/pull/287))\
  The docs site has a Dashboard page covering `skills dash`, why it runs only on this machine, its views, time travel, the sync state line, where its build comes from and `skills digest`. The configuration reference adds `DIGEST_WEEKLY`, and the hooks overview says each block is recorded with its rule ids.
- **Docs explain `skills recall`** ([#274](https://github.com/ryuudotgg/skills/pull/274))\
  A new Recall page covers what `skills recall` searches, how to read a hit line, its flags and partial matches, how `/plans new` uses it, and that the index stays in `plans.db` with no network request.
- **A babysit reruns a drive wait in the same turn** ([#222](https://github.com/ryuudotgg/skills/pull/222))\
  When `round drive` returns `wait`, the prs babysit reruns it right away instead of ending the turn, and stops BLOCKED only when a second rerun prints the same pending lines.
- **Advisory reviewers no longer hold a layer** ([#241](https://github.com/ryuudotgg/skills/pull/241))\
  `skills round` now leaves an advisory reviewer's wait, re-review, handback or unavailable verdict out of its combined line while a required reviewer is reviewing the head or has reviewed it, so a rate limited or spent advisory bot stops holding the layer. With no required reviewer engaged, advisory reviewers count as required, and with no role set every round reads as before.
- **Questions name each host's own tool** ([#235](https://github.com/ryuudotgg/skills/pull/235))\
  A destination question in the playbook and the questions `/plans new` asks now go through `AskUserQuestion` in Claude Code or `request_user_input` in Codex when the turn lists it, and otherwise end the turn on a final message that opens with the question, so a question no longer reads as a finished turn.
- **Tailscale mode reads your tailnet** ([#288](https://github.com/ryuudotgg/skills/pull/288))\
  In tailscale mode `./install.sh --with hub` reads `tailscale status`, offers the `skills-hub` peers it finds when you join, suggests a free `skills-hub` name when you start a hub, and refuses a hub URL outside `.ts.net` or a machine without Tailscale. `skills hub status` prints `tailnet <name>`, or `offline: tailscale not connected` while the local Tailscale is down.
- **Review triage keeps fixes small and in scope** ([#226](https://github.com/ryuudotgg/skills/pull/226))\
  A review fix is now the smallest change the finding needs, a finding asking for work outside the goal is dismissed as out of scope and listed as a follow-up, and a finding citing a reviewer rule file is checked against that file first.
- **Drive reports armed auto-merge and the merge queue** ([#256](https://github.com/ryuudotgg/skills/pull/256))\
  `skills round drive` prints `#<n> auto-merge armed <method>` and `#<n> in merge queue` when GitHub would land the PR on its own, and `skills pr green` prints the same lines on stderr, so a babysit reply says when a fix round pushed onto an armed or queued PR.
- **Drafted replies separate checked claims from judgment** ([#223](https://github.com/ryuudotgg/skills/pull/223))\
  A drafted reply now says which part a test, a reproduction or a commit checked and which part is the author's judgment, so a reader with only the PR can tell a verified claim from an opinion.
- **The prs handback names each PR's state** ([#261](https://github.com/ryuudotgg/skills/pull/261))\
  In prs mode the handback reply puts one state word after each PR URL, such as `handoff`, `pending`, `review-required` or `red`, read from the last `skills round drive` on that PR, so the state shows without opening the stack table.
- **Docs explain machines and moving a plan** ([#281](https://github.com/ryuudotgg/skills/pull/281))\
  The docs site has a Machines page covering `skills machine`, the `needs:` line and its capabilities, stale rows, and moving a plan with `plans move` and `plans adopt`. The Plans page template shows `needs:`, and the session brief page lists the `Machine:` line.
- **The hub keeps blobs up to 16 MiB** ([#271](https://github.com/ryuudotgg/skills/pull/271))\
  The hub stores a blob of up to 16 MiB, so a transcript line longer than a mebibyte uploads as one chunk.
- **A restack lists the commits a hand resolved rebase dropped or changed** ([#228](https://github.com/ryuudotgg/skills/pull/228))\
  `skills restack-layer` without `--push` now prints a `dropped` line for each commit the rebase left out and a `changed` line for each commit whose patch a hand resolution altered, before its closing line, so the stale layer is judged before anything is pushed.
- **The review arm checks the fixes its findings forced** ([#258](https://github.com/ryuudotgg/skills/pull/258))\
  When a review arm finding forces a behaviour fix before handback, the review arm reads that fix against a ledger of its earlier findings, up to three passes in all counting the first, or five on critical work or an open security, auth, data or concurrency finding, and whatever is still open or disputed goes to the handback's open items.
- **Taking over someone else's PR keeps their commits and credit** ([#227](https://github.com/ryuudotgg/skills/pull/227))\
  An agent handed a PR or branch it did not write states its goal first, stops when trunk already does it, and otherwise builds on a fresh local branch cut from the source head, so every inherited commit keeps its sha and author and the handback names who wrote it.
- **The playbook skill costs less per task** ([#245](https://github.com/ryuudotgg/skills/pull/245))\
  The playbook skill every routed task reads in full is about two kilobytes smaller, with its Principles table unpadded, and `skills check` now fails once it grows past a byte cap, naming the remedy: move detail to `references/` or cut.
- **Docs explain session recording and transcript policies** ([#285](https://github.com/ryuudotgg/skills/pull/285))\
  The docs site has a Sessions page covering `skills sessions` scan, list, show, policy and restore, what each transcript policy sends to the hub, how redaction works and how a restored session resumes on another machine. The session brief page says what the hook records about each session.
- **Hand invoked skills describe themselves in one sentence** ([#230](https://github.com/ryuudotgg/skills/pull/230))\
  The descriptions of `architect`, `blast-radius`, `figure-it-out`, `how`, `interrogate`, `show-me-your-work`, `tdd` and `technical-writing` now say what each skill does instead of listing trigger phrases, and the catalog says only `unslop` and `linear` are written for an agent to route on.
- **Handoff says when the base moved under the PR** ([#262](https://github.com/ryuudotgg/skills/pull/262))\
  When `skills round drive` hands off, it adds how many commits the PR is behind its base and each of the PR's files those commits touched, so you merge knowing what landed underneath. The word stays `handoff`, and a comparison it cannot read prints a note instead.

### 🐛 Fixed

- **A failed PR read no longer ends the review round as a handback** ([#239](https://github.com/ryuudotgg/skills/pull/239))\
  When `skills round` cannot read the PR because GitHub errored or rate limited it, each reviewer reads `wait unreadable` and the round keeps polling to its deadline, and a PR that is gone or out of reach exits 1 with the reason instead of `handback refused`.
- **Review replies refuse home paths and secrets** ([#229](https://github.com/ryuudotgg/skills/pull/229))\
  `skills review reply` now refuses a body that holds a home directory path or a secret, naming the rule and the token, before it reads the thread or posts anything.
- **The Tailscale sidecar keeps its node across restarts** ([#288](https://github.com/ryuudotgg/skills/pull/288))\
  The hub's Tailscale sidecar logs in with its auth key only once, so a restart reuses the saved node instead of logging in again, which a single use key would refuse.
- **Stats leave out projects under policy `off`** ([#270](https://github.com/ryuudotgg/skills/pull/270))\
  A project whose session policy is `off` no longer shows anywhere on the Stats page, so its closes, phase times, hook blocks and reviews stay out like its tokens already did.
- **The tailscale hub prompt names the tailnet host** ([#284](https://github.com/ryuudotgg/skills/pull/284))\
  `./install.sh --with hub` in tailscale mode asks for the sidecar's MagicDNS name and suggests a `ts.net` URL, and the setup steps say which name the sidecar answers on, so the saved `HUB_URL` is one the new hub serves.
- **Babysits stop for people, not past them** ([#259](https://github.com/ryuudotgg/skills/pull/259))\
  `skills round drive` no longer hands off a green PR that has changes requested, still needs an approval, or has a human comment or review newer than its head: it stops with a line naming which, and the babysit hands the layer to you without answering or resolving what the person wrote.
- **`skills pr green` no longer reads a merge GitHub refuses as green** ([#231](https://github.com/ryuudotgg/skills/pull/231))\
  A PR GitHub reports as blocked while every check passed, no review is required or requested and no thread is open now holds with `rule unmet` until the timeout, so a required check that never registered or a ruleset such as signed commits no longer ends `skills round drive` as a handoff.
- **Round drive retries its first PR read** ([#242](https://github.com/ryuudotgg/skills/pull/242))\
  `skills round drive` polls a PR read that fails transiently every 30 seconds within `ROUND_DRIVE_CAP` and carries on once one succeeds, printing `wait` only when the cap passes with no read. A GitHub rate limit now shows as `unreadable rate limited` in its wait line and in `skills pr green`'s hold line.
- **Read only arms start no subagents** ([#240](https://github.com/ryuudotgg/skills/pull/240))\
  The read only block that ends every read only arm's prompt now forbids starting a subagent, a child task or any other model run, so one review or investigation arm stays one reader on every transport.
- **The commit guard catches cherry-pick, revert and am** ([#234](https://github.com/ryuudotgg/skills/pull/234))\
  `git cherry-pick`, `git revert` and `git am` no longer slip past the commit guard. Hands-off mode blocks them like any commit, and prs mode points to `-n` then a shaped `git commit -m`, or to `git apply` for a patch.

### 🧰 Internal

- **Hub crypto primitives in skills-core** ([#214](https://github.com/ryuudotgg/skills/pull/214))\
  `skills-core` gains the WebCrypto primitives the opt in hub will share between the CLI and the server: sealed envelopes, subkeys, device and recovery keys, invites, join MACs, request, event and membership signatures, and the protocol version, with fixed vectors in `packages/core/src/crypto/vectors.json`.
- **Plans store keeps a full text recall index** ([#236](https://github.com/ryuudotgg/skills/pull/236))\
  `plans.db` migrates to schema 4, which adds FTS5 word and trigram tables over every plan, ctx and closed plan section, trail detail and issue, kept current by the fold at the end of each store write in `packages/cli/src/plans/recall.ts`. No verb reads it yet.
- **Eval baselines get a fixed commit date** ([#280](https://github.com/ryuudotgg/skills/pull/280))\
  `skills eval` commits each case's baseline with a fixed author and date, so a case can ship a plan pack that names it, and the new `plans-do-adopted` case checks the pickup.
- **CI no longer depends on apt** ([#280](https://github.com/ryuudotgg/skills/pull/280))\
  The Ubuntu test job downloads a pinned ripgrep release and checks its sha256, and installs Chromium without Playwright's system packages, which the runner image already has, so an unreachable apt mirror no longer fails or stalls every pull request.
- **Hub container image** ([#252](https://github.com/ryuudotgg/skills/pull/252))\
  `apps/hub/Dockerfile` builds the hub into a non root image on a digest pinned `oven/bun` 1.4.4 slim base, with Litestream backing up `/data/hub.db` when `LITESTREAM_REPLICA_URL` is set and restoring it into a new incarnation when the data directory is empty. `apps/hub/compose.yaml` runs it with a published port, and `compose.tailscale.yaml`, layered over it with a second `-f`, puts it behind a Tailscale sidecar joined with `TS_AUTHKEY` instead.
- **Eval cases can seed the plans store** ([#250](https://github.com/ryuudotgg/skills/pull/250))\
  A case's `seed` file runs `skills` commands against its copied plans directory before the prompt, and the `plans-new-inbox` case uses it to file an issue.
- **The source clone install test gets a minute on CI** ([#258](https://github.com/ryuudotgg/skills/pull/258))\
  The PTY test that installs from a source clone copies the whole Bun store first, which runs past 30 seconds on the macOS CI runners, so its limit is now 60 seconds like the other slow PTY test.
- **Docs site joins the workspace** ([#208](https://github.com/ryuudotgg/skills/pull/208))\
  The docs site lives at `apps/docs` as the `skills-docs` workspace, shares the root `bun.lock`, and imports CLI code through the subpaths that `skills-cli` exports, so one developer install at the root covers it.
- **Plans logic lives in the skills-core package** ([#209](https://github.com/ryuudotgg/skills/pull/209))\
  The plans event model, type sets, clock, row and trail folds, frontier and view rendering now live in `packages/core`, a dependency free package a browser can bundle, and the CLI store keeps only SQLite and the filesystem. The `core` test suite checks that it bundles for the browser and imports nothing from the CLI or the apps.
- **Redact secrets from session transcripts** ([#216](https://github.com/ryuudotgg/skills/pull/216))\
  `packages/cli/src/sessions/redact.ts` replaces secrets in transcript text with `[redacted:<rule>]`, using the gitleaks v8.30.1 rule set vendored under `third-party/gitleaks/`, values from `.env` files, and an entropy check after key like names. Nothing calls it yet: the session sync and digest plans build on it.
- **One release for the CLI, the hub and the dashboard** ([#257](https://github.com/ryuudotgg/skills/pull/257))\
  `skills-cli`, `skills-hub` and `skills-dashboard` share one version, tag and GitHub release, and a `.tegami` note may name any of them.
- **macOS test runs stop stalling on fast commands** ([#273](https://github.com/ryuudotgg/skills/pull/273))\
  The test harness starts commands with `Bun.spawn` and settles on its exit promise, since under `bun test` on macOS a `node:child_process` child that exits at once can emit its exit before a listener is attached, and temporary directories are cleaned in process so a git maintenance lock that vanishes mid cleanup no longer fails a test.
- **Hub server in apps/hub** ([#238](https://github.com/ryuudotgg/skills/pull/238))\
  `apps/hub` (`skills-hub`) serves the hub's `/v1` API over one SQLite data directory that holds only ciphertext, public keys, signatures and HMACs, and `packages/cli/src/test/hub-fixture.ts` starts it in process for tests. Nothing ships or calls it yet: the image and the CLI verbs build on it.
- **skills check keeps each Codex mirror paired with its flag** ([#232](https://github.com/ryuudotgg/skills/pull/232))\
  `skills check` fails a skill that sets `disable-model-invocation: true` without an `agents/openai.yaml`, and a mirror beside a skill that does not set it, or one holding anything but that policy, naming the file at fault.
- **Keep hub device keys in the keychain or a private file** ([#221](https://github.com/ryuudotgg/skills/pull/221))\
  `packages/cli/src/hub/keys.ts` creates, reads and deletes a device's signing and wrapping keys: in the macOS login keychain through `security -i`, or under `~/.agents/hub/<device id>/` with `HUB_KEYS=file` and on other platforms. Nothing calls it yet: enrollment builds on it.
- **Recall test builds the transaction closeIssue takes** ([#240](https://github.com/ryuudotgg/skills/pull/240))\
  The recall test that closes an issue now passes the `Tx` that `closeIssue` takes since 3eef9b9, so typecheck passes again on main after 07ba1a5 landed beside it.
- **The CLI lives in packages/cli** ([#207](https://github.com/ryuudotgg/skills/pull/207))\
  The checkout is a Bun workspace with the CLI as the `skills-cli` package under `packages/cli`, its changelog beside it, and `install.sh` installs only that package's runtime dependencies. Contributors install every workspace with `bun install --frozen-lockfile` at the root as before.
- **The plans store can take another device's events** ([#213](https://github.com/ryuudotgg/skills/pull/213))\
  The first open after updating migrates `plans.db`: revision texts move into a `blobs` table, each revision gets a `revision` event, and every view reads events in core's total order, with history, frontier and views unchanged. `applyRemoteEvents` in `packages/cli/src/plans/sync.ts` applies a verified batch of another device's events and blobs, keeps rejected events quarantined, and renders the views they touch the way a local write does.

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
