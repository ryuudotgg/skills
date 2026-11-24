# Contributing

## Checks

Contributing needs git, gh and Bun 1.4.0 or newer. From the repository root, install the development dependencies of every workspace with `bun install --frozen-lockfile`, then run every check:

```bash
skills/playbook/bin/skills test --all
```

`skills test --all` also runs three style checks over `packages/cli/src`, `packages/core`, `apps/docs`, `apps/dashboard`, `apps/hub`, the reviewer modules, the OpenCode plugin and the TypeScript files in `scripts/`: `lint` (oxlint, correctness rules), `format` (oxfmt) and `stanza` (Stanza's blank line and braces rules, run after oxfmt). `bun run fix` applies all three in that order. Markdown under `apps/docs` also selects `format`.

Every pull request runs the same command in GitHub Actions on a macOS runner and an Ubuntu runner, as the `Test (macOS)` and `Test (Ubuntu)` checks, next to a `Checks` job that runs `skills check` and the typecheck on their own. The workflow has read only permissions and no secrets, so it also runs on pull requests from forks. A pull request against `main` also needs a passing `Tegami Note` check, covered under [Releases](#releases).

Without `--all`, `skills test` selects checks from the diff against the merge base of HEAD and the branch's `skills-base` setting, or `origin/main` when unset or unresolved. It includes untracked files that git does not ignore. Markdown changes select `check` and suites with explicit markdown watch patterns, including `bun` for README, this guide, installer inputs, the playbooks, the arms references and the rule groups reference, and `docs` for its pages and inputs. If no base resolves or no merge base exists, it selects every check and explains why on stderr. An empty diff runs nothing.

On such a diff run the `bun` suite runs only the test files the diff can reach, when every changed path under its watch patterns is a TypeScript file under `packages/cli/src` or `packages/core/src` and nothing was deleted or renamed. Those are the test files that import a changed file, directly or through other modules, and every test file that may start repository code as its own process: one whose text, outside its import lines, holds a string that ends in `.ts`, `.sh` or `bin/skills`. So a test that starts the CLI, itself or through a helper, has to hold such a string in its own file, most simply the CLI's path. The suite runs every test file when the diff holds a root config file, any other path under its watch patterns, markdown included, a file a module imports from elsewhere, a source file no test imports, a change that reaches a module the tests load without importing it (the fake `gh` in `packages/cli/src/evals/gh.ts`, the test preload and the reviewer modules), or an import that does not resolve. A changed path outside all of those, such as a release note, does not widen the run. `skills test --all` is the full run, and both CI checks run it.

`skills test --list` prints the selected suite names without running them. Suites run in parallel, each with its own temporary directory. `--jobs <n>` sets the parallelism. The default is half the available cores, rounded down, with at least one worker.

At a terminal, `skills test` keeps one row per selected suite on screen and updates it in place: queued, running with its elapsed seconds and the `seconds` estimate from its manifest entry until it runs past it, then `ok` or `FAIL` with its time. When the run ends, each failed suite's captured output follows under its own header, then one summary line. `NO_COLOR` turns the color off. Ctrl-C stops every suite and exits with 130. When stdout is not a terminal, or `TERM` is `dumb`, the output is the plain form that agents and CI parse: `ok <name> <seconds>s` or `FAIL <name> <seconds>s` as each suite finishes, a failed suite's output on stderr right after its line, then `ok <n> suites` or `FAIL <k> of <n> suites`.

When a suite that runs `bun test` with `--parallel` or `--isolate` fails, `skills test` reads the failing tests from bun's junit report, waits until every other suite has ended, then runs each test file that held one once more, alone and on one worker, within what is left of the suite's time limit, 600 seconds unless its manifest entry sets one. A test that failed and passes that rerun is printed as `flaky <file>: <test name>`, one line each, after its suite's line. When every failing test passed its rerun and no rerun failed, the suite counts as `ok` and the last line reads `ok <n> suites, <m> flaky`. Otherwise the suite fails, and each rerun's output follows the first run's under a `<name>: rerun <file>` line. At a terminal the suite's row reads `rerun` while it waits, and the `flaky` lines come before the summary. A `flaky` line names a test whose verdict depended on how busy the machine was, so fix that test. Nothing is rerun when the suite reached its limit, when bun's report names no failing test, when more than five test files held a failing test, since that many is a break and not a busy machine, or when bun counted a failure the report does not name, such as a test file that failed to load. A suite whose `bun test` arguments go beyond `--parallel`, `--isolate`, `--timeout=<ms>`, `--max-concurrency=<n>` and test file paths is not rerun either. A suite that shares one global object across its files, as `core`, `hub` and `dashboard` do, is not rerun either, since there a leftover from one file can fail a test in another that then passes alone.

The manifest lives in `packages/cli/src/areas/`, split by area. A new test file needs an owner in its area file. Before running, the command rejects unlisted or multiply owned test files and missing manifest files. The manifest includes the legacy suites, root Bun tests and TypeScript checks. The `core` suite runs `packages/core`'s own tests from that directory, and the typecheck checks `packages/core` a second time without Bun's types, so a `Bun` or `process` reference there fails it.

`skills check [<root>]` checks skill and agent frontmatter, optional skill keys, reviewer modules, paths, agent names, dashes, Codex flags, sandbox and effort pins, and rules that restate the delivery reference instead of pointing at it. It checks prose CLI verbs and flags against the running CLI's registry, and placeholder or installed skill script paths against the tree. Frontmatter always uses Bun's YAML 1.2 parser, so `name: yes` is a string rather than a boolean. The Codex flag check reads the installed `codex --help` and is skipped wherever `codex` is not on PATH, the CI Checks job included. The scans cover the markdown under `skills/`, `agents/`, `apps/docs/content` and `.tegami/`, plus `README.md`, `AGENTS.md` and this file. The prose command check also covers `evals/**/*.md`. The root defaults to the checkout. The authoring playbook runs the checked tree's own CLI before handing a skill back.

## Manual verifiers

The verifiers in `scripts/` run by hand, never in CI. The typecheck and the style checks cover the TypeScript ones, but no suite runs them.

`scripts/verify-claude-rules.ts` installs the rule groups with `AGENT_RULES=deny` into a temporary home and asks a real `claude -p` to attempt a fixed list of calls against harmless stubs. In the default `bypassPermissions` mode the list runs the installer in its usual spellings and edits Claude's settings, beside calls that must stay allowed, then reruns with the `installer` group off and again with the `claude-settings` group off, so those refusals are attributed to their group by elimination. In `default` and `acceptEdits` mode the list calls the `skills` CLI, and the rerun turns the `skills-cli` group off. Every run also checks that Claude's settings file stays unchanged, except that the run with `claude-settings` off must make exactly the requested edit. Each assertion prints `ok` or `MISMATCH`, and any mismatch exits 1. `KEEP=1` keeps the temporary home. It calls a paid model.

```bash
bun scripts/verify-claude-rules.ts [--permission-mode bypassPermissions|default|acceptEdits]
```

`scripts/verify-update-move.sh` checks that `skills update` moves a checkout from an older commit to a newer one. It pushes the new ref to a local bare origin as a bumped release with its tag, clones it at the old ref, runs `skills update` with a stubbed `gh`, then prints the update line, the size of `node_modules`, whether `apps/docs/node_modules` and a legacy top level `docs/node_modules` are present, and the plans frontier. The old ref must be an ancestor of the new one. It works under `/tmp/plans-<PLAN_ID>/`, or `/tmp/plans-verify/` without `PLAN_ID`.

```bash
scripts/verify-update-move.sh <old ref> <new ref>
```

`scripts/audit-memory.ts` checks that `skills audit` reads a long history in bounded memory. It runs `skills audit --prs` in process, with git and gh stubbed, over 120 synthetic transcripts in a temporary home, and prints `ok` when the audit finds exactly 120 windows below 300 MiB. When a window is missing, the audit fails or the run reaches 300 MiB, it prints the window count and peak memory instead and exits 1.

```bash
bun scripts/audit-memory.ts
```

The [OpenCode page](https://skills.ryuu.gg/agents/opencode) of the docs site covers `scripts/verify-opencode.ts`.

## Releases

Every pull request adds a release note in `.tegami/`, and the `Tegami Note` check, which `main` requires, fails without one. It also runs `bun run tegami version --dry-run`, which refuses a note in the wrong shape. The Releases section of [AGENTS.md](AGENTS.md) covers how to write a note and how a release goes out.

## Evals

```bash
skills/playbook/bin/skills eval <case> [--grade] [--without <skills>]
```

Runs one skill against a fixture repo. Each case covers one known failure mode, and settles by running whether a sentence in a skill changes behaviour. `evals/README.md` has the cases and how grading works.

The harness regression tests run in `skills test`.

## Session Audit

```bash
skills/playbook/bin/skills audit --days 14
```

This is the measurement the throughput work is judged against, not a check. It reads the plans trail, every Claude session of this repository and the Codex rollouts, all read only. A Claude session counts when the directory it recorded is the main checkout, a live worktree, or a T3 Code worktree under `~/.t3/worktrees/<checkout name>/`, so sessions from deleted worktrees still count. It prints task durations by plan effort, how time splits across phases over all `/plans do` windows, and subagents and Codex runs grouped by model and reasoning effort. The plans trail and the Codex rollouts cover every project on the machine.

At a terminal the report is laid out for reading: durations such as `1h 36m`, bars for the duration histogram and phase shares, and a single dim line for a section with no data. Color follows `NO_COLOR` and `TERM=dumb`. Piped output keeps the plain tables, so a saved run still diffs against a new one. `--json` prints the same numbers as one object, so two runs can be diffed. `--project-dir` reads exactly one session folder instead, such as another project's.

## Docs Site

`apps/docs` is the `skills-docs` workspace, a Fumadocs app on Next.js that shares the root `bun.lock`. It reads CLI code only through the subpaths that `skills-cli` exports in `packages/cli/package.json`, so a module the docs need gets an entry there. Pages live under `apps/docs/content/docs`. Vercel deploys it to [skills.ryuu.gg](https://skills.ryuu.gg) from the `apps/docs` root directory, with a preview for each pull request. A user's install never fetches its dependencies.

Building it needs Node 22.18 or newer (23.6 or newer on Node 23), since Node loads the CLI's TypeScript sources directly. After the development install at the repository root, start the dev server on port 3000:

```bash
cd apps/docs
bun run dev
```

Build it:

```bash
cd apps/docs
bun run build
```

The build runs `apps/docs/scripts/validate.ts` first, which fails on a broken internal link, a page missing from the sidebar, or a hook script without its page. No CI job builds the site; the Vercel preview is the build check.
