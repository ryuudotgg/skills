# Contributing

## Checks

The repository has no package manager of its own. Its checks are Python and POSIX shell, run from the root:

```bash
python3 scripts/validate.py
python3 -B hooks/test_hooks.py
sh scripts/test-install.sh
sh skills/playbook/scripts/test-delivery-mode.sh
sh skills/plans/scripts/test-lint.sh
sh skills/plans/scripts/test-frontier.sh
```

`validate.py` checks skill frontmatter, paths, agent names, dashes, Codex flags, and rules that restate the delivery reference instead of pointing at it. The dash scan covers the markdown under `skills/`, `agents/`, `hooks/` and `docs/content`, plus `README.md` and this file. The authoring playbook runs it before handing a skill back.

`test_hooks.py` runs the comment, reply and commit guard hooks against sample payloads.

`test-install.sh` covers the installer's modes, links, config and deny sets, and runs the `./install.sh` commands the README shows.

`test-delivery-mode.sh` runs the delivery mode script against sample configs. `test-lint.sh` and `test-frontier.sh` run the plans lint and frontier against a fixture plans directory.

## Evals

```bash
evals/run.sh <case> [--grade]
```

Runs one skill against a fixture repo. Each case covers one known failure mode, and settles by running whether a sentence in a skill changes behaviour. `evals/README.md` has the cases and how grading works.

## Session Audit

```bash
python3 scripts/audit-sessions.py --days 14
```

This is the measurement the throughput work is judged against, not a check. It reads the plans trail, this project's Claude session store and the Codex rollouts, all read only. It prints task durations by plan effort, the phase split of each `/plans do` window, and subagents and Codex runs grouped by model and reasoning effort.

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
bun install --frozen-lockfile
bun run build
```

The build runs `docs/scripts/validate.ts` first, which fails on a broken internal link, a page missing from the sidebar, or a hook script without its page. No CI job builds the site; the Vercel preview is the build check.
