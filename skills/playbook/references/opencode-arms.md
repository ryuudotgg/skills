# OpenCode arms

Read this when `codex-arms.md` **Transport** sends a seat to OpenCode.

OpenCode has no sandbox. Permissions passed with each run make an arm read only or keep a write arm off the remote, and the prompt's block stays the second net. Pick the transport in this order:

1. Harness delegation, under the conditions `codex-arms.md` **Transport** gives, and only when the harness applies the arm's permission set below to the child. T3 Code's `driverKind: "opencode"` provider does not: `delegate_task` takes no permission set, and an `auto` child there writes files and runs any shell command.
2. The OpenCode CLI. Otherwise run `command -v opencode` and fire the arm as below. The block runs only when `opencode --version` reports v2: an older binary ignores the `permissions` array and runs on its defaults, which allow everything.
3. Neither. The seat follows `codex-arms.md` **Roster** rule 1.

```
mkdir -p /tmp/opencode
opencode --version | grep -q "^opencode v2\." && jq -e '.permissions | length > 0 and all(.[]; (.action | type) == "string" and (.resource | type) == "string" and (.effect | IN("allow", "deny", "ask")))' /tmp/opencode/<slug>.json > /dev/null && cd "<abs working directory>" && AGENT_HOOKS=0 GIT_OPTIONAL_LOCKS=0 OPENCODE_CONFIG_CONTENT="$(cat /tmp/opencode/<slug>.json)" \
  perl -e 'alarm shift; exec @ARGV' 1800 opencode run --standalone --auto --format json -m <provider/model#variant> \
  > /tmp/opencode/<slug>.ndjson 2> /tmp/opencode/<slug>.log <<'PROMPT' && \
  jq -rs '[.[] | select(.type == "text")] | (last.part.messageID) as $m | map(select(.part.messageID == $m) | .part.text) | join("\n")' \
  /tmp/opencode/<slug>.ndjson > /tmp/opencode/<slug>.md
<self contained prompt>
PROMPT
```

Fire it as one background Bash call, as for the Codex CLI in `codex-arms.md`, after writing the arm's permission set to `/tmp/opencode/<slug>.json`. The `jq -e` step keeps a missing, malformed or empty set from running the arm on OpenCode's defaults, which allow everything. A read only arm takes this one, verbatim:

```json
{"permissions": [
  {"action": "*", "resource": "*", "effect": "deny"},
  {"action": "read", "resource": "*", "effect": "allow"},
  {"action": "glob", "resource": "*", "effect": "allow"},
  {"action": "grep", "resource": "*", "effect": "allow"},
  {"action": "read", "resource": "*.env", "effect": "deny"},
  {"action": "read", "resource": "*.env.*", "effect": "deny"},
  {"action": "shell", "resource": "git status *", "effect": "allow"},
  {"action": "shell", "resource": "git diff *", "effect": "allow"},
  {"action": "shell", "resource": "git log *", "effect": "allow"},
  {"action": "shell", "resource": "git show *", "effect": "allow"},
  {"action": "shell", "resource": "ls *", "effect": "allow"},
  {"action": "shell", "resource": "rg *", "effect": "allow"},
  {"action": "shell", "resource": "*>*", "effect": "deny"},
  {"action": "shell", "resource": "*--output*", "effect": "deny"},
  {"action": "shell", "resource": "* --pre*", "effect": "deny"},
  {"action": "shell", "resource": "*--ext-diff*", "effect": "deny"},
  {"action": "shell", "resource": "*--textconv*", "effect": "deny"},
  {"action": "shell", "resource": "*.env*", "effect": "deny"}
]}
```

A write arm takes this one, which denies the usual spellings of every publishing command, the web and subagents, and keeps edits inside the checkout:

