import { afterEach, expect, setDefaultTimeout, setSystemTime, spyOn, test } from "bun:test";
import { join } from "node:path";
import { LEASE_CONFLICT, leasePlan, randomId } from "skills-core";
import { updateIndex } from "../plans/commit.ts";
import {
  leasesIn,
  recordConflict,
  recordHeld,
  recordReleased,
  releaseOwn,
} from "../plans/leases.ts";
import { leaseEvents, write } from "../plans/store.ts";
import { envOf, holderOf } from "../test/hub-checkout.ts";
import {
  cleanup,
  runCleanup,
  enrolledPair,
  hub,
  sync,
  syncedPair,
  type Machine,
} from "../test/hub-machines.ts";
import {
  DOING_TTL,
  heldLine,
  heldOf,
  hubLeases,
  iso,
  keyFor,
  openLeaser,
  removeLease,
  take,
  type Leaser,
} from "./leases.ts";
import type { Fetch } from "./client.ts";
import { breakLease, leaseSession, pinPlans } from "./plan-leases.ts";
import { LONG_BUDGET, syncOnce } from "./sync.ts";

setDefaultTimeout(60_000);

afterEach(runCleanup);

afterEach(() => {
  setSystemTime();
});

async function setStatus(m: Machine, id: string, status: string): Promise<void> {
  await updateIndex(join(m.root, "Skills", "index.tsv"), (rows) => {
    for (const row of rows) if (row.id === id) row.status = status;
  });
}

type Seen = { method: string; path: string };

function onHubRequest(hook: (seen: Seen, answer: () => Promise<Response>) => Promise<Response>) {
  const real = globalThis.fetch;
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const seen = { method: init?.method ?? "GET", path: new URL(String(input)).pathname };
    return hook(seen, () => real(input, init));
  }) as typeof fetch);

  cleanup.push(() => spy.mockRestore());
}

async function takeAndRecord(m: Machine, leaser: Leaser, id: string): Promise<void> {
  const taken = await take(leaser, await keyFor(leaser, "Skills", id), {
    ttl: DOING_TTL,
    pinned: false,
  });

  if (taken.kind !== "taken") throw new Error(`${id} is held by ${taken.holder}`);

  const held = heldOf(taken.lease, await leaser.label(leaser.device));
  write(m.store, () => recordHeld(m.store, Date.now(), "Skills", id, held));
}

test("a refused provisional claim conflicts until the holder releases, then is offered afresh", async () => {
  const fixture = await hub();
  const { a, b } = await syncedPair(fixture);

  const leaserA = await openLeaser(a.deps, fixture.url);
  const leaserB = await openLeaser(b.deps, fixture.url);
  const now = Date.now();
  write(b.store, () =>
    recordHeld(b.store, now, "Skills", "002", {
      device: leaserB.device,
      label: "B",
      acquired: iso(now),
      expires: iso(now + DOING_TTL),
      pinned: false,
      provisional: true,
      operation: randomId(),
    }),
  );

  await setStatus(b, "002", "DOING");
  await takeAndRecord(a, leaserA, "002");
  await setStatus(a, "002", "DOING");
  await sync(a, fixture.url);

  const lines = await sync(b, fixture.url);
  expect(lines).toContain(
    "conflict Skills 002 lease held by A, run skills plans lease break Skills 002",
  );

  expect(lines.at(-1)).toEndWith("conflicts 1");

  write(a.store, () => releaseOwn(a.store, Date.now(), "Skills", ["002"]));
  await sync(a, fixture.url);
  expect(await holderOf(a, fixture.url, "002")).toBeUndefined();

  expect((await sync(b, fixture.url)).at(-1)).toEndWith("conflicts 0");
  expect(await holderOf(b, fixture.url, "002")).toBe(leaserB.device);

  const claim = leasesIn(b.store, "Skills")
    .get(leasePlan("Skills", "002"))
    ?.claims.get(leaserB.device);

  expect(claim && [claim.provisional, claim.conflict]).toEqual([false, null]);
});

