# Codex arms

Read this before firing a Codex arm. The playbook skill's Codex arms section points here from every skill and playbook that names an arm.

`<model>` and `<effort>` come from this table together, never one without the other.

| tier  | `-m`          | effort   | use                                                                                |
| ----- | ------------- | -------- | ---------------------------------------------------------------------------------- |
| luna  | `gpt-6-luna`  | `low`    | mechanical work, renames, boilerplate, lookups                                     |
| terra | `gpt-6.1-sol` | `medium` | everyday implementation from a clear spec, the default                             |
| sol   | `gpt-6.1-sol` | `high`   | hard implementation, complex reasoning, long-context investigation, the review arm |
| astra | `gpt-6-astra` | `high`   | critical work only, in a seat that names it                                        |

Terra runs `gpt-6.1-sol` until a terra model ships. The tier, not the model, sets the effort.

## Fast mode

Run `../bin/skills fast-mode`, relative to this file, by its absolute path once per task, beside the transport pick. Its `codex=` line sets every Codex arm's service tier: `priority` for `yes`, `default` for `no`. Pass the tier either way, since some models default to `priority` and an unset tier is not off. Its `claude=` line belongs to the playbook skill's **Fast mode** section.

Critical work is a plan whose frontmatter says `critical: true`, or work the operator calls critical. Astra runs only on critical work and only in a seat that names it. Everywhere else sol is the top Codex tier, however hard the task, because astra costs at least twice what sol does per token.

## Transport

Pick it once per task, in this order. A Codex transport is either of the first two.

1. Harness delegation. Some harnesses run a Codex model as a child task of this thread through their own tool, and that comes first. It qualifies when it can run the tier's model at the tier's effort, starts the child in this checkout on its branch, runs it without sending approvals to the operator, and reports when the child finishes. Fire each exec arm through it, per **Through a harness**. An arm whose model it cannot run takes the CLI.
2. The Codex CLI. Otherwise run `command -v codex` and fire arms per **Through the Codex CLI**.
3. Neither. Run the Claude arms only, per the last rule under **Rules for every arm**.

The review arm takes the same transport as every other arm, per **The review arm**.

## The review arm

It runs sol at `high`, astra on critical work, read only, with the slug `<task>-review`. It reviews the whole uncommitted change: staged, unstaged and untracked work together. Never substitute a base branch diff or stage to ease review.

Through a harness it is a read only exec arm. Its prompt is `skills/interrogate/references/reviewer-prompt.md`, filled with the intent, `skills/interrogate/references/rubric.md`, `skills/interrogate/references/code-quality-review.md`, and this block in place of the code under review, with the repo root filled in. A seat that asks for a cold read, like interrogate's Reviewer C, cuts the Intent section.

```
Collect the change yourself from <abs repo root>: run git status --porcelain and git diff HEAD, and read every untracked file in full. Review all of it as one change. Read other code only where a finding needs its context.
```

Through the Codex CLI it is the `review` subcommand, which takes no instructions, per **Through the Codex CLI**.

## Through a harness

These hold for any harness. Each subsection below maps them onto one harness's fields.

- One delegation call per arm. The slug is its title and, when the tool takes one, its idempotency key. A call that errors without returning a task is retried once with the same key. A fresh slug is a deliberate new attempt, once the old task has ended or been cancelled.
- Pick the mode that runs unattended, even when the harness's read only sandbox is a different one. An arm waiting on an operator approval has stalled.
- The owner keeps working on what does not need the result, then ends the turn, and polls nothing. When a completion notice would wake the owner's thread, a Claude Task subagent firing an arm blocks on the result in the call instead.
- The child starts in this thread's checkout, on its branch. A seat's `-C` becomes an absolute path stated in the prompt. `-o`, the `.log` and `/tmp/codex` drop out. The arm's output is the child's final message as the harness reports it, and the child's transcript is the record. A running task with no result yet is not missing output.
- The child runs the operator's hooks, since `AGENT_HOOKS=0` cannot reach it. The reply guard can make it rewrite its last message, so when the output reads like a fragment of a longer reply, read the child's transcript.
- A seat's `-s read-only` means the prompt ends with the read only block below, verbatim. Only the prompt enforces it when the child's sandbox can write. `-s workspace-write` means the implementation block at the end of this file, unchanged.

```
Read only. Create, edit, move and delete no file. Run no install, build, test, formatter, or git command that writes.
A hook may list comment lines in this tree or ask for a fix. Those lines are the owner's work in progress, so leave every file untouched and restate your reply.
Run no gh or stacking tool command. Never kill or restart a process this run did not start.
```

### T3 Code

Call `orchestrator_capabilities` when the harness exposes T3 Code's tools, after the discovery T3's own instructions give for lazily loaded tools and ACP agents. T3 qualifies when it reports `runtimeMode` `auto` or `full-access`, `interactionMode` `default`, and a provider with `driverKind: "codex"` and `canRunChildTask: true`. A narrower parent cannot grant a child `auto`, and a Plan mode child plans instead of acting.

The tool is `delegate_task`:

