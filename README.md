<h1 align="center">Ryuu's Skills</h1>

<p align="center">
  Plan-driven skills for coding agents.
</p>

<p align="center">
  <a href="https://skills.ryuu.gg">Documentation</a>
  ·
  <a href="https://github.com/ryuudotgg/skills/issues">Issues</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge&labelColor=000000" alt="MIT License"></a>
</p>

## ✨ What Are These Skills?

Agent skills built around plans on disk, nothing committed or pushed for you unless you turn it on, no slop. The skills are plain markdown backed by a Bun and TypeScript CLI, so they work in any agent that reads a skills directory. Claude Code and Codex are the two they are tested against. See [Agents](https://skills.ryuu.gg/agents) for what runs where.

The foundation comes from [pstack](https://github.com/cursor/plugins/tree/main/pstack) by [Lauren Tan](https://x.com/poteto): the principle skills, the panel skills, the idea of routing work through playbooks, and the PR watcher. Portions also come from [Matt Pocock's skills](https://github.com/mattpocock/skills), and the Greptile extension builds on Greptile's [greploop](https://github.com/greptileai/skills/blob/main/greploop/SKILL.md).

## 🚀 Getting Started

Prerequisites: git, gh and Bun 1.4.0 or newer. Installing needs no Python.

```bash
git clone https://github.com/ryuudotgg/skills && cd skills && ./install.sh
```

At a terminal with no flags and `CI` unset, the installer asks for the delivery mode and optional reviewers. With any flag or a non-terminal stdin or stdout, it never prompts. Only interactive installs fetch dependencies when they are missing.

By default nothing is staged, committed, pushed or posted for you. The installer saves each choice or flag below to `~/.agents/skills.conf` and keeps it on reruns. [Delivery Modes](https://skills.ryuu.gg/delivery) covers what each one lets the agent do.

```bash
./install.sh --with prs                                                                  # commit, push and open PRs
./install.sh --with greptile                                                             # Greptile reviews, which switches on prs mode
./install.sh --with coderabbit                                                           # CodeRabbit reviews, which switches on prs mode
./install.sh --with macroscope                                                           # Macroscope reviews, which switches on prs mode
./install.sh --without greptile --without coderabbit --without macroscope --without prs  # back to hands-off
```

The installer prints the Claude hooks block for you to paste and updates Codex hooks when both tool directories exist. The [Claude Code](https://skills.ryuu.gg/agents/claude-code) and [Codex](https://skills.ryuu.gg/agents/codex) pages cover wiring and trust.

### Commands

| Command              | What it does                                                        |
| -------------------- | ------------------------------------------------------------------- |
| `/plans new [hint]`  | Survey the project, ask where the work lands, write the batch.      |
| `/plans`             | Show the frontier, the open plans nothing blocks.                   |
| `/plans do <id>`     | Branch, probe, route to a playbook, verify, hand back.              |
| `/plans review <id>` | Read the review, fix each finding, reply in bot threads.            |
| `/plans close <id>`  | File the plan with what landed.                                     |

## 📚 Documentation

Read the full docs at [skills.ryuu.gg](https://skills.ryuu.gg).

- [Getting Started](https://skills.ryuu.gg/getting-started)
- [The Loop](https://skills.ryuu.gg/workflow)
- [Plans](https://skills.ryuu.gg/workflow/plans)
- [Running a Batch](https://skills.ryuu.gg/workflow/running-a-batch)
- [Playbook](https://skills.ryuu.gg/workflow/playbook)
- [Delivery Modes](https://skills.ryuu.gg/delivery)
- [Reviewers](https://skills.ryuu.gg/delivery/reviewers)
- [Deny Rules](https://skills.ryuu.gg/delivery/deny-rules)
- [Hooks](https://skills.ryuu.gg/hooks)
- [Skills Catalog](https://skills.ryuu.gg/skills)
- [Configuration](https://skills.ryuu.gg/reference/configuration)

## 🤝 Contributing

To run the checks or work on the docs site, see [CONTRIBUTING.md](CONTRIBUTING.md). Report bugs on [GitHub Issues](https://github.com/ryuudotgg/skills/issues).

## 👥 Authors

- Ryuu ([@ryuudotgg](https://github.com/ryuudotgg))

## 📄 License

MIT, including the [pstack](https://github.com/cursor/plugins), [Matt Pocock](https://github.com/mattpocock/skills) and [Emil Kowalski](https://github.com/emilkowalski/skills) portions. The UI design reference also condenses guidance from [Impeccable](https://github.com/pbakaus/impeccable), Apache 2.0. See [LICENSE](LICENSE).
