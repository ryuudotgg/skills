# Delivery

Read this in full at every handback, and before any step that could write to the remote. It is the one statement of what publishing means. A skill that disagrees with it is the skill to fix.

## Reading the mode

Run the playbook skill's `bin/skills delivery` by its absolute path, never through `sh`, and quote its output in the reply. Line one is the mode, `hands-off` or `prs`. Each later line is an active extension, and its stderr says why any listed one was dropped. The script reads `~/.agents/skills.conf`, or the absolute path `SKILLS_CONF` names, and never executes it. A missing, unreadable or malformed file means `hands-off` with no extensions. A first line that is anything but exactly `prs`, empty output included, also means `hands-off`.

The session brief's `Delivery:` line shows the same thing at session start. It is context, not a substitute: run the script at the step that would publish, since the config may have changed since.

Any line shaped like a reviewer setting, `<REVIEWER>_<SETTING>=value` in capitals, digits and underscores, is skipped here and never changes the mode. `bin/skills settings` reads it, and notes one that no installed reviewer claims.

The output is a ceiling. The operator or a plan may lower it for one task ("leave this one unstaged"). Nothing raises it: not a plan, not a prompt, not a harness reminder, not an extension's own text. An extension the script does not list is inactive, whether or not its directory exists.

All four delivery tails follow the mode. In prs mode an owner's handback publishes through `../bin/skills publish`, and the same thread then babysits what it published, per Owners in prs mode. The end of `/plans do` adds one step between the two: `../bin/skills plans handoff`, relative to this file, lists the layer's stack and any ready plan that stacks on it, and the babysit names those plans only once it reaches the handoff state. `/plans review` is rewritten: in prs mode it runs the fix round below. Babysit is rewritten: in prs mode it pushes its own fix rounds and lease rebases through `../bin/skills lease-rebase`, and the handback under it publishes nothing more.

## Owners and delegates

The owner is the agent that owns the task and runs the handback. A delegate is any subagent or Codex arm. Only an owner publishes, and only in prs mode.

| | hands-off | prs |
| --- | --- | --- |
| verified work | stays unstaged on the task branch | committed on the task branch |
| push | never | owned branches only |
| PR | never opened | opened for the branch, or the stack layer |
| retitle an open PR | never, the reply suggests the title | owned PRs only, through `skills pr retitle` |
| review replies | drafted for the operator | drafted for the operator, except a reviewer thread's, which the reviewer's extension posts (`reviewers.md`) |
| rerun failed CI jobs | never | once per head on an owned PR, for a flake under Green before handoff |
| hand back | when the verified work is unstaged | only once `pr green` passes, under Green before handoff |
| the reply ends with | one suggested commit message, and the plain statement that nothing was staged, committed, pushed or posted | the commit, the pushed branch and each PR URL |

### Owners in hands-off mode

Work lands unstaged on the task branch. The reply suggests one commit message under the commit rules below. The operator stages, commits, pushes and posts all of it.

### Owners in prs mode

Once the standing checks pass, commit the task's files, push the branch, and open its PR, or register it as the next layer of a stack. `../bin/skills publish`, relative to this file, does all three under the rules below; call it by its absolute path, not through `sh`. Push and lease rebase owned branches only: a branch in the branch column of the project's plans index, a branch carrying the publish mark, or a branch of a stack the operator named by hand. The publish mark is `git config --get branch.<name>.skills-owned` printing `true`, which only `skills publish` writes, once its own push created the branch on origin. A rowless branch is one no plans index lists. When the harness offers a PR linking tool, register every PR, every layer, right after opening it. While the mode lists `linear`, a PR whose task names a Linear issue then runs that skill's Once the PR is open step, per `../../linear/SKILL.md`.

