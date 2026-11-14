import { expect, test } from "bun:test";
import {
  eventFrom,
  foldLeases,
  leaseLine,
  leaseMarks,
  leasePlan,
  leaseState,
  recordOf,
  type EventDraft,
  type LeaseHeld,
  type PlanEvent,
} from "skills-core";

let wall = 0;
function stored(draft: EventDraft): PlanEvent {
  wall += 1;
  return eventFrom({ ...recordOf(draft), id: `e${wall}`, wall, counter: 0, machine: "m" });
}

const NOW = Date.parse("2026-11-10T12:00:00Z");

const SINCE = "2026-11-10T11:00:00.000Z";
function lease(
  plan: string,
  device: string,
  extra: Partial<LeaseHeld> = {},
  project = "Fixture",
): PlanEvent {
  return stored({
    kind: "stored",
    type: "lease",
    at: NOW,
    project,
    plan,
    payload: {
      device,
      label: `${device}-label`,
      acquired: SINCE,
      expires: "2026-11-11T11:00:00.000Z",
      pinned: false,
      provisional: false,
      operation: null,
      ...extra,
    },
  });
}

function released(plan: string, device: string, by = device, acquired = SINCE): PlanEvent {
  return stored({
    kind: "stored",
    type: "lease-released",
    at: NOW,
    project: "Fixture",
    plan,
    payload: { device, acquired, by, mode: by === device ? "release" : "break" },
  });
}

function conflict(plan: string, device: string, holder: string, acquired = SINCE): PlanEvent {
  return stored({
    kind: "stored",
    type: "lease-conflict",
    at: NOW,
    project: "Fixture",
    plan,
    payload: { device, acquired, holder, holderAcquired: SINCE, holderLabel: `${holder}-label` },
  });
}

const at = (plans: ReturnType<typeof foldLeases>, plan: string) =>
  plans.get(leasePlan("Fixture", plan));

test("a lease held elsewhere marks a DOING row and a pin marks a ready row", () => {
  const plans = foldLeases([
    lease("001", "a"),
    lease("003", "a", { pinned: true, expires: "2026-11-13T12:00:00.000Z" }),
    lease("001", "c", {}, "Other"),
  ]);

  const rows = [
    { id: "001", status: "DOING" },
    { id: "003", status: "TODO" },
  ];

  expect([...leaseMarks(plans, "Fixture", rows, "b", NOW)]).toEqual([
    ["001", "on a-label"],
    ["003", "pinned by a-label"],
  ]);

  expect([...leaseMarks(plans, "Fixture", rows, "a", NOW)]).toEqual([]);
  expect(leaseLine(leaseState(at(plans, "003"), "a", NOW))).toBe(
    "held by a-label since 2026-11-10T11:00:00Z, pinned until 2026-11-13T12:00:00Z",
  );
});

test("a refused provisional claim shows as a conflict on both sides until a break", () => {
  const events = [
    lease("002", "b", { provisional: true, operation: "0".repeat(32), acquired: "early" }),
    lease("002", "a"),
    conflict("002", "b", "a", "early"),
  ];

  const before = foldLeases(events);
  expect(leaseState(at(before, "002"), "a", NOW)).toEqual({
    kind: "conflict",
    other: { device: "b", label: "b-label" },
  });

  expect(leaseState(at(before, "002"), "b", NOW)).toEqual({
    kind: "conflict",
    other: { device: "a", label: "a-label" },
  });

  const after = foldLeases([...events, released("002", "b", "a", "early")]);
  expect(leaseLine(leaseState(at(after, "002"), "b", NOW))).toBe(
    "held by a-label since 2026-11-10T11:00:00Z",
  );

  expect(at(after, "002")?.released.get("b")).toBe("early");
});

test("releasing the holder clears the conflict and spends the refused operation", () => {
  const plans = foldLeases([
    lease("002", "b", { provisional: true, operation: "0".repeat(32), acquired: "early" }),
    lease("002", "a"),
    conflict("002", "b", "a", "early"),
    released("002", "a"),
  ]);

  const claim = at(plans, "002")?.claims.get("b");
  expect(claim && [claim.provisional, claim.conflict, claim.operation]).toEqual([true, null, null]);
});

test("a release or conflict names one claim, so a newer claim survives an older release", () => {
  const plans = foldLeases([
    lease("001", "a", { acquired: "first" }),
    lease("001", "a", { acquired: "second" }),
    released("001", "a", "a", "first"),
  ]);

  expect(at(plans, "001")?.claims.get("a")?.acquired).toBe("second");
});

