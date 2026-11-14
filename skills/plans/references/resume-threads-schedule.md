## /plans resume

One pass over the project's stalled threads: each DOING row whose thread is idle, with its last turn ended at neither a handback nor an open question to the operator, gets one message naming the cause and asking it to carry on. `/plans schedule` registers it as a recurring task when `PLANS_RESUME_EVERY` is set. The CLI applies the decision table and the nudge limits; this section gathers the facts and sends. Outside T3 Code there are no threads to read, so say so and stop.

1. Detect the project. Run `<playbook>/bin/skills plans resume <Project>` and quote its output. `off` means the key is unset or invalid: stop there. Otherwise, after `every <n>m`, each DOING row prints `skip <id> handed back`, `skip <id> moving to <target>` for a plan `plans move` sent away (`any` when it named no device), or `read <id> <thread> <checkout>`: the thread bound since the row's latest `start` or `review` line, and the checkout holding its branch, each `-` when there is none.
2. For each `read` line, find the thread: the one it names, else, for a row never bound, the newest top-level thread `t3_thread_list` returns for `titleContains` `plans <id> `, which is how `/plans wave` titles them. A thread whose `worktreePath` is not the line's checkout, when it names one, is not the row's. A row with no thread is left out of the facts.
3. Read each thread with `t3_thread_read`, first with `limit` 1 and `runLimit` 1, then its tail with `view` `activity`, `afterPosition` its `itemCount` minus 11 (left out below 0), `limit` 10 and `maxCharsPerItem` 400. Its facts are one JSON object: `id`, `thread`, `status` and `pendingRequestCount` from the thread, `run` holding `runId`, `status` and `completedAt` from `recentRuns[0]`, `items` holding each tail item's `runId`, `type`, `status`, `title` and `text` as returned, and three readings of the latest run's last assistant message, read in full first (an item marked `textTruncated` is read again by `itemId` and `textOffset` until `nextTextOffset` is null):
   - `asks`, true when it ends the turn on the operator: a question, or a refusal or blocker it leaves for the operator to clear. An API error or usage limit message is neither.
   - `waits`, true when it ends the turn to wait on its own background work that reports back, such as a check, an arm or a subagent.
   - `resetAt`, only when a usage limit message names its reset time, as an ISO time in UTC.

   A thread whose first run has not started takes `run` `null`.
4. Pipe the array of facts to `<playbook>/bin/skills plans resume <Project> --facts` and quote its output. A `skip <id> <reason>` line needs nothing. For each `nudge <id> <cause> <thread> <run> <message>` line:
   1. Read the thread again with `runLimit` 1. When `recentRuns[0].runId` is no longer `<run>`, or the thread is preparing, queued, starting, running or waiting, send nothing: it moved on by itself.
   2. Send the message with `t3_thread_send`, `mode` `queue` and `clientRequestId` `nudge <id> <run>`. A queued message never steers or restarts a turn. A send that errors or loses its response is retried with the same `clientRequestId`, which T3 dedupes.
   3. Once T3 accepts it, `<playbook>/bin/skills plans log <Project> <id> nudge "<cause> <run>"`. That line is what stops a later pass from nudging the same stall again, or the row more than once an hour.
5. Reply with both outputs and one line per message sent, `[plans <id>](t3-thread://v1/<thread>)` and its cause. Settle this thread as the turn's last call, unless a step or a send refused, which the operator needs to see.

## /plans threads resume

One pass over this repository's stalled ad hoc threads: each T3 thread linked to an open PR on a rowless branch carrying the publish mark, whose last ad hoc trail event is `start`, idle with its last turn ended at neither a handback nor an open question to the operator, gets one message naming the cause and asking it to carry on. It detects no project and runs from whatever checkout it starts in, one that maps to no plans project included. `/plans schedule` registers it as a recurring task when `THREADS_RESUME_EVERY` is set. The CLI applies the decision table `/plans resume` uses and the same nudge limits, read from the branch's own `nudge` trail lines; this section gathers the facts and sends. Outside T3 Code there are no threads to read, so say so and stop.

1. Run `<playbook>/bin/skills threads resume` and quote its output. `off` means the key is unset or invalid: stop there. Otherwise, after `every <n>m`, each started branch that still carries the mark prints `skip <branch> <reason>`, or `read <branch> <pr url>` when its PR is open. A mark or PR read that failed is named on its branch's `skip` line and makes the run exit 1, which counts as a refusal at step 5.
2. For each `read` line, find the thread only through T3's link from a thread to its PR, in this thread's own T3 project: the top-level threads `t3_thread_list` returns, settled or not, paged with `cursor` until `nextCursor` is null, whose `pullRequests` holds an entry with that `url`. A branch with no such thread is left out of the facts. So is one with two or more, and the reply names it with their links, since a nudge cannot pick between them.
3. Read each thread as `/plans resume` step 3 says, and write the same facts object with `branch` in place of `id`.
4. Pipe the array of facts to `<playbook>/bin/skills threads resume --facts` and quote its output. A `skip <branch> <reason>` line needs nothing, `nudged through <branch>` included: a thread that babysits a stack gets one message per pass, however many of its layers stalled. For each `nudge <branch> <cause> <thread> <run> <message>` line, run `/plans resume` step 4's three steps, with `clientRequestId` `threads nudge <branch> <run>` and the log line written by `<playbook>/bin/skills threads log <branch> nudge "<cause> <run>"`.
5. Reply with both outputs and one line per message sent, `[<branch>](t3-thread://v1/<thread>)` and its cause, quoting the `nudge` line it added to `log.tsv`. Settle this thread as the turn's last call, unless a step or a send refused, which the operator needs to see.