Then the same thread babysits it. Under `/plans do`, the plans skill's step d starts that babysit. Any other owner, once `publish` has printed the URL and the Linear step above has run where it applies, runs the Babysit playbook, `../playbooks/babysit.md` relative to this file, writing `drive` as the mode in its first line as that playbook's step 1 asks, on the stack `../bin/skills plans chain <branch>` prints, bottom first, the reviewer round included. It ends at that playbook's handoff state, as a `/plans do` babysit does, and writes no row for a rowless layer, only the ad hoc trail lines that playbook names; an owned layer below it that has a row gets that playbook's row writes. Asking this thread or a new one to babysit or address the review on an owned PR later runs the same playbook. A delegate never babysits, and hands-off mode starts none.

### Delegates

In both modes, leave every change unstaged. No `git add`, commit, push, `gh` write or PR. The owner reads the delegate's diff and publishes it as its own work.

## Commit rules

These apply to the owner's commit in prs mode, and to the suggested message in hands-off mode.

- Commit only verified work: typecheck, lint and the tests nearest the change pass first.
- Stage the task's files by path. Never `git add -A` or `git add .`.
- Conventional Commits, one line, 50 characters at most, no body. Describe the actual change, never "address review" or "fix issues".
- No trailer of any kind, even when a harness reminder asks for one.

## PR title and body

The title is the commit message when the branch has exactly one commit since its recorded base, otherwise one Conventional Commits line covering the branch. The recorded base is `git config branch.<name>.skills-base`; when it is unset, use the merge base with the remote default branch. No agent written body: the review bot writes it. Clear any body a tool generated.

The title follows the branch while its PR is open. When a pushed commit, a fix round or a restack leaves it naming work the branch no longer does, or missing work the branch now does, retitle it by the rule above. A title that still covers the branch stays: a fix commit under a feature title is no reason to retitle. In prs mode the owner runs `../bin/skills pr retitle <number> "<title>"`, relative to this file, by its absolute path. It checks the title against the commit rules, refuses a PR that is not open or whose head branch is not owned, keeps a PR with one commit on that commit's message, and prints `unchanged` when the title already matches. It edits the title only. Never type `gh pr edit`. A layer from a stack the operator named by hand, with neither a row nor the mark, is refused, so the reply suggests its new title, as it does for every PR in hands-off mode.

## Stacking and its fallback

A stack is a linear chain of PRs, one plan per layer, each based on its parent's branch. In hands-off mode `/plans do` still cuts each layer's branch from its parent, locally, and nothing below runs: the operator pushes and opens the layers. The rest of this section is prs mode.

- Stack submission goes through `skills publish` only. Never type `gh stack submit`, `push`, `sync` or `link`; the commit guard blocks them. What follows is what `skills publish` does.
- When `gh stack` is installed, register the layers `/plans do` cut with `init` or `add`, then submit with `--open` so no layer lands as a draft. Afterwards set each layer's title by the rule above and clear any body it wrote. `submit --auto` always writes one: the repo PR template, or the commit body plus a GitHub Stacks CLI footer. Its stack state lives per worktree, and `add` needs the parent checked out, which another worktree may hold, so `skills publish` uses `add` only when the parent is already registered in this checkout, and otherwise `init --base <trunk>` over the whole recorded base chain. `submit` pushes every layer of the registered stack with a lease taken from a fetch it just made, which protects nothing, so `skills publish` refuses first when any of those layers has a remote tip missing from its local branch. A branch cut from the trunk is a single PR, not a stack, so it always takes `gh pr create`.
- When `gh stack` is missing, open each layer with `gh pr create --base <parent branch> --title "<title>" --body ""`, bottom first. Never `--fill`, which writes a body.
- When `gh stack` is installed but fails, stop and report. Do not fall back halfway through a stack.

## The fix round

