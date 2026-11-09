import { expect, test } from "bun:test";
import {
  blockerState,
  frontier,
  type IndexRow,
  localIds,
  next,
  parseBlockers,
  proseRefs,
  renderFrontier,
  type World,
} from "skills-core";

function row(id: string, status: string, blockedBy = "-", branch = "-"): IndexRow {
  return {
    id,
    slug: `plan-${id}`,
    status,
    pri: "P2",
    effort: "S",
    blocked_by: blockedBy,
    ctx: "-",
    branch,
    updated: "2026-11-08",
    note: "-",
  };
}

function world(projects: Record<string, IndexRow[]>): World {
  return { projects: new Map(Object.entries(projects)), issues: new Map() };
}

test("one parser reads local ids, plan refs, issue refs, mixed lists and a dash", () => {
  expect(parseBlockers("168")).toEqual([{ kind: "local", text: "168", id: "168" }]);
  expect(parseBlockers("Stanza/168")).toEqual([
    { kind: "plan", text: "Stanza/168", project: "Stanza", id: "168" },
  ]);

  expect(parseBlockers("Stanza#3")).toEqual([
    { kind: "issue", text: "Stanza#3", project: "Stanza", n: "3" },
  ]);

  expect(parseBlockers("168, Stanza/168,Stanza#3,168").map((ref) => ref.kind)).toEqual([
    "local",
    "plan",
    "issue",
  ]);

  expect(parseBlockers("-")).toEqual([]);
  expect(parseBlockers("")).toEqual([]);
  expect(localIds("168,Stanza/170,Skills#2,171")).toEqual(["168", "171"]);
});

test("a space inside a token, a short plan id or a zero issue is bad, never a ref", () => {
  expect(parseBlockers("001 002,PR #137,Stanza/16,Stanza#0,../001").map((ref) => ref.kind)).toEqual(
    ["bad", "bad", "bad", "bad", "bad"],
  );
});

test("a plan ref is released only by DONE or DROPPED in its own project", () => {
  const others = world({ Beta: [row("001", "TODO"), row("002", "DONE"), row("003", "DROPPED")] });
  const state = (text: string) => blockerState(parseBlockers(text)[0]!, [], others);

  expect(state("Beta/001")).toEqual({ kind: "open", status: "TODO" });
  expect(state("Beta/002")).toEqual({ kind: "released", status: "DONE" });
  expect(state("Beta/003")).toEqual({ kind: "released", status: "DROPPED" });

  expect(state("Beta/999")).toEqual({ kind: "no-row" });
  expect(state("Nowhere/001")).toEqual({ kind: "no-project" });
  expect(state("Beta#1")).toEqual({ kind: "no-issue" });
});

test("the frontier holds a row on an open plan ref verbatim and never stacks on it", () => {
  const rows = [row("001", "TODO"), row("003", "TODO", "Beta/001"), row("004", "TODO", "002")];
  const local = row("002", "REVIEW", "-", "feat/two");
  const open = world({ Beta: [row("001", "REVIEW", "-", "feat/two")] });
  const result = frontier([...rows, local], open);

  expect(result.ready.map((entry) => [entry.row.id, entry.stacksOn])).toEqual([
    ["001", undefined],
    ["004", "002"],
  ]);

  expect(result.held.map((entry) => [entry.row.id, entry.blockers])).toEqual([
    ["003", ["Beta/001"]],
  ]);

  expect(renderFrontier(rows, open)).toContain(
    "plan-003                           waits on Beta/001",
  );

  expect(next(rows, world({ Beta: [row("001", "DROPPED")] }))).toBe("001");
  expect(
    frontier(rows, world({ Beta: [row("001", "DONE")] })).ready.map((entry) => entry.row.id),
  ).toEqual(["001", "003"]);
});

test("an issue ref or a bad token holds its row until something can release it", () => {
  const rows = [row("001", "TODO", "Beta#1"), row("002", "TODO", "001 002")];
  expect(frontier(rows, world({ Beta: [] })).held.map((entry) => entry.blockers)).toEqual([
    ["Beta#1"],
    ["001 002"],
  ]);
});

test("prose reads a ref only where its project exists and the token ends", () => {
  const known = world({ Stanza: [], pull: [] });
  const found = (text: string) => proseRefs(text, known).map(({ ref }) => ref.text);

  expect(found("waits on Stanza/168, then Stanza#3.")).toEqual(["Stanza/168", "Stanza#3"]);
  expect(found("see evidence/174-review/ and assets/208/d-marquee")).toEqual([]);
  expect(found("merged in Other/638 and pull/638")).toEqual(["pull/638"]);
  expect(found("see xStanza/168 and (Stanza/169)")).toEqual(["Stanza/169"]);
  expect(found("plan **Stanza/170**, |Stanza/171|")).toEqual(["Stanza/170", "Stanza/171"]);
  expect(
    proseRefs("Beta+/001 and Beta/001", world({ "Beta+": [] })).map(({ ref }) => ref.text),
  ).toEqual(["Beta+/001"]);
});
