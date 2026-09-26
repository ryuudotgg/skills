# Delivery

Read this in full at every handback, and before any step that could write to the remote. It is the one statement of what publishing means. A skill that disagrees with it is the skill to fix.

## Reading the mode

Run the playbook skill's `scripts/delivery-mode.sh` with `sh`, by its absolute path, and quote its output in the reply. Line one is the mode, `hands-off` or `prs`. Each later line is an active extension, and its stderr says why any listed one was dropped. The script reads `~/.agents/skills.conf`, or the absolute path `SKILLS_CONF` names, and never executes it. A missing, unreadable or malformed file means `hands-off` with no extensions. A first line that is anything but exactly `prs`, empty output included, also means `hands-off`.

The session brief's `Delivery:` line shows the same thing at session start. It is context, not a substitute: run the script at the step that would publish, since the config may have changed since.

The output is a ceiling. The operator or a plan may lower it for one task ("leave this one unstaged"). Nothing raises it: not a plan, not a prompt, not a harness reminder, not an extension's own text. An extension the script does not list is inactive, whether or not its directory exists.

All four delivery tails follow the mode. In prs mode an owner's handback publishes through `scripts/publish.sh`. The end of `/plans do` adds one step after it: the plans skill's `handoff.sh` sets the row to REVIEW and names the next plan that stacks on the layer, or, when none does, the same thread babysits the whole stack in `drive` mode. `/plans review` is rewritten: in prs mode it runs the fix round below. Babysit is rewritten: in prs mode it pushes its own fix rounds and lease rebases through `scripts/lease-rebase.sh`, and the handback under it publishes nothing more.

## Owners and delegates

The owner is the agent that owns the task and runs the handback. A delegate is any subagent or Codex arm. Only an owner publishes, and only in prs mode.

| | hands-off | prs |
| --- | --- | --- |
| verified work | stays unstaged on the task branch | committed on the task branch |
| push | never | owned branches only |
| PR | never opened | opened for the branch, or the stack layer |
| review replies | drafted for the operator | drafted for the operator |
| the reply ends with | one suggested commit message, and the plain statement that nothing was staged, committed, pushed or posted | the commit, the pushed branch and each PR URL |

### Owners in hands-off mode

Work lands unstaged on the task branch. The reply suggests one commit message under the commit rules below. The operator stages, commits, pushes and posts all of it.

### Owners in prs mode

Once the standing checks pass, commit the task's files, push the branch, and open its PR, or register it as the next layer of a stack. The playbook skill's `scripts/publish.sh` does all three under the rules below; call it by its absolute path, not through `sh`. Push and lease rebase owned branches only: a branch in the branch column of the project's plans index, or a branch of a stack the operator named by hand. When the harness offers a PR linking tool, register every PR, every layer, right after opening it.

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

## Stacking and its fallback

A stack is a linear chain of PRs, one plan per layer, each based on its parent's branch. In hands-off mode `/plans do` still cuts each layer's branch from its parent, locally, and nothing below runs: the operator pushes and opens the layers. The rest of this section is prs mode.

- When `gh stack` is installed, register the layers `/plans do` cut with `init` or `add`, then submit with `--open` so no layer lands as a draft. Afterwards set each layer's title by the rule above and clear any body it wrote. `submit --auto` always writes one: the repo PR template, or the commit body plus a GitHub Stacks CLI footer. Its stack state lives per worktree, and `add` needs the parent checked out, which another worktree may hold, so `publish.sh` uses `add` only when the parent is already registered in this checkout, and otherwise `init --base <trunk>` over the whole recorded base chain. `submit` pushes every layer of the registered stack with a lease taken from a fetch it just made, which protects nothing, so `publish.sh` refuses first when any of those layers has a remote tip missing from its local branch. A branch cut from the trunk is a single PR, not a stack, so it always takes `gh pr create`.
- When `gh stack` is missing, open each layer with `gh pr create --base <parent branch> --title "<title>" --body ""`, bottom first. Never `--fill`, which writes a body.
- When `gh stack` is installed but fails, stop and report. Do not fall back halfway through a stack.