Read the inline comments, the block of comments outside the diff, and the review bot's summary, all with `gh`, through `bin/skills review read <number>`. It prints each source, `empty` for one that came back empty, and every block of comments outside the diff it found. Read the checks once too, never waiting on a pending one: a failure in the branch's own diff is a finding, one outside it a stale base, reported in hands-off mode and fixed under Green before handoff in prs mode. Fix what is real on the branch that owns the code, as one commit named for the issues fixed. In prs mode `bin/skills fix-round`, called by its absolute path, commits it, pushes it, then lease rebases every owned layer above it and pushes those; an idle holder's checkout moves with its layer, and a rebase conflict moves no layer above the fixed one and names the row and holder of the lowest layer left stale. Before its first write it refuses a holder with a tracked change, an operation in progress, a deleted directory, or a DOING row. A pushed fix that leaves a PR's title wrong for its branch gets a retitle, per PR title and body. In hands-off mode suggest that commit message instead. Draft a reply for each finding that is wrong and hand it to the operator. With a reviewer's extension active, Greptile's for example, its skill posts the reply itself in a reviewer thread through `bin/skills review reply`, resolves each other reviewer thread the pushed commit fixed through `bin/skills review resolve`, and decides whether to spend a re-review. `bin/skills round` runs every active reviewer's gate and decide and folds their verdicts, and the round posts the trigger of each reviewer whose verdict asks for one, without asking the operator, per `reviewers.md` The round; nothing else posts to request one. `reviewers.md` states what a reviewer thread is. A stale layer is brought onto its base by `/plans review <id>` in the checkout that holds it, or for a rowless owned layer by the thread that babysits it, through `bin/skills restack-layer`, passing no `-P` for a rowless one: the rebase and any conflict stay in that checkout, the standing checks run on the result, and only then does its `--push` run lease push the layer on the origin tip read before the rebase and restack the owned layers above. `/plans do` runs this round on each open layer below a new one, bottom first, before it cuts the branch.

## Green before handoff

In prs mode an owner never hands back a PR it pushed to while that PR is red. Its work ends only once `bin/skills pr green <number>...` exits 0 for every owned PR: each check on the head passed, a reviewer's own check aside, and GitHub reports no conflict with the base. It waits while checks run, so run it in the background. Each line it prints that is not `green` or `merged` is the next piece of work. Whether the branch holds its base's tip is read after a fetch of the base.

- `failing`, in the branch's own diff: a fix round.
- `failing`, outside the diff, on a branch missing its base's tip: bring the layer onto its base, the way The fix round brings a stale layer. The moved base often carries the fix.
- `failing`, outside the diff, with the base current and trunk red on the same check: fix it on the branch as its own commit, naming the commit that broke trunk.
- `failing` that the Babysit playbook's step 7 classifies as flake: on a branch holding its base's tip, one `gh run rerun <run id> --failed` per failed run, once per head; on a branch missing it, bringing the layer onto its base is the fresh build. A second identical failure is not flake.
- `blocked`: GitHub still counts a failed run on the head that the check list hides, a cancelled duplicate say. Find it with `gh run list --commit <sha>` and treat it as `failing`.
- `conflicting`: bring the layer onto its base and resolve the conflict in this thread.

`bin/skills plans set-row <Project> <id> REVIEW` runs the same check once and refuses while the row's PR is not green, so a row reaches REVIEW only green. A rowless layer has no row to set and writes none. A reviewer's `handback`, an owner approval or a drafted reply can still end the work, but only once `pr green` passes.

Work stops while red only where the next fix is not the owner's to make: a `closed` PR, a tool refusal such as a rejected push or a busy holder, a fix that needs a checkout another worktree holds, or a `pending` or `unreadable` line that a second full `pr green` run still prints. The row then goes to BLOCKED, `bin/skills plans set-row <Project> <id> BLOCKED - "<that line>"`, which frees it from the live thread without handing it back, and the reply names the line and the next step. A rowless layer skips that write, and its reply quotes the line and names the next step the same way.

## Drafted replies

The same rules bind a reply a reviewer's extension posts, except the hand over below. A draft is read on the remote by people and agents who see only the PR: its diff, commits, threads and linked issues. Name nothing that exists only on this machine. No plan id or slug ("plan 29"), no `ctx-` file, backlog row, local path, session, subagent or skill. Say what the code does and why, and cite a commit sha or a linked issue. Keep it short and human, an engineer's quick reply. The Stop hook's reply guard blocks a draft that names a plan id, and `bin/skills review reply` refuses to post one.

