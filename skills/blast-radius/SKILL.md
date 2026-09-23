---
name: blast-radius
description: "Find what a change could break outside the diff before it ships, and prove the one fact it is safe because of by running real code. Use for 'blast radius of X', 'what could this break', or reviewing a small diff you don't trust."
disable-model-invocation: true
---

# Blast radius

Find what a change breaks somewhere else, before it ships. Use for "blast radius of X", "what could this break", or reviewing a small diff you don't trust yet.

Companion to `how`. `how` tells you what the code does, and the git history tells you why it is shaped that way. Blast radius tells you what it breaks somewhere else.

Listing the callers is not the job. The agent can grep those in a second. The job is the breakage grep won't show you.

## Don't trust your own writeup

A blast-radius writeup that sounds right is worthless. It reads as convincing whether or not it's true, and that is the trap you are walking into. So don't hand back the writeup. Find the one or two facts the whole thing depends on and prove them by running code. Words are where you start, not what you ship.

### How sure are you

For each fact the change's safety depends on, get it as far down this list as is cheap, and say where it stopped.

1. You said so. Worthless on its own.
2. You pointed at the line. A real `file:line`, or the library's own source.
3. You showed the bad case can't happen. You walked the failure step by step and it doesn't reach.
4. You ran the real code. Not a mock, not a reimplementation, not a reasoning trace. A script or test that imports the same module the app imports, calls the exact function you are worried about, and fails loud if you're wrong. Paste the command and its real output. If the output is a summary you wrote rather than what the process printed, you are still on rung 1.
5. You ran the real app. The change exercised end to end in the running product, through the UI or the real endpoint, with the observed result pasted. Reuse whatever the project already has running. Never kill, restart, or hijack a process, server, or database you did not start in this session. If one is in the way, say so and ask. Treat a shared development database as read only unless the operator says otherwise.

Any safety fact you can't get to rung 4, say so out loud. Don't write it up as settled. Rung 4 is usually one small script that imports the same library the app ships and calls the function in question.

## Steps

1. Read the change. The diff, the symbols it adds, changes, and deletes, and what it now does differently, including the part the diff doesn't spell out. Read the PR and the commits with `gh pr view` and `git log -p`. Reading remote state is fine; posting to it is not.
2. Find the one fact it's safe because of. Most changes that look scary are safe because of a single fact, like "this call only drops already-dead cache entries and does nothing else". Find that fact. If it holds, most of the scary cases die at once. Spend your time here, not on a long list of maybes.
3. Look where grep stops. Read the source of the library you call, and check its pinned version and any local patch. Work out when things run: microtasks, unmount and teardown, Solid versus React. Follow what a symbol search misses: the JSON an API returns, a DB column, a wire format, another language reading the same bytes, a feature flag, code three hops downstream.
4. Be honest about each risk. Give it a real chance of happening and a real cost if it does. Keep the risks you confirmed; list the ones you checked and cleared separately. Cite a real `file:line`, a search that finds nothing is still an answer, and never make up a caller or an API.
5. Prove the one fact. Write a script or test that runs the real code, run it, and paste what happened. If you can't prove it cheaply, mark it unproven. Don't round up.
6. For a big or wide change, ask the same question of several models and merge the answers. Two Claude arms (`fable-judgment`, `opus-review`) as subagents and two Codex arms (astra, terra) as background Bash calls per the playbook skill's **Codex arms** section, all read only. Different models catch different real bugs. With no `codex` on PATH run the Claude arms and say so; skip any Claude agent that is not installed and run the rest. Pass no `model` parameter and no `isolation` parameter in any form; every value of it produces a worktree, and worktrees are banned. Scratch work goes in a directory under `/tmp/`.

## What to hand back

- **What it does.** What changed, including the part that isn't obvious.
- **The one fact it's safe because of.** State it, say which step you got it to, and show the proof. If you couldn't prove it, write unproven.
- **Risks.** Only the real ones. Each names how it breaks, the `file:line`, how likely and how bad, and how to check. Paste the proof for the ones that matter.
- **Cleared.** What you checked and why it's fine.
- **Before it lands.** The cheapest test or repro that catches the real bug, including the script you wrote.

Leave the writeup and any probe script unstaged on the `feat/*` branch in the main tree. Do not commit, do not push, do not post it to a PR or an issue. Hand it back in the reply and let the operator post whatever they want posted.

Write it through `unslop`, cite real code, and strip anything private before it goes anywhere public.

**Reply:** the writeup above, with the one safety fact either proven or marked unproven.
