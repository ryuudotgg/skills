---
packages:
  skills-cli: patch
---

### 🐛 The playbook's process rule allows `skills reap`

The playbook's Autonomy rule now names `skills reap` as the one exception to never stopping a process you did not start, so a handback that reaps its own simulators, containers and servers no longer reads as breaking it.

### 🐛 Babysit reports layers a late `lease-rebase` refusal moved

Babysit now says a `lease-rebase` refusal after its push leaves the layers it printed moved and pushed, and reports them as rewritten, instead of claiming a refusal moves nothing.

### 🎨 Backlog item probe stops on a surface found twice

A `/plans do` probe that finds the plan's surface in two places, or as a public and a private copy, stops with the destination question before any edit.

### 🎨 Perf issue and refactoring use `skills device`

iOS and Android traces and checks in the perf issue and refactoring playbooks run on the device `skills device` prints, as bug fix and feature already do.

### 🎨 Babysit drops a `--json` flag the watcher never had

Babysit describes `skills pr watch` as it is, NDJSON by default and `--pretty` for humans, with no warning about a `--json` flag it never took.

### 🎨 One off lessons go to the harness's own memory

Encode lessons in structure sends a one off lesson to Claude Code's auto memory, AGENTS.md or the host's equivalent, in place of a brain note no harness has.

### 🎨 Type system discipline names no missing skill

Type system discipline no longer points at a `typescript-best-practices` skill that is not installed.

### 🧰 Placeholder check test no longer spends the playbook cap

The `skills check` placeholder test appends its script paths to a playbook file instead of `skills/playbook/SKILL.md`, so it stops failing whenever that file sits within a few hundred bytes of its 14000 byte cap.