test("a held lease ends other held claims, outranks a provisional one, and a pin expires", () => {
  const plans = foldLeases([
    lease("001", "a"),
    lease("001", "b"),
    lease("002", "b", { provisional: true, operation: "0".repeat(32) }),
    lease("002", "a"),
    lease("003", "a", { pinned: true, expires: "2026-11-10T11:30:00.000Z" }),
  ]);

  expect([...(at(plans, "001")?.claims.keys() ?? [])]).toEqual(["b"]);
  expect(leaseLine(leaseState(at(plans, "002"), "c", NOW))).toBe(
    "held by a-label since 2026-11-10T11:00:00Z",
  );

  expect(leaseState(at(plans, "003"), "c", NOW)).toEqual({ kind: "none" });
});

test("malformed lease payloads fold to nothing", () => {
  const plans = foldLeases([
    stored({
      kind: "stored",
      type: "lease",
      at: NOW,
      project: "Fixture",
      plan: "001",
      payload: { device: "a" } as unknown as LeaseHeld,
    }),
  ]);

  expect(leaseState(at(plans, "001"), "a", NOW)).toEqual({ kind: "none" });
});

test("a release that sorts before its claim still ends it, and clears conflicts naming that device", () => {
  const plans = foldLeases([
    lease("002", "b", { provisional: true, operation: "0".repeat(32), acquired: "early" }),
    conflict("002", "b", "a", "early"),
    released("002", "a"),
    lease("002", "a"),
  ]);

  const claim = at(plans, "002")?.claims.get("b");
  expect([at(plans, "002")?.claims.has("a"), claim?.conflict]).toEqual([false, null]);
});

test("a conflict that sorts after its holder's release spends the offer but sets no conflict", () => {
  const plans = foldLeases([
    lease("002", "b", { provisional: true, operation: "0".repeat(32), acquired: "early" }),
    lease("002", "a"),
    released("002", "a"),
    conflict("002", "b", "a", "early"),
  ]);

  const claim = at(plans, "002")?.claims.get("b");
  expect(claim && [claim.conflict, claim.operation]).toEqual([null, null]);
});

test("a held lease that arrives after a newer one leaves the newer holder in place", () => {
  const plans = foldLeases([
    lease("001", "b", { acquired: "2026-11-10T11:30:00.000Z" }),
    lease("001", "a", { acquired: "2026-11-10T11:00:00.000Z" }),
  ]);

  expect([...(at(plans, "001")?.claims.keys() ?? [])]).toEqual(["b"]);
});

test("a DOING row without a pulse for 30 minutes reads stale, named by its lease holder", () => {
  const plans = foldLeases([lease("002", "a"), lease("003", "b", { provisional: true })]);
  const minutesAgo = (minutes: number, machine = "m") => ({
    at: NOW - minutes * 60_000,
    machine,
  });

  const pulses = {
    newest: new Map([
      ["001", minutesAgo(31)],
      ["002", minutesAgo(45)],
      ["003", minutesAgo(31)],
      ["004", minutesAgo(30)],
      ["005", minutesAgo(90)],
      ["006", minutesAgo(31, "unlabelled-machine")],
    ]),
    labels: new Map([["m", "m-label"]]),
  };

  const rows = [
    { id: "001", status: "DOING" },
    { id: "002", status: "DOING" },
    { id: "003", status: "DOING" },
    { id: "004", status: "DOING" },
    { id: "005", status: "REVIEW" },
    { id: "006", status: "DOING" },
    { id: "007", status: "DOING" },
  ];

  expect([...leaseMarks(plans, "Fixture", rows, "c", NOW, pulses)]).toEqual([
    ["001", "(m-label, stale 31 min)"],
    ["002", "(a-label, stale 45 min)"],
    ["003", "(b-label, stale 31 min)"],
    ["006", "(unlabell, stale 31 min)"],
  ]);

  const refused = foldLeases([
    lease("001", "b", { provisional: true, operation: "0".repeat(32), acquired: "early" }),
    lease("001", "a"),
    conflict("001", "b", "a", "early"),
  ]);

  expect(leaseMarks(refused, "Fixture", rows.slice(0, 1), "a", NOW, pulses).get("001")).toBe(
    "conflict with b-label (m-label, stale 31 min)",
  );
});

test("the lease line carries the newest heartbeat", () => {
  const plans = foldLeases([lease("001", "a")]);
  expect(leaseLine(leaseState(at(plans, "001"), "a", NOW), NOW - 60_000)).toBe(
    "held by a-label since 2026-11-10T11:00:00Z, heartbeat 2026-11-10T11:59:00Z",
  );
});