Hand each draft over as its thread URL on one line, then the draft alone in a fenced block with the info string `text`, so the operator copies it as is. Never a blockquote. Inside the block, write no backtick and no path shaped token: a word with a slash and a dotted file name, or one starting with `~` or `/`. The operator's chat renders those as links to files on this machine, even in inline code, so name the code by what it does and point at the commit sha instead. The Stop hook's reply guard blocks a reply that breaks this.

## Never, in either mode

- Merge, by any command.
- Push the default branch.
- Rewrite a pushed commit: no amend, rebase or reset of anything already on the remote, not even to fix a message. The only lease pushes are the ones `skills fix-round`, `skills lease-rebase` and `skills restack-layer` make internally, on owned branches. A typed push is `git push [-u] [-q] origin <branch>` or `git push [-u] [-q] origin refs/heads/<branch>:refs/heads/<branch>`, alone, to an owned branch; the commit guard blocks every other shape.
- Resolve a review thread. The one exception is a reviewer thread that a pushed commit fixed or a posted reply answered, resolved in prs mode by that reviewer's extension.
- Comment, review or reply on a PR or issue. The exceptions, both posted in prs mode by an active reviewer's extension: a comment whose whole body is that reviewer's trigger (`@greptileai` for Greptile), under its review budget, and a reply in a reviewer thread, through `bin/skills review reply`.
- Commit, push or post from a delegate.
- Set `SKILLS_CONF`, or write `~/.agents/skills.conf`. The operator and `install.sh` own the config.
- Write a `skills.*` git config value, by any command or by editing a config file, in any letter case. Reviewer settings are the operator's.

## Rule groups

These are the Claude Code permission rules recommended for each delivery mode, the entries of `permissions` in `settings.json`. Each row is a group with an id, a label, its entries, and a cell per delivery mode. A cell recommends a `deny`, `ask`, or `allow` rule, or `absent` for no rule. `deny-until-guard` is prs only: deny until the commit guard hook is wired, then no rule. A group with an `allow` cell has only `allow` and `absent` cells.

A retired row is `absent` in both modes. It stays so entries pasted from an older printed set can be recognised. `install.sh` writes or prints `deny`, `ask` and `allow` placements alike. It writes strengthening and neutral changes when `AGENT_RULES` is set. At a terminal it lists changes for the person to confirm, ticked, and saves each group they untick as that group's override. Non-terminal runs leave weakening changes for hand edits. A deny cannot be overridden at any settings level, and an allow cannot carve an exception out of one.