```json
{"permissions": [
  {"action": "*", "resource": "*", "effect": "allow"},
  {"action": "question", "resource": "*", "effect": "deny"},
  {"action": "webfetch", "resource": "*", "effect": "deny"},
  {"action": "websearch", "resource": "*", "effect": "deny"},
  {"action": "subagent", "resource": "*", "effect": "deny"},
  {"action": "external_directory", "resource": "*", "effect": "deny"},
  {"action": "edit", "resource": "*.git/*", "effect": "deny"},
  {"action": "shell", "resource": "*.git*", "effect": "deny"},
  {"action": "shell", "resource": "*git add*", "effect": "deny"},
  {"action": "shell", "resource": "*git * add*", "effect": "deny"},
  {"action": "shell", "resource": "*git commit*", "effect": "deny"},
  {"action": "shell", "resource": "*git * commit*", "effect": "deny"},
  {"action": "shell", "resource": "*git push*", "effect": "deny"},
  {"action": "shell", "resource": "*git * push*", "effect": "deny"},
  {"action": "shell", "resource": "*git stash*", "effect": "deny"},
  {"action": "shell", "resource": "*git * stash*", "effect": "deny"},
  {"action": "shell", "resource": "*git worktree*", "effect": "deny"},
  {"action": "shell", "resource": "*git config*", "effect": "deny"},
  {"action": "shell", "resource": "gh *", "effect": "deny"},
  {"action": "shell", "resource": "*/gh *", "effect": "deny"},
  {"action": "shell", "resource": "gt *", "effect": "deny"},
  {"action": "shell", "resource": "*/gt *", "effect": "deny"},
  {"action": "shell", "resource": "*skills publish*", "effect": "deny"},
  {"action": "shell", "resource": "*skills takeover*", "effect": "deny"},
  {"action": "shell", "resource": "*skills fix-round*", "effect": "deny"},
  {"action": "shell", "resource": "*skills lease-rebase*", "effect": "deny"},
  {"action": "shell", "resource": "*skills restack-layer*", "effect": "deny"}
]}
```

- The last matching rule wins. A shell rule matches each command a compound line splits into, redirects included, which is why the read only set ends in denies: `git status > x` matches `git status *`. Those denies also refuse a read like `rg "=>"`, so search with the grep tool. The read only set runs no test or build and reads nothing outside the working directory or in a `.env` file, so a read only brief asks for reading, never running, and inlines anything it needs from elsewhere.
- `-m` takes the `provider/model#variant` the roster gives the tier, verbatim. `opencode run` has no `--variant` flag, and a model with no `#variant` runs at whatever default its provider picks. `opencode api model.list` lists each model's variants, and an unknown one fails the run.
- `--standalone` runs a private server with this call's env. Only then do `OPENCODE_CONFIG_CONTENT` and `AGENT_HOOKS=0` reach it. A project's own `opencode.json`, even one allowing everything, does not loosen the set. `--auto` approves whatever the set does not deny, so the run never waits on the operator, and it never overrides a deny.
- `GIT_OPTIONAL_LOCKS=0` keeps the arm's `git status` from taking the owner's index lock.
- The `jq` step keeps the last assistant message's text in `<slug>.md`, which is the arm's output. Stdout without `--format json` carries every step's text, so never read it as the result. The NDJSON and the `.log` are the record.
- A read only arm keeps `AGENT_HOOKS=0`, the read only set, and the read only block under `codex-arms.md` **Through a harness** at the end of its prompt. A write arm drops `AGENT_HOOKS=0` so any edit hooks installed for OpenCode see its changes, takes the write set, and ends its prompt with the implementation block at the end of `codex-arms.md`.
- OpenCode has no service tier, so `codex-arms.md` **Fast mode** sets nothing here.
- A write arm's set is a net, not a sandbox: a command that reaches git indirectly, like a `cd .git` followed by a relative write, or `git` run from inside another program, still runs, so the implementation block in its prompt stays the guard.
- A provider can stall a run with no output, so `perl` ends it after 1800 seconds with exit 142. A nonzero exit, an `error` event in the NDJSON, or an empty `<slug>.md` is a failed task under `codex-arms.md` **Rules for every arm**. Before rerunning, delete the slug's files or take a fresh slug.