- `target`: `{"providerInstanceId": "<that provider's id>", "model": "<model>", "options": {"reasoningEffort": "<effort>", "serviceTier": "<tier>"}}`, the tier from **Fast mode**.
- `runtimeMode: "auto"` for every arm, read only or not. The child gets a workspace-write sandbox, and Codex's own reviewer answers its approval requests. Never `approval-required`. It is T3's only read-only sandbox, but it sends every compound or unlisted shell command to the operator, so the arm stalls on its first `git status`.
- `title` and `clientRequestId`: the slug.
- `mode`: the owner omits it, which leaves it async. T3 steers the completion notice into a running turn or opens the next turn with it. The notice carries no result, so read it with `task_status`. A Claude Task subagent passes `mode: "wait"` and `timeoutMs: 3600000`. On `waitTimedOut`, it reads `task_status` once, takes a terminal result as the arm's output, and otherwise reports the arm as still running with its `taskId`.

The output is the `summary` that `task_status` returns once the task is terminal, and a failed task carries the provider error there. Read the child's transcript with `t3_thread_read` on its `childThreadId`.

## Through the Codex CLI

```
mkdir -p /tmp/codex
AGENT_HOOKS=0 codex exec -m <model> -c model_reasoning_effort=<effort> -c service_tier=<tier> -s read-only -C <abs working directory> \
  -o /tmp/codex/<slug>.md - > /dev/null 2> /tmp/codex/<slug>.log <<'PROMPT'
<self contained prompt>
PROMPT
```

The review arm takes no `-m`, `-o` or `-s`. Put global `-C` and the sandbox override before `review`. Keep stdout (finished review) separate from stderr (session stream). Pin the sandbox read only: an unpinned review arm runs the repo's install and test commands in the working tree, and a failed install there leaves `node_modules` half pruned for the owner.

```
mkdir -p /tmp/codex
codex -C <abs working directory> -c sandbox_mode='"read-only"' review -c model="gpt-6.1-sol" -c model_reasoning_effort="high" -c service_tier="<tier>" --uncommitted \
  > /tmp/codex/<slug>.md 2> /tmp/codex/<slug>.log
```

On critical work the review arm runs `gpt-6-astra` in place of `gpt-6.1-sol`, at the same effort.

`--uncommitted` alone sees staged, unstaged and untracked work together. It rejects instructions, so open the synthesis saying the focus was not applied. The review file is the verbatim record. Carry every finding to the verdict, rejected findings under Dismissed.

- Never `--json`.
- Always pass `-o` to an exec arm. Stdout carries only the final message, stderr the whole session. Keep the redirects separate.
- Use `-s read-only` unless edits require `-s workspace-write`. A read only arm keeps `AGENT_HOOKS=0`, otherwise the reply guard rewrites its final message and `-o` keeps only the rewrite. A `workspace-write` arm drops the prefix so the edit hooks still see its changes.
- Codex never truncates stale exec output. Before rerunning, delete both output files or take a fresh slug.

## Rules for every arm

- Pin effort per tier, `high` for review. A brief may name a higher value for one run. Never default to `xhigh`.
- Use a single-use kebab-case `<task>-<role>` slug with a plan id or short task name. Give parallel arms separate slugs.
- On a failed task, a nonzero exit, or missing or empty output, read the failure from the harness task's result or the `.log` under the CLI. Report the error and the last lines of it. Fix the call and retry a read-only arm once with a fresh slug. Never rerun a `workspace-write` arm that died mid-edit. Review the tree, then brief a fresh arm against it. Never quietly do the arm's work yourself.
- When an arm finishes but its output misses the brief's criteria, fire one fresh arm a tier up with a new slug, briefed against the tree as it stands. Luna steps up to terra and terra to sol. A miss at the top tier the work allows goes into the handback as an open item.
- With no Codex transport, run only Claude panel arms and say the verdict came from one family. Replace a lone review arm with `opus-review` on the diff, an implementation delegate with a `playbook-agent` spawn. With no spawn either, review the diff yourself in one read only pass and report that it had no second reader. `opus-review` brings a clean context window and an adversarial brief, so independence from the diff's author, never a second family. Report the substitution.
- Give sol or astra the filled reviewer template and a read only seat for a review with instructions.
- Make the prompt stand alone. Codex sees none of this conversation. Restate every constraint, file path and acceptance criterion. Use absolute paths. For mechanical work, specify the exact transformation and file set.
- End every implementation prompt with the verbatim block below. Otherwise Codex would follow the operator's branching rule, and the sandbox keeps `.git` read-only.

```
The branch is already the right one: work on it as checked out and create none.
Leave every change unstaged. Run no git add, git commit, git push, gh, gt or any other stacking tool command. Create no worktree.
Use the package manager the lockfile names and add no competing lockfile.
Never kill, restart or hijack a process, server or database this run did not start.
Change only what this brief names. Where the brief is ambiguous against the file on disk, stop and report instead of guessing.
Intent lives in names, types and assertions, never in comments. The one comment that survives names an external constraint, a landmine, or why the obvious approach lost.
No em dash, en dash or hyphen used as a dash, in code, strings or copy.
Where it is unclear where something lands (which surface, which tab, public or private, who can see it), stop and say so.
Never write to production data.
```

Own every arm's and subagent's work. Read the output, review the diff and write your own summary. Interrupt-chained resumes drop directives. Fire a fresh arm with consolidated scope. Agreement across families is the high signal. The playbook skill's **Subagents and Codex arms** section owns what a second opinion is.
