import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { plans } from "../areas/plans.ts";
import { capture, envOf } from "../test/hub-checkout.ts";
import { DAY, enrolledPair, hub, runCleanup } from "../test/hub-machines.ts";
import { leaseBreakVerb, pinVerb } from "./lease-verbs.ts";

setDefaultTimeout(60_000);

afterEach(runCleanup);

function usageOf(name: string): string {
  const verb = plans.verbs.find((entry) => entry.name.join(" ") === name);
  if (verb === undefined) throw new Error(`no verb ${name}`);
  return verb.usage;
}

const pinUsage = usageOf("plans pin");

const breakUsage = usageOf("plans lease break");

test("pin prints its usage and exits 2 on a repeated or bare --for, an unknown flag and no id", async () => {
  const cases = [
    ["Skills", "001", "--for", "1d", "--for", "2d"],
    ["Skills", "001", "--for"],
    ["Skills", "--x", "001"],
    ["Skills"],
    [],
  ];

  for (const args of cases) {
    const { io, out, err } = capture("/", {});
    const code = await pinVerb(args, pinUsage, io);
    expect({ args, code, out, err: err.join("") }).toEqual({
      args,
      code: 2,
      out: [],
      err: "usage: skills plans pin <Project> <id>... [--for <duration>]\n",
    });
  }
});

test("lease break prints its usage and exits 2 without exactly a project and an id", async () => {
  for (const args of [["Skills"], ["Skills", "001", "002"], []]) {
    const { io, out, err } = capture("/", {});
    const code = await leaseBreakVerb(args, breakUsage, io);
    expect({ args, code, out, err: err.join("") }).toEqual({
      args,
      code: 2,
      out: [],
      err: "usage: skills plans lease break <Project> <id>\n",
    });
  }
});

test("pin refuses a lease over 30 days before it looks for a hub", async () => {
  const { io, out, err } = capture("/", {});
  expect(await pinVerb(["Skills", "002", "--for", "31d"], pinUsage, io)).toBe(1);
  expect(out.join("")).toBe("pin 002 refused: at most 30d\n");
  expect(err).toEqual([]);
});

test("pin takes a seven day lease by default, and lease break refuses a plan nobody holds", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  const env = envOf(a, fixture);

  const pin = capture(a.root, env);
  const before = Date.now();
  expect(await pinVerb(["Skills", "002"], pinUsage, pin.io)).toBe(0);
  const after = Date.now();

  const line = pin.out.join("");
  expect(line).toMatch(/^pinned 002 until \S+\n$/);
  const until = line.slice("pinned 002 until ".length, -1);
  expect(pin.err).toEqual([]);

  expect(Date.parse(until)).toBeGreaterThan(before + 7 * DAY - 1_000);
  expect(Date.parse(until)).toBeLessThanOrEqual(after + 7 * DAY);

  const broke = capture(a.root, env);
  expect(await leaseBreakVerb(["Skills", "001"], breakUsage, broke.io)).toBe(1);
  expect(broke.err.join("")).toBe("lease break: no lease on Skills 001\n");
  expect(broke.out).toEqual([]);
});
