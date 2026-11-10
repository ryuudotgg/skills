import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { leasePlan, randomId } from "skills-core";
import { updateIndex } from "../plans/commit.ts";
import {
  leasesIn,
  recordConflict,
  recordHeld,
  recordReleased,
  releaseOwn,
} from "../plans/leases.ts";
import { write } from "../plans/store.ts";
import type { HubFixture } from "../test/hub-fixture.ts";
import { runCleanup, enrolledPair, hub, sync, type Machine } from "../test/hub-machines.ts";
import {
  DOING_TTL,
  heldOf,
  hubLeases,
  iso,
  keyFor,
  openLeaser,
  removeLease,
  take,
  type Leaser,
} from "./leases.ts";
import { breakLease, leaseSession, pinPlans } from "./plan-leases.ts";

setDefaultTimeout(60_000);

afterEach(runCleanup);

function envOf(m: Machine, fixture: HubFixture): NodeJS.ProcessEnv {
  return {
    HOME: join(m.root, ".home"),
    HUB_KEYS: "file",
    HUB_URL: fixture.url,
    HUB_NETWORK: "local",
    PLANS_DIR: m.root,
    SKILLS_CONF: join(m.root, "skills.conf"),
    PATH: process.env.PATH,
  };
}

async function setStatus(m: Machine, id: string, status: string): Promise<void> {
  await updateIndex(join(m.root, "Skills", "index.tsv"), (rows) => {
    for (const row of rows) if (row.id === id) row.status = status;
  });
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

async function holder(leaser: Leaser, id: string): Promise<string | undefined> {
  return (await hubLeases(leaser.call)).get(await keyFor(leaser, "Skills", id))?.holder;
}

test("a refused provisional claim conflicts until the holder releases, then is offered afresh", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);
  await sync(b, fixture.url);

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
  expect(await holder(leaserA, "002")).toBeUndefined();

  expect((await sync(b, fixture.url)).at(-1)).toEndWith("conflicts 0");
  expect(await holder(leaserB, "002")).toBe(leaserB.device);

  const claim = leasesIn(b.store, "Skills")
    .get(leasePlan("Skills", "002"))
    ?.claims.get(leaserB.device);

  expect(claim && [claim.provisional, claim.conflict]).toEqual([false, null]);
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
  expect(await holder(leaser, "001")).toBe(leaser.device);

  await setStatus(a, "001", "TODO");
  await sync(a, fixture.url);
  expect(await holder(leaser, "001")).toBeUndefined();
  expect(leasesIn(a.store, "Skills").get(leasePlan("Skills", "001"))?.claims.size).toBe(0);
});

test("a pin taken after its lease lapsed is the one a DROPPED row releases", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  const env = envOf(a, fixture);
  const leaser = await openLeaser(a.deps, fixture.url);

  expect((await pinPlans("Skills", ["002"], "3d", env)).map((line) => line.ok)).toEqual([true]);

  const lapsed = (await hubLeases(leaser.call)).get(await keyFor(leaser, "Skills", "002"));
  if (lapsed === undefined) throw new Error("no pin taken");

  await removeLease(leaser.call, lapsed, "release");
  await Bun.sleep(5);
  expect((await pinPlans("Skills", ["002"], "3d", env)).map((line) => line.ok)).toEqual([true]);

  await setStatus(a, "002", "DROPPED");
  write(a.store, () => releaseOwn(a.store, Date.now(), "Skills", ["002"]));
  await sync(a, fixture.url);
  expect(await holder(leaser, "002")).toBeUndefined();
});

test("a break ends a hub lease whose event this machine has not pulled, and it stays ended", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  const leaserB = await openLeaser(b.deps, fixture.url);
  await takeAndRecord(b, leaserB, "001");
  await setStatus(b, "001", "DOING");

  expect(await breakLease("Skills", "001", envOf(a, fixture))).toEqual({
    ok: true,
    line: "broke lease of B",
  });

  expect(await holder(leaserB, "001")).toBeUndefined();

  await sync(a, fixture.url);
  await sync(b, fixture.url);
  expect(await holder(leaserB, "001")).toBeUndefined();
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

  expect(await holder(leaser, "001")).toBe(leaser.device);
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
  expect(await holder(leaser, "001")).toBeUndefined();
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
  expect(await holder(leaser, "001")).toBe(leaser.device);
});

test("a break clears a conflict with a holder whose lease was never recorded and has expired", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);
  await sync(b, fixture.url);

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
  expect(await holder(leaserB, "001")).toBe(leaserB.device);
});