| id | label | entries | hands-off | prs |
| --- | --- | --- | --- | --- |
| `merge` | Merge a PR | `Bash(gh pr merge:*)`, `Bash(gh stack merge:*)` | deny | deny |
| `force-push` | Force or mirror push | `Bash(git push --force *)`, `Bash(git push * --force)`, `Bash(git push * --force *)`, `Bash(git push -f *)`, `Bash(git push * -f)`, `Bash(git push * -f *)`, `Bash(git push -fu *)`, `Bash(git push * -fu)`, `Bash(git push * -fu *)`, `Bash(git push -uf *)`, `Bash(git push * -uf)`, `Bash(git push * -uf *)`, `Bash(git push --mirror *)`, `Bash(git push * --mirror)`, `Bash(git push * --mirror *)`, `Bash(git push * +*)` | deny | deny |
| `pr-review` | Review a PR | `Bash(gh pr review:*)` | deny | deny |
| `issue-comment` | Comment on an issue | `Bash(gh issue comment:*)` | deny | deny |
| `pr-comment` | Comment on a PR | `Bash(gh pr comment:*)` | deny | deny-until-guard |
| `skills-conf` | Edit skills.conf | `Edit({conf})` | deny | deny |
| `installer` | Rerun the installer | `Bash(./install.sh *)`, `Bash(sh install.sh *)`, `Bash(sh ./install.sh *)`, `Bash(bash install.sh *)`, `Bash(bash ./install.sh *)`, `Bash({checkout}/install.sh *)`, `Bash(./skills/playbook/bin/skills install *)`, `Bash({checkout}/skills/playbook/bin/skills install *)`, `Bash({agents}/playbook/bin/skills install *)`, `Bash({claude}/skills/playbook/bin/skills install *)`, `Bash(skills install *)`, `Bash(./skills/playbook/bin/skills --root * install)`, `Bash(./skills/playbook/bin/skills --root * install *)`, `Bash({checkout}/skills/playbook/bin/skills --root * install)`, `Bash({checkout}/skills/playbook/bin/skills --root * install *)`, `Bash({agents}/playbook/bin/skills --root * install)`, `Bash({claude}/skills/playbook/bin/skills --root * install)`, `Bash({agents}/playbook/bin/skills --root * install *)`, `Bash({claude}/skills/playbook/bin/skills --root * install *)`, `Bash(skills --root * install)`, `Bash(skills --root * install *)` | deny | deny |
| `claude-settings` | Edit Claude settings | `Edit({claude}/settings.json)` | ask | ask |
| `skills-git-config` | Set a skills git config value | `Bash(git config skills.*)`, `Bash(git config * skills.*)` | deny | deny |
| `publishing` | Commit, push or open a PR | `Bash(git commit:*)`, `Bash(git push:*)`, `Bash(gh pr create:*)`, `Bash(gh pr edit:*)`, `Bash(gh pr ready:*)`, `Bash(gh pr close:*)`, `Bash(gh stack submit:*)`, `Bash(gh stack sync:*)`, `Bash(gh stack push:*)` | deny | absent |
| `skills-cli` | Run skills CLI verbs that publish nothing | `Bash({claude}/skills/playbook/bin/skills plans wave *)`, `Bash({agents}/playbook/bin/skills plans wave *)`, `Bash({claude}/skills/playbook/bin/skills plans resume *)`, `Bash({agents}/playbook/bin/skills plans resume *)`, `Bash({claude}/skills/playbook/bin/skills plans schedule *)`, `Bash({agents}/playbook/bin/skills plans schedule *)`, `Bash({claude}/skills/playbook/bin/skills plans frontier *)`, `Bash({agents}/playbook/bin/skills plans frontier *)`, `Bash({claude}/skills/playbook/bin/skills plans set-row *)`, `Bash({agents}/playbook/bin/skills plans set-row *)`, `Bash({claude}/skills/playbook/bin/skills plans add *)`, `Bash({agents}/playbook/bin/skills plans add *)`, `Bash({claude}/skills/playbook/bin/skills plans log *)`, `Bash({agents}/playbook/bin/skills plans log *)`, `Bash({claude}/skills/playbook/bin/skills threads log *)`, `Bash({agents}/playbook/bin/skills threads log *)`, `Bash({claude}/skills/playbook/bin/skills threads resume *)`, `Bash({agents}/playbook/bin/skills threads resume *)`, `Bash({claude}/skills/playbook/bin/skills plans close *)`, `Bash({agents}/playbook/bin/skills plans close *)`, `Bash({claude}/skills/playbook/bin/skills plans sweep *)`, `Bash({agents}/playbook/bin/skills plans sweep *)`, `Bash({claude}/skills/playbook/bin/skills plans start *)`, `Bash({agents}/playbook/bin/skills plans start *)`, `Bash({claude}/skills/playbook/bin/skills plans lint *)`, `Bash({agents}/playbook/bin/skills plans lint *)`, `Bash({claude}/skills/playbook/bin/skills plans handoff *)`, `Bash({agents}/playbook/bin/skills plans handoff *)`, `Bash({claude}/skills/playbook/bin/skills plans chain *)`, `Bash({agents}/playbook/bin/skills plans chain *)`, `Bash({claude}/skills/playbook/bin/skills plans stack-base *)`, `Bash({agents}/playbook/bin/skills plans stack-base *)`, `Bash({claude}/skills/playbook/bin/skills plans below *)`, `Bash({agents}/playbook/bin/skills plans below *)`, `Bash({claude}/skills/playbook/bin/skills brief *)`, `Bash({agents}/playbook/bin/skills brief *)`, `Bash({claude}/skills/playbook/bin/skills reviewers *)`, `Bash({agents}/playbook/bin/skills reviewers *)`, `Bash({claude}/skills/playbook/bin/skills round gate *)`, `Bash({agents}/playbook/bin/skills round gate *)`, `Bash({claude}/skills/playbook/bin/skills round decide *)`, `Bash({agents}/playbook/bin/skills round decide *)`, `Bash({claude}/skills/playbook/bin/skills settings *)`, `Bash({agents}/playbook/bin/skills settings *)`, `Bash({claude}/skills/playbook/bin/skills review read *)`, `Bash({agents}/playbook/bin/skills review read *)`, `Bash({claude}/skills/playbook/bin/skills pr green *)`, `Bash({agents}/playbook/bin/skills pr green *)`, `Bash({claude}/skills/playbook/bin/skills pr watch *)`, `Bash({agents}/playbook/bin/skills pr watch *)`, `Bash({claude}/skills/playbook/bin/skills delivery *)`, `Bash({agents}/playbook/bin/skills delivery *)`, `Bash({claude}/skills/playbook/bin/skills fast-mode *)`, `Bash({agents}/playbook/bin/skills fast-mode *)`, `Bash({claude}/skills/playbook/bin/skills arms *)`, `Bash({agents}/playbook/bin/skills arms *)`, `Bash({claude}/skills/playbook/bin/skills check *)`, `Bash({agents}/playbook/bin/skills check *)`, `Bash({claude}/skills/playbook/bin/skills audit *)`, `Bash({agents}/playbook/bin/skills audit *)`, `Bash({claude}/skills/playbook/bin/skills device *)`, `Bash({agents}/playbook/bin/skills device *)` | allow | allow |
| `skills-conf-write` | Write skills.conf | `Write(~/.agents/skills.conf)` | absent | absent |

