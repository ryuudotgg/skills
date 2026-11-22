import { conflictRefusal, inConflict, issueRef, type Issue } from "./issues.ts";
import { type IndexRow, isClosed } from "./rows.ts";

export type BlockerRef =
  | { kind: "local"; text: string; id: string }
  | { kind: "plan"; text: string; project: string; id: string }
  | { kind: "issue"; text: string; project: string; n: string }
  | { kind: "bad"; text: string };

export type World = {
  projects: ReadonlyMap<string, readonly IndexRow[]>;
  issues: ReadonlyMap<string, Issue>;
};

export type BlockerState =
  | { kind: "released"; status: string }
  | { kind: "open"; status: string }
  | { kind: "no-project" }
  | { kind: "no-row" }
  | { kind: "no-issue" }
  | { kind: "conflict" }
  | { kind: "moved"; to: string; status: string }
  | { kind: "bad" };

const LOCAL = /^[0-9]+$/;
const PLAN = /^([^/#,\s\\]+)\/([0-9]{3})$/;
const ISSUE = /^([^/#,\s\\]+)#([1-9][0-9]*)$/;

function isProject(name: string): boolean {
  return name !== "." && name !== "..";
}

export function parseRef(text: string): BlockerRef {
  if (LOCAL.test(text)) return { kind: "local", text, id: text };

  const [, planProject = "", id = ""] = PLAN.exec(text) ?? [];
  if (isProject(planProject) && id) return { kind: "plan", text, project: planProject, id };

  const [, issueProject = "", n = ""] = ISSUE.exec(text) ?? [];
  if (isProject(issueProject) && n) return { kind: "issue", text, project: issueProject, n };

  return { kind: "bad", text };
}

export function parseBlockers(column: string): BlockerRef[] {
  const seen = new Set<string>();
  const refs: BlockerRef[] = [];
  for (const item of column.split(",")) {
    const text = item.replace(/^[ \t]+|[ \t]+$/g, "");
    if (text === "" || text === "-" || seen.has(text)) continue;

    seen.add(text);
    refs.push(parseRef(text));
  }

  return refs;
}

export function localIds(column: string): string[] {
  return parseBlockers(column).flatMap((ref) => (ref.kind === "local" ? [ref.id] : []));
}

export function isForeign(ref: BlockerRef): boolean {
  return ref.kind === "plan" || ref.kind === "issue";
}

function issueState(issue: Issue | undefined): BlockerState {
  if (!issue) return { kind: "no-issue" };
  if (inConflict(issue)) return { kind: "conflict" };

  return issue.state.kind === "closed"
    ? { kind: "released", status: "closed" }
    : { kind: "open", status: "open" };
}

export function issueTargets(ref: string, world: World, waiting?: string): string[] {
  const issue = world.issues.get(ref);
  if (!issue) {
    const landed = [...world.issues.values()].filter((one) =>
      one.arrivals.some((arrival) => arrival.ref === waiting && arrival.from === ref),
    );

    return landed.length > 0 ? landed.map(issueRef) : [ref];
  }

  const moved = issue.forwards.flatMap((one) => (one.ref === waiting ? [one.to] : []));
  if (moved.length === 0) return [ref];

  const stays = [issue, ...issue.rivals].some((filing) =>
    filing.links.some((link) => link.kind === "blocks" && link.ref === waiting),
  );

  return stays ? [ref, ...moved] : moved;
}

export function blockerState(
  ref: BlockerRef,
  rows: readonly IndexRow[],
  world: World,
  waiting?: string,
): BlockerState {
  if (ref.kind === "bad") return { kind: "bad" };
  if (ref.kind === "issue") {
    const states = issueTargets(ref.text, world, waiting).map((to) => ({
      to,
      state: issueState(world.issues.get(to)),
    }));

    const held = states.find(({ state }) => state.kind !== "released");
    if (!held) return { kind: "released", status: "closed" };
    if (held.to === ref.text) return held.state;

    return { kind: "moved", to: held.to, status: describeState(held.state) };
  }

  const scope = ref.kind === "local" ? rows : world.projects.get(ref.project);
  if (!scope) return { kind: "no-project" };

  const status = scope.find((row) => row.id === ref.id)?.status;
  if (status === undefined) return { kind: "no-row" };

  return isClosed(status) ? { kind: "released", status } : { kind: "open", status };
}

export function describeState(state: BlockerState): string {
  switch (state.kind) {
    case "released":
    case "open":
      return state.status;

    case "no-project":
      return "no such project";

    case "no-row":
      return "missing";

    case "no-issue":
      return "no such issue";

    case "conflict":
      return "filed more than once";

    case "moved":
      return `moved to ${state.to}, ${state.status}`;

    case "bad":
      return "not a blocker ref";
  }
}

export function unreleasedReason(ref: BlockerRef, state: BlockerState): string | undefined {
  switch (state.kind) {
    case "released":
      return undefined;

    case "open":
      if (ref.kind === "issue") return `blocker ${ref.text} is an open issue`;
      return ref.kind === "plan"
        ? `blocker ${ref.text} is ${state.status} in ${ref.project}`
        : `blocker ${ref.text} is ${state.status}`;

    case "conflict":
      return `blocker ${conflictRefusal(ref.text)}`;

    case "moved":
      return `blocker ${ref.text} moved to ${state.to}, which is ${state.status}`;

    default:
      return `blocker ${ref.text}: ${describeState(state)}`;
  }
}

export function foreignRefusal(
  row: IndexRow,
  rows: readonly IndexRow[],
  world: World,
  project?: string,
): string | undefined {
  for (const ref of parseBlockers(row.blocked_by)) {
    if (ref.kind === "local") continue;

    const waiting = project && `${project}/${row.id}`;
    const reason = unreleasedReason(ref, blockerState(ref, rows, world, waiting));
    if (reason) return reason;
  }

  return undefined;
}

export type ProseRef = { ref: BlockerRef & { project: string }; start: number; end: number };

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export function proseRefs(prose: string, world: World): ProseRef[] {
  const names = [...world.projects.keys()].sort((one, other) => other.length - one.length);
  if (names.length === 0) return [];

  const pattern = new RegExp(
    `(?<=^|[\\s([{"'\`,;:*_|<>])(?:${names.map(escaped).join("|")})[/#][0-9]+(?![0-9A-Za-z_/-])`,
    "gu",
  );

  const found: ProseRef[] = [];
  for (const match of prose.matchAll(pattern)) {
    const ref = parseRef(match[0]);
    if (ref.kind === "plan" || ref.kind === "issue")
      found.push({ ref, start: match.index, end: match.index + match[0].length });
  }

  return found;
}
