import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leasePlan, leaseTime } from "skills-core";
import { plans } from "../areas/plans.ts";
import { capture, envOf, holderOf, must, repo, scratch } from "../test/hub-checkout.ts";
import { cleanup, hub, runCleanup, syncedPair, type Machine } from "../test/hub-machines.ts";
import type { HubFixture } from "../test/hub-fixture.ts";
import { updateIndex } from "./commit.ts";
import { pinVerb } from "./lease-verbs.ts";
import { leasesIn } from "./leases.ts";
import { startVerb } from "./stack-verbs.ts";
import { projectRows } from "./store.ts";

setDefaultTimeout(120_000);

afterEach(runCleanup);

function usageOf(name: string): string {
  const verb = plans.verbs.find((entry) => entry.name.join(" ") === name);
  if (verb === undefined) throw new Error(`no verb ${name}`);
  return verb.usage;
}

const startUsage = usageOf("plans start");

const skillsRoot = join(repo, "skills");

async function setup() {
  const fixture = await hub();
  const { a, b } = await syncedPair(fixture);
  const env = envOf(a, fixture);

  const root = realpathSync(scratch("plans-start-leases-"));
  const origin = join(root, "origin.git");
  const checkout = join(root, "Skills");
  await must(["git", "init", "-q", "--bare", "-b", "main", origin], root, env);
  await must(["git", "init", "-q", "-b", "main", checkout], root, env);
  await must(
    ["git", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"],
    checkout,
    env,
  );

  await must(["git", "remote", "add", "origin", origin], checkout, env);
  await must(["git", "push", "-q", "origin", "main"], checkout, env);

  const start = async (args: readonly string[]) => {
    const { io, out, err } = capture(checkout, env);
    const code = await startVerb(args, startUsage, skillsRoot, io);
    return { code, out: out.join(""), err: err.join("") };
  };

  const git = (args: readonly string[]) => must(["git", ...args], checkout, env);
  return { fixture, a, b, env, checkout, start, git };
}

function claimOf(m: Machine, id: string) {
  const claims = leasesIn(m.store, "Skills").get(leasePlan("Skills", id))?.claims;
  const [claim] = [...(claims?.values() ?? [])];
  if (claim === undefined) throw new Error(`no claim on ${id}`);
  return claim;
}

async function pinOn(m: Machine, fixture: HubFixture, id: string): Promise<string> {
  const { io, err } = capture(m.root, envOf(m, fixture));
  expect([await pinVerb(["Skills", id], usageOf("plans pin"), io), err]).toEqual([0, []]);
  return leaseTime(claimOf(m, id).acquired);
}

function statusOf(m: Machine, id: string): string | undefined {
  return projectRows(m.store, "Skills").find((row) => row.id === id)?.status;
}

function leaseWrites(): string[] {
  const methods: string[] = [];
  const real = globalThis.fetch;
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const method = init?.method ?? "GET";
    if (new URL(String(input)).pathname.startsWith("/v1/leases/")) methods.push(method);
    return real(input, init);
  }) as typeof fetch);

  cleanup.push(() => spy.mockRestore());
  return methods;
}

test("another device's lease refuses the start before a branch is cut", async () => {
  const { fixture, a, b, start, git } = await setup();
  const since = await pinOn(b, fixture, "001");

  const index = readFileSync(join(a.root, "Skills", "index.tsv"));
  const log = readFileSync(join(a.root, "log.tsv"));

  expect(await start(["Skills", "001"])).toEqual({
    code: 1,
    out: "",
    err: `start: 001 held by B since ${since}\n`,
  });

  expect(await git(["for-each-ref", "refs/heads/feat/one"])).toBe("");
  expect(readFileSync(join(a.root, "Skills", "index.tsv"))).toEqual(index);
  expect(readFileSync(join(a.root, "log.tsv"))).toEqual(log);
});

test("an unreachable hub starts the plan under a provisional lease", async () => {
  const { fixture, a, start } = await setup();
  await fixture.stop();

  const result = await start(["Skills", "001"]);
  expect(result.code).toBe(0);
  expect(result.err).toEndWith("lease provisional, hub offline\n");

  expect(statusOf(a, "001")).toBe("DOING");
  expect(claimOf(a, "001")).toMatchObject({ label: "A", provisional: true });
});

test("a start that fails after taking its lease leaves none on the hub", async () => {
  const { fixture, a, start, git } = await setup();
  await git(["branch", "feat"]);

  const writes = leaseWrites();
  const result = await start(["Skills", "001"]);
  expect([result.code, result.out]).toEqual([1, ""]);
  expect(result.err).toEndWith("\nstack-base: cannot cut feat/one from origin/main\n");

  expect([writes[0], writes.at(-1)]).toEqual(["PUT", "DELETE"]);
  expect(await holderOf(a, fixture.url, "001")).toBeUndefined();
  expect(statusOf(a, "001")).toBe("TODO");
});

test("a batch leaves a member another device holds and starts the rest", async () => {
  const { fixture, a, b, start } = await setup();
  writeFileSync(join(a.root, "skills.conf"), "DELIVERY=prs\n");
  await updateIndex(join(a.root, "Skills", "index.tsv"), (rows) => {
    for (const row of rows) row.ctx = "ctx-x";
  });

  const since = await pinOn(b, fixture, "001");
  const result = await start(["Skills", "ctx-x"]);

  const updated = projectRows(a.store, "Skills").find((row) => row.id === "002")?.updated;
  const started = ["002", "two", "DOING", "P1", "S", "-", "ctx-x", "feat/batch-x", updated, "-"];
  expect(result).toEqual({
    code: 0,
    out: ["origin/main", started.join("\t"), `left 001 held by B since ${since}`, ""].join("\n"),
    err: "",
  });

  expect([statusOf(a, "001"), statusOf(a, "002")]).toEqual(["TODO", "DOING"]);
});
