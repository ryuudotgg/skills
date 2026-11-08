import { expect, test } from "bun:test";
import type { IndexRow } from "skills-core";
import { leftLine, selectBatch } from "./batch.ts";
import { heldLine, refusalLine, type Unmet } from "./needs.ts";

function row(id: string, effort: string, blockedBy = "-"): IndexRow {
  return {
    id,
    slug: `plan-${id}`,
    status: "TODO",
    pri: "P2",
    effort,
    blocked_by: blockedBy,
    ctx: "ctx-demo",
    branch: "-",
    updated: "2026-11-09",
    note: "-",
  };
}

test("each line names what is missing and where it runs", () => {
  const unmet: Unmet = { lacking: ["docker", "node"], runOn: ["Other", "Spare"], noFacts: false };

  expect(refusalLine("001", unmet)).toBe(
    "001 needs docker,node, this machine lacks it; run on Other, Spare",
  );

  expect(heldLine("001", { ...unmet, runOn: [] })).toBe(
    "held 001: needs docker,node, no known machine has it",
  );

  expect(heldLine("001", { ...unmet, noFacts: true })).toBe(
    "held 001: needs docker,node, this machine has no facts yet, run skills machine refresh; run on Other, Spare",
  );
});

test("a batch leaves a member this machine does not meet, and the members waiting on it", () => {
  const rows = [row("001", "S"), row("002", "XS", "001"), row("003", "S"), row("004", "M")];
  const unmet: Unmet = { lacking: ["docker"], runOn: [], noFacts: false };
  const batch = selectBatch(rows, "ctx-demo", { projects: new Map() }, (id) =>
    id === "001" ? unmet : undefined,
  );

  expect(batch.members.map(({ id }) => id)).toEqual(["003"]);
  expect(batch.left.map(leftLine)).toEqual([
    "left 001 needs docker, no known machine has it",
    "left 002 waits on 001 TODO",
    "left 004 effort M",
  ]);
});
