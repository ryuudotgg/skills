import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { COLUMNS } from "./index-tsv.ts";
import { findOverlaps, frontmatterBlockers, type OverlapPlan } from "./overlap.ts";

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
let temporary: string;
let plans: string;
let repo: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "skills-overlap-"));
  plans = join(temporary, "plans");
  repo = join(temporary, "fixture");

  await writeFixture(temporary, "skills.conf", "DELIVERY=hands-off\n");
  await fixtureGit(temporary, ["init", "-q", "-b", "main", repo]);
  await writeFixture(repo, "shared.ts", "first second\n");
  await writeFixture(repo, "other.ts", "third\n");
  await writeFixture(plans, "fixture/index.tsv", `${COLUMNS.join("\t")}\n`);
});

afterEach(async () => {
  await removeTemporary(temporary);
});

async function plan(id: string, probe: string, blockedBy = "-"): Promise<void> {
  await writeFixture(
    plans,
    `fixture/${id}-plan-${id}.md`,
    `---\nid: ${id}\nblocked_by: ${blockedBy}\nsurface: plans\n---\n\n# ${id}\n\n## Probe\n\n    ${probe}\n\n## Constraints\n`,
  );
}

function lint(args: readonly string[], cwd = repo) {
  return runCommand([bin, "plans", "lint", ...args], {
    cwd,
    env: {
      ...suiteEnvironment(),
      PLANS_DIR: plans,
      SKILLS_CONF: join(temporary, "skills.conf"),
    },
    timeout: 60_000,
  });
}

function probed(id: string, hits: string[], blockedBy: string[] = [], added = false) {
  return { id, blockedBy, added, probe: { ok: true, hits } } satisfies OverlapPlan;
}

describe("plans lint --overlap", () => {
  test("reports only the unordered pair of a batch with no rows yet", async () => {
    await plan("001", "rg first .");
    await plan("002", "rg -n second .");
    await plan("003", "rg third .");
    await plan("004", "rg third other.ts", "003");

    const result = await lint(["fixture", "--overlap"]);
    expect(result.stdout).toBe("overlap 001 002 shared.ts\n");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(1);

    expect((await lint(["fixture"])).stdout).toBe("ok\n");
  });

  test("an index edge orders a new plan, added pairs pass and a new unprobed plan is noted", async () => {
    await plan("001", "rg first .");
    await plan("002", "rg second .");
    await plan("003", "rg first shared.ts");

    await plan("004", "rg first .", "002");
    await plan("005", "rg first missing.ts");
    await plan("006", "rg first missing.ts");
    const rows = [
      ["001", "plan-001", "TODO", "P1", "S", "-", "-", "-", "2026-10-25", "-"],
      ["002", "plan-002", "DOING", "P1", "S", "001", "-", "feat/b", "2026-10-25", "-"],
      ["003", "plan-003", "DROPPED", "P1", "S", "-", "-", "-", "2026-10-25", "-"],
      ["006", "plan-006", "TODO", "P1", "S", "-", "-", "-", "2026-10-25", "-"],
    ];

    await writeFixture(
      plans,
      "fixture/index.tsv",
      `${[COLUMNS, ...rows].map((row) => row.join("\t")).join("\n")}\n`,
    );

    const result = await lint(["fixture", "--overlap"]);
    expect(result.stdout).toBe("unprobed 005: rg exited 2\nunprobed 006: rg exited 2\n");
    expect(result.code).toBe(0);
  });

  test("only the index orders an added plan and a shared id refuses", async () => {
    await plan("001", "rg first .");
    await plan("002", "rg third .", "001");
    await plan("003", "rg second .", "002");
    await writeFixture(
      plans,
      "fixture/index.tsv",
      `${COLUMNS.join("\t")}\n${["002", "plan-002", "TODO", "P1", "S", "-", "-", "-", "2026-10-25", "-"].join("\t")}\n${["001", "plan-001", "TODO", "P1", "S", "-", "-", "-", "2026-10-25", "-"].join("\t")}\n`,
    );

    expect((await lint(["fixture", "--overlap"])).stdout).toBe("overlap 001 003 shared.ts\n");

    await writeFixture(plans, "fixture/003-twin.md", "# twin\n");
    const twin = await lint(["fixture", "--overlap"]);
    expect(twin.code).toBe(1);
    expect(twin.stderr).toBe("lint: two open plan files hold id 003\n");
  });

  test("refuses another checkout and an id beside the flag", async () => {
    expect((await lint(["fixture", "001", "--overlap"])).code).toBe(2);
    expect((await lint(["--overlap"])).code).toBe(2);

    const other = await lint(["other", "--overlap"]);
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("not a checkout of other");
  });

  test("a transitive edge orders a pair and two added plans are left alone", () => {
    expect(
      findOverlaps([
        probed("001", ["a.ts"]),
        probed("002", ["b.ts"], ["001"]),
        probed("003", ["a.ts"], ["002"]),
        probed("004", ["c.ts", "d.ts"], [], true),
        probed("005", ["d.ts"], [], true),
        probed("006", ["d.ts", "c.ts"]),
        { id: "007", blockedBy: [], added: false, probe: { ok: false, reason: "no rg" } },
        { id: "008", blockedBy: [], added: true, probe: { ok: false, reason: "no rg" } },
      ]),
    ).toEqual({
      overlaps: ["overlap 004 006 c.ts", "overlap 005 006 d.ts"],
      unprobed: ["unprobed 007: no rg", "unprobed 008: no rg"],
    });
  });

  test("reads blocked_by only from the frontmatter", () => {
    expect(frontmatterBlockers("---\nid: 004\nblocked_by: 001, 003\n---\n")).toEqual([
      "001",
      "003",
    ]);

    expect(frontmatterBlockers("---\nblocked_by: -\n---\n")).toEqual([]);
    expect(frontmatterBlockers("# Plan\nblocked_by: 001\n")).toEqual([]);
    expect(frontmatterBlockers("---\nid: 1\n---\nblocked_by: 001\n")).toEqual([]);
  });
});
