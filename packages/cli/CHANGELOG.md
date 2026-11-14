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
