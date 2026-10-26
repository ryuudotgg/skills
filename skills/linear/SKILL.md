---
name: linear
description: Branch a task after the Linear issue it came from, then link its PR to that issue and move the issue to code review through the Linear MCP. Use when the request names a Linear issue by URL or identifier.
optional: true
requires: prs
---

# Linear

Runs in an owner thread while `../playbook/bin/skills delivery` lists `linear`, `/plans` or not, for each Linear issue the operator's request names: a `linear.app/<workspace>/issue/<ID>` URL or an identifier such as `ENG-123`. Only those. An issue found by searching, or linked from a named one, is not the task's.

It works through the Linear MCP's `get_issue`, `list_issue_statuses` and `save_issue`. Without `get_issue`, skip both steps. Without `save_issue`, as on a read only connection, skip the writes. Either way, name each issue beside its PR URL in the handback.

## The branch

Before the first edit, read the issue with `get_issue` and cut the task branch with its `gitBranchName`, verbatim, in place of a `<type>/<short-desc>` name. With several issues, take the first one's. On a repo where Linear's GitHub integration is installed, that name is what links the PR and runs the team's own automations. A `/plans do` thread keeps the branch `plans start` cut.

## Once the PR is open

Right after the PR URL is registered, per `../playbook/references/delivery.md` Owners in prs mode, for each named issue:

1. `get_issue` with the fields `attachments`, `status`, `statusType` and `teamId`.
2. Unless an attachment's `url` is already the PR URL, `save_issue` with the issue's identifier as `id` and `links` holding one `{url, title}`: the PR URL, and the PR title followed by ` (#<number>)`.
3. `list_issue_statuses` for that team. The target is the one `started` status whose name means code review, such as `In Review` or `Ready for Code Review&QA`. Set it with `save_issue` `state` and the status's `id` only when the issue's `statusType` is `triage`, `backlog` or `unstarted`, or its status is a `started` one that reads as work underway, such as `In Progress`. Statuses carry no order, so read from the names whether the issue already sits at review or past it, a QA status say, and leave it there. Leave it too when no status, or more than one, reads as code review, and when its type is `completed`, `canceled` or `duplicate`.
4. `get_issue` once more to confirm what changed.

Touch nothing else on the issue: not its assignee, labels, priority, estimate, project, cycle or description, and write no comment on it. In a stack, each layer's PR goes to the issue its own task named.

The handback gets one line per issue: its identifier, the PR it now links, and the status it moved to, or the status it kept and why.
