# Contributing

## Checks

Contributing needs git, gh and Bun 1.4.0 or newer. The legacy reviewer suite, `test-reviewers.sh`, also needs jq until it is ported. From the repository root, install the development dependencies with `bun install --frozen-lockfile`, then run every check:

```bash
skills/playbook/bin/skills test --all
```

Every pull request runs the same command on a macOS runner in GitHub Actions, as the `skills test --all` check. The workflow has read only permissions and no secrets, so it also runs on pull requests from forks.

Without `--all`, `skills test` selects checks from the diff against the merge base of HEAD and the branch's `skills-base` setting, or `origin/main` when unset or unresolved. It includes untracked files that git does not ignore. Markdown changes select `check` and suites with explicit markdown watch patterns, including `bun` for README, installer inputs and the delivery reference, and `docs` for its pages and inputs. If no base resolves or no merge base exists, it selects every check and explains why on stderr. An empty diff runs nothing.

`skills test --list` prints the selected suite names without running them. Suites run in parallel, each with its own temporary directory. `--jobs <n>` sets the parallelism. The default is half the available cores, rounded down, with at least one worker.

The manifest lives in `src/areas/`, split by area. A new test file needs an owner in its area file. Before running, the command rejects unlisted or multiply owned test files and missing manifest files. The manifest includes the legacy suites, root Bun tests and TypeScript checks.

`skills check [<root>]` checks skill and agent frontmatter, optional skill keys, reviewer modules, paths, agent names, dashes, Codex flags, sandbox and effort pins, and rules that restate the delivery reference instead of pointing at it. It checks prose CLI verbs and flags against the running CLI's registry, and placeholder or installed skill script paths against the tree. Frontmatter always uses Bun's YAML 1.2 parser, so `name: yes` is a string rather than a boolean. The scans cover the markdown under `skills/`, `agents/` and `docs/content`, plus `README.md` and this file. The prose command check also covers `evals/**/*.md`. The root defaults to the checkout. The authoring playbook runs the checked tree's own CLI before handing a skill back.

## Evals

```bash
skills/playbook/bin/skills eval <case> [--grade]
```

Runs one skill against a fixture repo. Each case covers one known failure mode, and settles by running whether a sentence in a skill changes behaviour. `evals/README.md` has the cases and how grading works.

The harness regression tests run in `skills test`.

## Session Audit

```bash
skills/playbook/bin/skills audit --days 14
```

This is the measurement the throughput work is judged against, not a check. It reads the plans trail, this project's Claude session store and the Codex rollouts, all read only. It prints task durations by plan effort, how time splits across phases over all `/plans do` windows, and subagents and Codex runs grouped by model and reasoning effort.

`--json` prints the same numbers as one object, so two runs can be diffed. `--project-dir` reads a different project's store.

## Docs Site

`docs/` is a standalone Fumadocs app on Next.js, with its own `bun.lock`. Pages live under `docs/content/docs`. Vercel deploys it to [skills.ryuu.gg](https://skills.ryuu.gg), with a preview for each pull request.

Start the dev server on port 3000:

```bash
cd docs
bun install
bun run dev
```

Build it:

```bash
cd docs
bun install --frozen-lockfile
bun run build
```

The build runs `docs/scripts/validate.ts` first, which fails on a broken internal link, a page missing from the sidebar, or a hook script without its page. No CI job builds the site; the Vercel preview is the build check.