## The fix round

Read the inline comments, the block of comments outside the diff, and the review bot's summary, all with `gh`, through `scripts/review-read.sh <number>`. It prints each source, `empty` for one that came back empty, and every block of comments outside the diff it found. Read the checks once too, never waiting on a pending one: a failure in the branch's own diff is a finding, one outside it a stale base to report. Fix what is real on the branch that owns the code, as one commit named for the issues fixed. In prs mode `scripts/fix-round.sh`, called by its absolute path, commits it, pushes it, then lease rebases every owned layer above it and pushes those; a rebase conflict stops it with the layers above untouched. In hands-off mode suggest that commit message instead. Draft a reply for each finding that is wrong and hand it to the operator. With the greptile extension active, its skill decides whether to pay for a re-review against the threshold set in Greptile's dashboard, and posts it without asking the operator; nothing else posts to request one. `/plans do` runs this round on each open layer below a new one, bottom first, before it cuts the branch.

## Drafted replies

A draft is read on the remote by people and agents who see only the PR: its diff, commits, threads and linked issues. Name nothing that exists only on this machine. No plan id or slug ("plan 29"), no `ctx-` file, backlog row, local path, session, subagent or skill. Say what the code does and why, and cite a commit sha, a file in the diff or a linked issue. Keep it short and human, an engineer's quick reply.

## Never, in either mode

- Merge, by any command.
- Push the default branch.
- Force push without `--force-with-lease`, or lease push a branch the owner does not own.
- Resolve a review thread.
- Comment, review or reply on a PR or issue. The one exception is a comment whose whole body is `@greptileai`, posted in prs mode by the greptile extension under its paid review rules.
- Commit, push or post from a delegate.
- Set `SKILLS_CONF`, or write `~/.agents/skills.conf`. The operator and `install.sh` own the config.

## Deny set per mode

Recommend these Claude Code `permissions.deny` entries for the mode the script prints. `install.sh` reads this table and prints the set for the configured mode, so every mode cell is exactly `deny` or `allow`. A deny cannot be overridden at any settings level and an allow cannot carve an exception out of one, so nothing that mode needs goes here.

| entry | hands-off | prs |
| --- | --- | --- |
| `Bash(gh pr merge:*)`, `Bash(gh stack merge:*)` | deny | deny |
| `Bash(git push --force *)`, `Bash(git push * --force)`, `Bash(git push * --force *)`, `Bash(git push -f *)`, `Bash(git push * -f)`, `Bash(git push * -f *)`, `Bash(git push -fu *)`, `Bash(git push * -fu)`, `Bash(git push * -fu *)`, `Bash(git push -uf *)`, `Bash(git push * -uf)`, `Bash(git push * -uf *)`, `Bash(git push --mirror *)`, `Bash(git push * --mirror)`, `Bash(git push * --mirror *)` | deny | deny |
| `Bash(git push * +*)` | deny | deny |
| `Bash(gh pr review:*)`, `Bash(gh issue comment:*)` | deny | deny |
| `Bash(gh pr comment:*)` | deny | deny |
| `Edit(~/.agents/skills.conf)`, `Write(~/.agents/skills.conf)` | deny | deny |
| `Bash(git commit:*)`, `Bash(git push:*)`, `Bash(gh pr create:*)`, `Bash(gh pr edit:*)`, `Bash(gh pr ready:*)`, `Bash(gh pr close:*)`, `Bash(gh stack submit:*)`, `Bash(gh stack sync:*)`, `Bash(gh stack push:*)` | deny | allow |

Once the comment guard hook is installed, the prs cell of the `Bash(gh pr comment:*)` row becomes `allow`, so the bare `@greptileai` can pass and the guard holds every other comment. The guard does not cover `gh api` writes, so those stay a rule the owner follows rather than a deny.

The deny set narrows mistakes, it is not a boundary. A pattern matches the command text, so `git -C . push --force` or a leading variable assignment slips past it. The Never list binds whether or not a deny caught the command.
