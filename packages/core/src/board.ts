import { foldRows, type PlanEvent, type PrRecord } from "./events.ts";
import { foldLeases, leasePlan, pinLive, type PlanLeases } from "./leases.ts";
import { machineLabels } from "./machine.ts";
import { prFrom } from "./plan.ts";
import { HEARTBEAT, STALE_AFTER_MS } from "./pulse.ts";
import { silencedProjects } from "./stats.ts";

export type BoardPr = Pick<PrRecord, "pr" | "state" | "verdict" | "failing">;

export type BoardHeartbeat = { minutes: number; stale: boolean };

export type BoardRow = {
  project: string;
  id: string;
  slug: string;
  branch: string;
  machine?: string;
  thread?: string;
  pr?: BoardPr;
  heartbeat?: BoardHeartbeat;
  conflict?: string;
};

type Trace = {
  starter?: string;
  thread?: string;
  prs: Map<string, BoardPr>;
  heartbeat?: number;
};

type Holding = { holder?: string; conflict?: string };

function holding(leases: PlanLeases | undefined, now: number): Holding {
  const live = [...(leases?.claims.values() ?? [])].filter(
    (claim) => !claim.pinned || pinLive(claim, now),
  );

  const refused = live.find((claim) => claim.conflict !== null);
  if (refused?.conflict) return { holder: refused.label, conflict: refused.conflict.label };

  return { holder: (live.find((claim) => !claim.provisional) ?? live[0])?.label };
}

function trace(traces: Map<string, Trace>, event: PlanEvent): void {
  const key = leasePlan(event.project, event.plan);
  const seen: Trace = traces.get(key) ?? { prs: new Map() };
  traces.set(key, seen);

  if (event.kind === "trail" && event.type === "start") {
    seen.starter = event.machine;
    seen.heartbeat = undefined;
    seen.thread = undefined;
  }

  if (event.kind === "trail" && event.type === "thread") seen.thread = event.detail;
  if (event.kind !== "stored") return;

  const pr = event.type === "pr" ? prFrom(event.payload) : undefined;
  if (pr) seen.prs.set(pr.branch, pr);
  if (event.type === HEARTBEAT) seen.heartbeat = Date.parse(event.ts);
}

function heartbeatAt(at: number | undefined, now: number): BoardHeartbeat | undefined {
  if (at === undefined) return undefined;
  const age = Math.max(0, now - at);
  return { minutes: Math.floor(age / 60_000), stale: age > STALE_AFTER_MS };
}

function byPlan(left: BoardRow, right: BoardRow): number {
  const [one, other] = [`${left.project}\t${left.id}`, `${right.project}\t${right.id}`];
  return one < other ? -1 : one > other ? 1 : 0;
}

export function boardRows(events: Iterable<PlanEvent>, now: number): BoardRow[] {
  const list = [...events];
  const silenced = silencedProjects(list);
  const labels = machineLabels(list);
  const leases = foldLeases(list);

  const traces = new Map<string, Trace>();
  for (const event of list) if (!silenced.has(event.project)) trace(traces, event);

  const board: BoardRow[] = [];
  for (const [project, rows] of foldRows(list)) {
    if (silenced.has(project)) continue;

    for (const row of rows.values()) {
      if (row.status !== "DOING") continue;

      const key = leasePlan(project, row.id);
      const seen = traces.get(key);
      const { holder, conflict } = holding(leases.get(key), now);
      const starter = seen?.starter === undefined ? undefined : labels.get(seen.starter);
      const pr = seen?.prs.get(row.branch);
      board.push({
        project,
        id: row.id,
        slug: row.slug,
        branch: row.branch,
        machine: holder ?? starter,
        thread: seen?.thread,
        pr: pr && { pr: pr.pr, state: pr.state, verdict: pr.verdict, failing: pr.failing },
        heartbeat: heartbeatAt(seen?.heartbeat, now),
        conflict,
      });
    }
  }

  return board.sort(byPlan);
}