test("a lease conflict a quiet sync recorded is printed by every loud sync until the holder releases", async () => {
  const fixture = await hub();
  let refuseLeases = false;
  const fetcher: Fetch = async (url, init) => {
    if (refuseLeases && new URL(url).pathname === "/v1/leases")
      return Response.json({ reason: "busy", message: "leases are busy" }, { status: 503 });

    return fetch(url, init);
  };

  const { a, b } = await syncedPair(fixture, fetcher);

  const leaserA = await openLeaser(a.deps, fixture.url);
  const leaserB = await openLeaser(b.deps, fixture.url);
  const now = Date.now();
  write(b.store, () =>
    recordHeld(b.store, now, "Skills", "002", {
      device: leaserB.device,
      label: "B",
      acquired: iso(now),
      expires: iso(now + DOING_TTL),
      pinned: false,
      provisional: true,
      operation: randomId(),
    }),
  );

  await setStatus(b, "002", "DOING");
  await takeAndRecord(a, leaserA, "002");
  await setStatus(a, "002", "DOING");
  await sync(a, fixture.url);

  const conflictEvents = () =>
    leaseEvents(b.store, { project: "Skills", plan: "002" }).filter(
      (event) => event.type === LEASE_CONFLICT,
    ).length;

  b.lines.length = 0;
  await syncOnce(b.deps, fixture.url, {
    budget: LONG_BUDGET,
    publishQuarantine: false,
    quiet: true,
  });

  expect(b.lines).toEqual([]);
  expect(conflictEvents()).toBe(1);

  for (const refused of [false, true]) {
    refuseLeases = refused;
    const lines = await sync(b, fixture.url);
    refuseLeases = false;
    expect(lines).toContain(
      "conflict Skills 002 lease held by A, run skills plans lease break Skills 002",
    );

    expect(lines.at(-1)).toEndWith("conflicts 1");
    expect(conflictEvents()).toBe(1);
  }

  write(a.store, () => releaseOwn(a.store, Date.now(), "Skills", ["002"]));
  await sync(a, fixture.url);

  const lines = await sync(b, fixture.url);
  expect(lines.filter((line) => line.startsWith("conflict "))).toEqual([]);
  expect(lines.at(-1)).toEndWith("conflicts 0");
  expect(conflictEvents()).toBe(1);
});

test("a lapsed DOING lease is taken again, and a lease whose row left DOING is released", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  const leaser = await openLeaser(a.deps, fixture.url);

  await takeAndRecord(a, leaser, "001");
  await setStatus(a, "001", "DOING");

  const lapsed = (await hubLeases(leaser.call)).get(await keyFor(leaser, "Skills", "001"));
  if (lapsed === undefined) throw new Error("no lease taken");

  await removeLease(leaser.call, lapsed, "release");
  await sync(a, fixture.url);
  expect(await holderOf(a, fixture.url, "001")).toBe(leaser.device);

  await setStatus(a, "001", "TODO");
  await sync(a, fixture.url);
  expect(await holderOf(a, fixture.url, "001")).toBeUndefined();
  expect(leasesIn(a.store, "Skills").get(leasePlan("Skills", "001"))?.claims.size).toBe(0);
});

test("a pin taken after its lease lapsed is the one a DROPPED row releases", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  const env = envOf(a, fixture);

  expect((await pinPlans("Skills", ["002"], "3d", env)).map((line) => line.ok)).toEqual([true]);

  const leaser = await openLeaser(a.deps, fixture.url);
  const lapsed = (await hubLeases(leaser.call)).get(await keyFor(leaser, "Skills", "002"));
  if (lapsed === undefined) throw new Error("no pin taken");

  await removeLease(leaser.call, lapsed, "release");
  await Bun.sleep(5);
  expect((await pinPlans("Skills", ["002"], "3d", env)).map((line) => line.ok)).toEqual([true]);

  await setStatus(a, "002", "DROPPED");
  write(a.store, () => releaseOwn(a.store, Date.now(), "Skills", ["002"]));
  await sync(a, fixture.url);
  expect(await holderOf(a, fixture.url, "002")).toBeUndefined();
});

test("a break ends a hub lease whose event this machine has not pulled, and it stays ended", async () => {
  const fixture = await hub();
  const { a, b } = await syncedPair(fixture);

  const leaserB = await openLeaser(b.deps, fixture.url);
  await takeAndRecord(b, leaserB, "001");
  await setStatus(b, "001", "DOING");

  expect(await breakLease("Skills", "001", envOf(a, fixture))).toEqual({
    ok: true,
    line: "broke lease of B",
  });

  expect(await holderOf(b, fixture.url, "001")).toBeUndefined();

  await sync(a, fixture.url);
  await sync(b, fixture.url);
  expect(await holderOf(b, fixture.url, "001")).toBeUndefined();
  expect(leasesIn(b.store, "Skills").get(leasePlan("Skills", "001"))?.claims.size).toBe(0);
});

