import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryConfig } from "../delivery.ts";
import { fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, suiteEnvironment } from "../test/process.ts";
import { scheduleLines, scheduleVerb } from "./schedule.ts";

const usage = "skills plans schedule <Project>";
const digest =
  'task machine skills audit digest\t{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1]}';

function config(content: string, overrides: Partial<DeliveryConfig> = {}): DeliveryConfig {
  return {
    mode: "hands-off",
    names: [],
    notes: [],
    content,
    invalid: false,
    path: "/conf",
    ...overrides,
  };
}

describe("schedule lines", () => {
  test("every key unset turns every task off and says which key", () => {
    expect(scheduleLines("Skills", config("DELIVERY=prs\n"))).toEqual([
      "off skills audit digest: AUDIT_DIGEST is unset",
      "off plans resume Skills: PLANS_RESUME_EVERY is unset",
      "off plans sweep Skills: PLANS_SWEEP_EVERY is unset",
    ]);
  });

  test("no skills config turns every task off", () => {
    expect(scheduleLines("Skills", config("", { path: "" }))).toEqual([
      "off skills audit digest: AUDIT_DIGEST is unset",
      "off plans resume Skills: PLANS_RESUME_EVERY is unset",
      "off plans sweep Skills: PLANS_SWEEP_EVERY is unset",
    ]);
  });

  test("set keys become tasks with their schedules", () => {
    const content = "AUDIT_DIGEST=weekly\nPLANS_RESUME_EVERY=20m\nPLANS_SWEEP_EVERY=30\n";
    expect(scheduleLines("Skills", config(content))).toEqual([
      digest,
      'task project plans resume Skills\t{"type":"interval","everyMs":1200000}',
      'task project plans sweep Skills\t{"type":"interval","everyMs":1800000}',
    ]);
  });

  test.each<[string, string]>([
    [
      "PLANS_SWEEP_EVERY=5\n",
      'task project plans sweep Skills\t{"type":"interval","everyMs":300000}',
    ],
    [
      "PLANS_SWEEP_EVERY=4\n",
      "off plans sweep Skills: /conf: PLANS_SWEEP_EVERY=4 is not whole minutes, at least 5",
    ],
    [
      "PLANS_SWEEP_EVERY=30m\n",
      "off plans sweep Skills: /conf: PLANS_SWEEP_EVERY=30m is not whole minutes, at least 5",
    ],
    [
      "PLANS_SWEEP_EVERY=\n",
      "off plans sweep Skills: /conf: PLANS_SWEEP_EVERY= is not whole minutes, at least 5",
    ],
    [
      "PLANS_SWEEP_EVERY=30\nPLANS_SWEEP_EVERY=60\n",
      "off plans sweep Skills: /conf: PLANS_SWEEP_EVERY is set more than once",
    ],
  ])("%j", (content, expected) => {
    expect(scheduleLines("Skills", config(content))[2]).toBe(expected);
  });

  test("an interval too long to schedule is off", () => {
    const huge = "9".repeat(400);
    const lines = scheduleLines(
      "Skills",
      config(`PLANS_RESUME_EVERY=${huge}m\nPLANS_SWEEP_EVERY=${huge}\n`),
    );

    expect(lines[1]).toBe("off plans resume Skills: PLANS_RESUME_EVERY is too long to schedule");
    expect(lines[2]).toBe("off plans sweep Skills: PLANS_SWEEP_EVERY is too long to schedule");
  });

  test("a digest value other than weekly is off", () => {
    expect(scheduleLines("Skills", config("AUDIT_DIGEST=daily\n"))[0]).toBe(
      "off skills audit digest: /conf: AUDIT_DIGEST=daily is not weekly",
    );
  });

  test("an invalid config turns every task off with its note", () => {
    const invalid = config("x\n", { invalid: true, notes: ["/conf: line 1: malformed"] });
    expect(scheduleLines("Skills", invalid)).toEqual([
      "off skills audit digest: /conf: line 1: malformed",
      "off plans resume Skills: /conf: line 1: malformed",
      "off plans sweep Skills: /conf: line 1: malformed",
    ]);
  });
});

describe("skills plans schedule", () => {
  let temporary: string;
  let repo: string;

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), "skills-schedule-"));
    repo = join(temporary, "fixture");
    await writeFixture(temporary, "skills.conf", "DELIVERY=prs\nPLANS_SWEEP_EVERY=30\n");
    await fixtureGit(temporary, ["init", "-q", "-b", "main", repo]);
  });

  afterEach(async () => {
    await removeTemporary(temporary);
  });

  async function pass(args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      cwd: repo,
      env: { ...suiteEnvironment(), SKILLS_CONF: join(temporary, "skills.conf") },
      capture: true,
      out: (text: string) => void out.push(text),
      err: (text: string) => void err.push(text),
    };

    const code = await scheduleVerb(args, usage, io);
    return { code, out: out.join(""), err: err.join("") };
  }

  test("prints each task from the skills config", async () => {
    expect(await pass(["fixture"])).toEqual({
      code: 0,
      out: [
        "off skills audit digest: AUDIT_DIGEST is unset",
        "off plans resume fixture: PLANS_RESUME_EVERY is unset",
        'task project plans sweep fixture\t{"type":"interval","everyMs":1800000}',
        "",
      ].join("\n"),
      err: "",
    });
  });

  test("refuses a checkout of another project", async () => {
    const result = await pass(["Other"]);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toStartWith("schedule: ");
  });

  test("refuses anything but one project", async () => {
    expect((await pass([])).code).toBe(2);
    expect((await pass(["fixture", "extra"])).code).toBe(2);
    expect((await pass(["--dry-run"])).code).toBe(2);
  });
});
