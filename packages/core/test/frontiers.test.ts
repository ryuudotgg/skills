import { expect, test } from "bun:test";
import { frontiers, type PlanEvent } from "skills-core";

function added(project: string, id: string, blockedBy: string, counter: number): PlanEvent {
  return {
    kind: "row",
    type: "added",
    machine: "m",
    wall: 0,
    counter,
    ts: "1970-01-01T00:00:00Z",
    project,
    plan: id,
    row: {
      id,
      slug: `plan-${id}`,
      status: "TODO",
      pri: "P2",
      effort: "S",
      blocked_by: blockedBy,
      ctx: "-",
      branch: "-",
      updated: "1970-01-01",
      note: "-",
    },
  };
}

test("a blocker named twice, locally and by project, draws one edge", () => {
  const { edges } = frontiers([
    added("Alpha", "001", "-", 0),
    added("Alpha", "002", "001,Alpha/001", 1),
  ]);

  expect(edges).toEqual([{ from: "Alpha/001", to: "Alpha/002" }]);
});

test("a blocked_by cycle still places every node, in columns that do not move between folds", () => {
  const events = [
    added("Alpha", "001", "002", 0),
    added("Alpha", "002", "001", 1),
    added("Alpha", "003", "002", 2),
  ];

  const { nodes } = frontiers(events);
  expect(nodes.map((node) => node.key).sort()).toEqual(["Alpha/001", "Alpha/002", "Alpha/003"]);
  expect(frontiers(events).nodes).toEqual(nodes);
});

test("a ref to a project the events never mention draws no edge and holds the row", () => {
  const { projects, edges } = frontiers([added("Alpha", "001", "Gamma/001", 0)]);
  expect(edges).toEqual([]);
  expect(projects[0]?.held.map((entry) => entry.blockers)).toEqual([["Gamma/001"]]);
});

test("a node names its kind and id, so a project name holding # still reads as a plan", () => {
  const { nodes } = frontiers([added("C#Tools", "001", "-", 0)]);
  expect(nodes.map(({ key, kind, project, id }) => ({ key, kind, project, id }))).toEqual([
    { key: "C#Tools/001", kind: "plan", project: "C#Tools", id: "001" },
  ]);
});

test("a blocker that finished draws no line and leaves the plan it held in column 0", () => {
  const done = {
    ...added("Alpha", "001", "-", 0),
    row: { ...added("Alpha", "001", "-", 0).row, status: "DONE" },
  };

  const { nodes, edges, projects } = frontiers([done, added("Alpha", "002", "001", 1)]);

  expect(projects[0]?.ready.map((entry) => entry.row.id)).toEqual(["002"]);
  expect(edges).toEqual([]);
  expect(nodes.map((node) => `${node.key} ${node.column}`)).toEqual(["Alpha/001 0", "Alpha/002 0"]);
});