test("a restart after a handback the hub never heard of takes a new lease that sync keeps", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  const leaser = await openLeaser(a.deps, fixture.url);

  await takeAndRecord(a, leaser, "001");
  await setStatus(a, "001", "DOING");
  write(a.store, () => releaseOwn(a.store, Date.now(), "Skills", ["001"]));
  await Bun.sleep(5);

  const session = await leaseSession(envOf(a, fixture));
  const started = await session.start("Skills", "001");
  session.close();
  if (started.kind !== "taken") throw new Error(`start took ${started.kind}`);

  write(a.store, () => recordHeld(a.store, Date.now(), "Skills", "001", started.held));
  await sync(a, fixture.url);

  expect(await holderOf(a, fixture.url, "001")).toBe(leaser.device);
  expect(
    leasesIn(a.store, "Skills").get(leasePlan("Skills", "001"))?.claims.get(leaser.device)
      ?.acquired,
  ).toBe(started.held.acquired);
});

test("sync adopts a replacement lease whose local record was lost, so a handback releases it", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  const leaser = await openLeaser(a.deps, fixture.url);

  await takeAndRecord(a, leaser, "001");
  await setStatus(a, "001", "DOING");

  const key = await keyFor(leaser, "Skills", "001");
  const first = (await hubLeases(leaser.call)).get(key);
  if (first === undefined) throw new Error("no lease taken");

  await removeLease(leaser.call, first, "release");
  await Bun.sleep(5);

  const replaced = await take(leaser, key, { ttl: DOING_TTL, pinned: false });
  if (replaced.kind !== "taken") throw new Error("no replacement taken");

  await sync(a, fixture.url);
  const claim = leasesIn(a.store, "Skills")
    .get(leasePlan("Skills", "001"))
    ?.claims.get(leaser.device);

  expect(claim?.acquired).toBe(iso(replaced.lease.acquired));

  write(a.store, () => releaseOwn(a.store, Date.now(), "Skills", ["001"]));
  await sync(a, fixture.url);
  expect(await holderOf(a, fixture.url, "001")).toBeUndefined();
});

test("an offer whose replayed answer names an ended lease takes a fresh one", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  const leaser = await openLeaser(a.deps, fixture.url);
  const key = await keyFor(leaser, "Skills", "001");

  const operation = randomId();
  const lost = await take(leaser, key, { ttl: DOING_TTL, pinned: false, operation });
  if (lost.kind !== "taken") throw new Error("no lease taken");

  const now = Date.now();
  write(a.store, () => {
    recordHeld(a.store, now, "Skills", "001", {
      device: leaser.device,
      label: "A",
      acquired: iso(now + 1),
      expires: iso(now + DOING_TTL),
      pinned: false,
      provisional: true,
      operation,
    });

    recordReleased(a.store, now, "Skills", "001", {
      device: leaser.device,
      acquired: iso(lost.lease.acquired),
      by: "someone",
      mode: "break",
    });
  });

  await removeLease(leaser.call, lost.lease, "break");
  await setStatus(a, "001", "DOING");
  await sync(a, fixture.url);

  const claim = leasesIn(a.store, "Skills")
    .get(leasePlan("Skills", "001"))
    ?.claims.get(leaser.device);

  expect(claim?.provisional).toBe(false);
  expect(await holderOf(a, fixture.url, "001")).toBe(leaser.device);
});

test("a break clears a conflict with a holder whose lease was never recorded and has expired", async () => {
  const fixture = await hub();
  const { a, b } = await syncedPair(fixture);

  const leaserA = await openLeaser(a.deps, fixture.url);
  const leaserB = await openLeaser(b.deps, fixture.url);
  const now = Date.now();
  const acquired = iso(now);
  write(b.store, () => {
    recordHeld(b.store, now, "Skills", "001", {
      device: leaserB.device,
      label: "B",
      acquired,
      expires: iso(now + DOING_TTL),
      pinned: false,
      provisional: true,
      operation: randomId(),
    });

    recordConflict(b.store, now, "Skills", "001", {
      device: leaserB.device,
      acquired,
      holder: leaserA.device,
      holderAcquired: iso(now - 1_000),
      holderLabel: "A",
    });
  });

  await setStatus(b, "001", "DOING");
  expect(await breakLease("Skills", "001", envOf(b, fixture))).toEqual({
    ok: true,
    line: "broke lease of A",
  });

  await sync(b, fixture.url);
  expect(await holderOf(b, fixture.url, "001")).toBe(leaserB.device);
});

test("a start whose device keys are missing records a provisional claim instead of none", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);

  const session = await leaseSession({ ...envOf(a, fixture), HOME: join(a.root, ".nokeys") });
  const started = await session.start("Skills", "001");
  session.close();

  expect(started.kind === "provisional" && [started.offline, started.held.provisional]).toEqual([
    false,
    true,
  ]);
});