## /plans schedule

Registers, in T3 Code's scheduler, each task below whose skills config key holds a valid value. A key that is unset, or set to anything else, registers nothing and changes nothing. Outside T3 Code there is no scheduler, so say so and stop.

| key                    | value                         | title                    | schedule                                                        | scope            |
| ---------------------- | ----------------------------- | ------------------------ | --------------------------------------------------------------- | ---------------- |
| `AUDIT_DIGEST`         | `weekly`                      | `skills audit digest`    | `{"type": "fixed_time", "timeOfDay": "09:00", "weekdays": [1]}` | once per machine |
| `PLANS_RESUME_EVERY`   | `<n>m`                        | `plans resume <Project>` | `{"type": "interval", "everyMs": <n times 60000>}`              | once per project |
| `PLANS_SWEEP_EVERY`    | `<n>`, whole minutes, 5 or up | `plans sweep <Project>`  | `{"type": "interval", "everyMs": <n times 60000>}`              | once per project |
| `THREADS_RESUME_EVERY` | `<n>m`                        | `threads resume <repo>`  | `{"type": "interval", "everyMs": <n times 60000>}`              | once per project |
| `DIGEST_WEEKLY`        | `on`                          | `skills digest`          | `{"type": "fixed_time", "timeOfDay": "09:00", "weekdays": [1]}` | once per machine |

Each key is unset by default, and unset registers no task. `<repo>` is the plans project when the checkout maps to one, else the main checkout's directory name, the name the ad hoc trail uses.

1. Detect the project. Run `<playbook>/bin/skills plans schedule <Project>`, or `plans schedule` with no project when the checkout maps to none, which here replaces the question Project detection asks: the two plans tasks print `off` and `threads resume <repo>` still prints. Quote its output. It reads the skills config and writes nothing. Each row prints `task <scope> <title>`, a tab, and the schedule as JSON, or `off <title>: <reason>`, naming the key that is unset or the value it refused. An `off` row is left out, and the reply names it with its reason.
2. Find the tasks already registered. A machine scoped title counts as registered when any project lists it: run `t3_project_list`, then `list_scheduled_tasks` with each project's id. A project scoped title counts only in this project. Any task whose title is in no `task` line is left alone. A registered task whose schedule differs from its line's gets `schedule_task` with its `scheduledTaskId` and that schedule, so a changed interval takes effect.
3. Register each missing one with `schedule_task`: the line's title and schedule, the title as `clientRequestId`, `bindToCurrentThread: false` so every run opens its own fresh thread, and the row's prompt below with `<playbook>` written out as its absolute path. A run inherits this thread's provider, model and modes, and a thread can message only threads whose modes are no broader than its own, so register `plans resume <Project>`, `plans sweep <Project>` and `threads resume <repo>` from a thread running in the mode of the threads they message.
4. Print one line per registered task, new or not: its title, its cadence and its next run.

The `skills audit digest` prompt:

```
Run <playbook>/bin/skills audit --days 7 --prs --digest by its absolute path, from this project's checkout.
Reply with its stdout verbatim in one code block, after one line naming how many fields it flagged.
Change no file beyond the run it saves, open no PR, post nowhere else, and do not settle this thread.
```

The `skills digest` prompt, which settles its own thread when the verb succeeds:

```
Run <playbook>/bin/skills digest --week <the date seven days before today, as YYYY-MM-DD> by its absolute path.
Reply with the line it prints.
Edit no file by hand, open no PR, post nowhere else, and settle this thread as the turn's last call unless the verb failed.
```

It names a date a week back because a run with no `--week` writes the week in progress, and a week back still names the finished week when the run fires a day or two late. The digest lands as a `digest` event in the plans store, and the dashboard's `/digests` view shows it.

The `plans resume <Project>` prompt, which settles its own thread when nothing went wrong:

```
/plans resume
```

The `threads resume <repo>` prompt, which settles its own thread when nothing went wrong:

```
/plans threads resume
```

The `plans sweep <Project>` prompt, which settles its own thread when nothing refused, so a run that finds nothing leaves nothing in the operator's active list:

```
/plans close
This thread works no plan, so settle it as the turn's last call unless a close refused, whatever branch the checkout is on.
```