The skills-cli group lets agents run CLI verbs that push, post and install nothing through the Claude skills link and the agents store without a prompt. Each verb declares in the CLI registry whether this group may cover it, and a test fails when the table allows one that does not. Set `AGENT_RULES_SKILLS_CLI=off` in skills.conf to stop the installer adding the group; off leaves entries already written, so remove those from `permissions.allow` by hand. Allow has no effect in bypassPermissions.

The installer expands placeholders per machine: `{claude}` follows `CLAUDE_CONFIG_DIR`, where Claude Code reads its config, `{agents}` follows `AGENTS_DIR` (the skills store), `{conf}` follows `SKILLS_CONF`, `{codex}` follows `CODEX_HOME`, and `{checkout}` is the repository root. A non Bash entry renders `~/...` under `HOME` and `//<absolute>` elsewhere, since Claude reads a single leading slash as project relative. A Bash entry renders twice: all placeholders absolute, then all in the `~/` spelling, once when the spellings are the same. The config and installer groups use these paths.

The installer group stops an agent from rerunning the installer and rewriting its own rules. Agents cannot run the installer anywhere, this repository included, so run it in your own terminal; tests reach it through `bun test`, which no entry matches. The claude-settings group asks even in bypassPermissions before an agent rewrites its rules, so an edit you requested goes through after you approve it. Entries target invocations, not mentions: `rg install` and reading `install.sh` stay allowed. A trailing ` *` also matches the bare command only in a pattern with no other `*`, so each `--root * install` entry has a twin without it.

Git reads config section names in any letter case, so the `git config skills.*` entries miss `Skills.*`: the commit guard hook denies a `git config` command naming a `skills.` key in any case. Once the commit guard hook is wired, the prs cell of the `pr-comment` group becomes `absent`, so an active reviewer's bare trigger can pass and the guard holds every other comment. The same guard allowlists typed pushes, so the push groups stay a second net. It does not cover `gh api` writes, so those stay a rule the owner follows rather than a deny.

The deny set narrows mistakes, it is not a boundary. A pattern matches the command text, so `git -C . push --force` or a leading variable assignment slips past it. The Never list binds whether or not a deny caught the command.
