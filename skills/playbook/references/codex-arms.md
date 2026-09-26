# Codex arms

Read this before firing a Codex arm. The playbook skill's Codex arms section points here from every skill and playbook that names an arm.

`<model>` and `<effort>` come from this table together, never one without the other.

| tier  | `-m`            | effort   | use                                                                                   |
| ----- | --------------- | -------- | ------------------------------------------------------------------------------------- |
| luna  | `gpt-5.6-luna`  | `low`    | mechanical work, renames, boilerplate, lookups                                        |
| terra | `gpt-5.6-terra` | `medium` | everyday implementation from a clear spec, the default                                |
| sol   | `gpt-5.6-sol`   | `high`   | complex reasoning or long-context investigation below the top tier, never edits       |
| astra | `gpt-6-astra`   | `high`   | a change specified to the letter, the hardest unsupervised reasoning, plan validation |

```
mkdir -p /tmp/codex
codex exec --enable fast_mode -m <model> -c model_reasoning_effort=<effort> -s read-only -C <abs working directory> \
  -o /tmp/codex/<slug>.md - > /dev/null 2> /tmp/codex/<slug>.log <<'PROMPT'
<self contained prompt>
PROMPT
```

The review arm takes no `-m`, `-o` or `-s`. Put global `-C` before `review`. Keep stdout (finished review) separate from stderr (session stream).

```
mkdir -p /tmp/codex
codex -C <abs working directory> review --enable fast_mode -c model="gpt-6-astra" -c model_reasoning_effort="high" --uncommitted \
  > /tmp/codex/<slug>.md 2> /tmp/codex/<slug>.log
```

`--uncommitted` alone sees staged, unstaged and untracked work together. Never substitute a base branch diff or stage to ease review. It rejects instructions, so open the synthesis saying the focus was not applied. The review file is the verbatim record. Carry every finding to the verdict, rejected findings under Dismissed.

Rules for every arm:

- Always `--enable fast_mode`. Never `--json`.
- Pin effort per tier, `high` for review. A brief may name a higher value for one run. Never default to `xhigh`.
- Use a single-use kebab-case `<task>-<role>` slug with a plan id or short task name. Give parallel arms separate slugs. Codex never truncates stale exec output. Before rerunning, delete both output files or take a fresh slug.
- On nonzero exit or missing/empty output, read the `.log`. Report the exit code and last log lines. Fix the invocation and retry a read-only arm once with a fresh slug. Never rerun a `workspace-write` arm that died mid-edit. Review the tree, then brief a fresh arm against it. Never quietly do the arm's work yourself.
- Run `command -v codex` once per task. If absent, run only Claude panel arms and say the verdict came from one family. Replace a lone review arm with `opus-review` on the diff, an implementation delegate with a `playbook-agent` spawn. `opus-review` brings a clean context window and an adversarial brief, so independence from the diff's author, never a second family. Report the substitution.

Rules for exec arms:

- Always pass `-o`. Stdout carries only the final message, stderr the whole session. Keep the redirects separate.
- Use `-s read-only` unless edits require `-s workspace-write`. Sol never edits.
- Give sol or astra the filled reviewer template and `-s read-only` for a review with instructions.
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
