### Perf issue

**You own the measurement story. Plan, review, verify the numbers.** Tie every fix to a measurement, don't read source instead of measuring.

1. Capture a baseline trace on the matching surface: a live browser MCP (Playwright or equivalent, tool names matching `mcp__*playwright*`) or whatever preview MCP the harness exposes for a UI, the process itself for a CLI or server. Reuse whatever is already running, and never stop, restart or take over a process you did not start in this session, since the data behind it may be shared and live.
2. `how` to ground hypotheses; don't claim a perf ceiling without running it first.
   Most fixes come from eight strategy families. Use them as hypothesis generators, not a checklist. A family earns an attempt only when the trace shows the signal it names, and a focused fix for the dominant cost beats applying all eight.
   - **Elimination.** The cheapest work is work that doesn't run. Before optimizing the hot path, ask whether it needs to exist: a computation nobody consumes, a feature gate that's always off for this user, a sync that redundantly mirrors state, a legacy path kept "just in case". The trace shows what's slow, never that it's deletable, so this family needs the `how` pass, not the profiler. Deleting the work beats every other family when it applies.
   - **Divide and conquer.** The dominant cost scales with input size. Split the work so each piece touches less (chunk, shard, prune the search space) or so independent pieces run in parallel.
   - **Caching.** The same computation or fetch repeats on identical inputs. Store and reuse the result; name what invalidates it before claiming the win.
   - **Indirection.** The hot path does expensive work a cheaper intermediate could absorb: an index instead of a scan, a queue that shifts work off the interactive thread, a handle that lets a cheaper implementation swap in. Add the hop only when it removes more from the critical path than it adds; a layer that sits on the hot path without removing work is pure cost.
   - **Batching.** Many small operations each pay a fixed overhead (RPC, query, syscall, draw call). Coalesce them to pay the overhead once per batch.
   - **Redundancy.** The wait hangs on one slow instance or attempt. Duplicate the work (replicas, hedged requests, speculative execution) and take the fastest result. This trades extra load for lower tail latency, so the trace has to show the wait dominates and the system has headroom; duplication without that tradeoff only adds load.
   - **Lazy evaluation.** Cost lands on results that are never used or not needed yet (eager init on the boot path, rendering offscreen items). Defer the work until first use.
   - **Scheduling.** The work must happen, but not during the interactive moment. Move it to where nobody is waiting: idle callbacks, a background warmup after boot, precompute before the user arrives, cleanup after the frame commits. Distinct from Lazy (later-when-needed): Scheduling often runs the work *earlier* than the hot moment, or in its shadow. The win is perceived latency, so measure the interactive path, not total work done.
3. Plan the fix from the trace. If it crosses a function boundary, `architect` first. Delegate implementation to the `codex-sol` wrapper agent, which shells out to the Codex CLI (`codex exec --enable fast_mode -m gpt-5.6-sol -C <abs repo path> -o /tmp/codex/<slug>.md`); review the diff. Never pass an `isolation` parameter; worktrees are banned. Capture a post-fix trace.
   Apply the **sequence-verifiable-units** principle skill, verifying each attempt before trying the next.
4. Parse and compare the artifacts (JSON to sqlite, diff). "Inconclusive" or wrong-surface is not a pass; flag it.
5. Cite the measurement in the handback, baseline and post-fix numbers with the artifact paths. The work stays unstaged on the `feat/*` branch in the main tree; no commits, no pushes.
6. Run `handing-back.md`.

For sustained improvement against a metric rather than a one-off fix, run this playbook under the `/loop` skill, one hypothesis per iteration, logging each iteration through the **show-me-your-work** skill.

**Reply:** baseline number, post-fix number, delta, artifact path.