test("a lease session that outlives its budget still sees the hub", async () => {
  const fixture = await hub();
  const { a, b } = await syncedPair(fixture);

  const leaserB = await openLeaser(b.deps, fixture.url);
  const taken = await take(leaserB, await keyFor(leaserB, "Skills", "001"), {
    ttl: DOING_TTL,
    pinned: false,
  });

  if (taken.kind !== "taken") throw new Error("B took no lease");

  const line = heldLine("B", iso(taken.lease.acquired));
  const opened = Date.now();
  setSystemTime(opened);
  const session = await leaseSession(envOf(a, fixture), 200);
  setSystemTime(opened + 300);

  const held = await session.held("Skills", ["001", "002"]);
  const refused = await session.start("Skills", "001");
  setSystemTime(opened + 600);

  const free = await session.start("Skills", "002");
  session.close();

  expect([...held]).toEqual([["001", line]]);
  expect(refused).toEqual({ kind: "refused", reason: line });
  expect(free.kind).toBe("taken");
});

test("a lease session whose hub stopped after its budget starts provisional", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  await sync(a, fixture.url);

  const opened = Date.now();
  setSystemTime(opened);
  const session = await leaseSession(envOf(a, fixture), 200);
  await fixture.stop();
  setSystemTime(opened + 300);

  const started = await session.start("Skills", "002");
  session.close();

  expect(started.kind === "provisional" && started.offline).toBe(true);
});

test("pins every id past one budget", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  const env = envOf(a, fixture);

  const opened = Date.now();
  setSystemTime(opened);
  onHubRequest(async (seen, answer) => {
    const response = await answer();
    if (seen.method === "PUT" && seen.path.startsWith("/v1/leases/")) setSystemTime(opened + 300);
    return response;
  });

  const lines = await pinPlans("Skills", ["001", "002"], "3d", env, 200);

  const leaser = await openLeaser(a.deps, fixture.url);
  const leases = await hubLeases(leaser.call);
  const holders = await Promise.all(
    ["001", "002"].map(async (id) => leases.get(await keyFor(leaser, "Skills", id))?.holder),
  );

  expect(lines.map((line) => [line.id, line.ok])).toEqual([
    ["001", true],
    ["002", true],
  ]);

  for (const line of lines) expect(line.line).toStartWith(`pinned ${line.id} until `);
  expect(holders).toEqual([leaser.device, leaser.device]);
});

test("a lease call whose deadline falls inside it asks the hub once more", async () => {
  const fixture = await hub();
  const { a, b } = await syncedPair(fixture);

  const leaserB = await openLeaser(b.deps, fixture.url);
  const taken = await take(leaserB, await keyFor(leaserB, "Skills", "001"), {
    ttl: DOING_TTL,
    pinned: false,
  });

  if (taken.kind !== "taken") throw new Error("B took no lease");

  const line = heldLine("B", iso(taken.lease.acquired));
  let now = Date.now();
  setSystemTime(now);

  let late: "answered" | "stalled" | undefined = "answered";
  onHubRequest(async (seen, answer) => {
    const mode = seen.method === "GET" && seen.path === "/v1/leases" ? late : undefined;
    if (mode === undefined) return answer();

    late = undefined;
    const response = mode === "answered" ? await answer() : undefined;

    now += 300;
    setSystemTime(now);
    if (response === undefined) throw new DOMException("The operation timed out.", "TimeoutError");
    return response;
  });

  const session = await leaseSession(envOf(a, fixture), 200);
  const started = await session.start("Skills", "002");
  const refused = await session.start("Skills", "001");

  late = "stalled";
  const held = await session.held("Skills", ["001"]);
  late = undefined;
  session.close();

  const leaserA = await openLeaser(a.deps, fixture.url);
  const lease = (await hubLeases(leaserA.call)).get(await keyFor(leaserA, "Skills", "002"));

  expect(started.kind === "taken" && started.held.acquired).toBe(iso(lease?.acquired ?? 0));
  expect(lease?.holder).toBe(leaserA.device);
  expect(refused).toEqual({ kind: "refused", reason: line });
  expect([...held]).toEqual([["001", line]]);
});

test("a start whose landed PUT lost its answer replays it, and abandon releases that lease", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);

  let now = Date.now();
  setSystemTime(now);

  let lost = true;
  onHubRequest(async (seen, answer) => {
    if (!lost || seen.method !== "PUT" || !seen.path.startsWith("/v1/leases/")) return answer();

    lost = false;
    await answer();

    now += 300;
    setSystemTime(now);
    throw new DOMException("The operation timed out.", "TimeoutError");
  });

  const session = await leaseSession(envOf(a, fixture), 200);
  const started = await session.start("Skills", "002");
  await session.abandon();
  session.close();

  expect([started.kind, lost]).toEqual(["taken", false]);
  expect(await holderOf(a, fixture.url, "002")).toBeUndefined();
});
