import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import {
  Invite,
  canonicalJoin,
  decodeInvite,
  decodeRecovery,
  encodeInvite,
  encodeRecovery,
  joinMac,
  randomId,
  sign,
  signingKeys,
  wrappingKeys,
} from "skills-core";
import { openStore } from "../plans/store.ts";
import { startHubFixture, type HubFixture } from "../test/hub-fixture.ts";
import { connect } from "./client.ts";
import {
  devices,
  init,
  invite,
  join,
  recover,
  revoke,
  rotateRecovery,
  sentence,
  type Deps,
} from "./enroll.ts";
import { keyStore } from "./keys.ts";
import { LONG_BUDGET, statusVerb, syncVerb } from "./sync.ts";
import { setOutgoing } from "./vault.ts";

type Machine = { readonly deps: Deps; readonly lines: string[] };

async function sync(deps: Deps, url: string): Promise<void> {
  await syncVerb(deps, url, { budget: LONG_BUDGET, publishQuarantine: false, quiet: false });
}

async function status(deps: Deps, url: string): Promise<void> {
  await statusVerb(deps, url, "local");
}

const DAY = 24 * 60 * 60 * 1000;

setDefaultTimeout(30_000);

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function hub(): Promise<HubFixture> {
  const started = await startHubFixture();
  cleanup.push(() => started.stop());
  return started;
}

function machine(overrides: Partial<Deps> = {}): Machine {
  const home = mkdtempSync(joinPath(tmpdir(), "hub-enroll-"));
  const store = openStore(joinPath(home, "plans.db"), { fresh: true });
  cleanup.push(() => {
    store.db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const lines: string[] = [];
  const deps: Deps = {
    store,
    keys: keyStore({ HOME: home, HUB_KEYS: "file", PATH: process.env.PATH }, "linux"),
    connect: (url) => connect(url, "local"),
    now: Date.now,
    sleep: async () => {},
    out: (line) => lines.push(line),
    ...overrides,
  };

  return { deps, lines };
}

async function refusal(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    const said = sentence(error);
    if (said === undefined) throw error;
    return said;
  }

  throw new Error("the verb did not refuse");
}

async function founded(fixture: HubFixture): Promise<{ a: Machine; code: string }> {
  const a = machine();
  await init(a.deps, fixture.url, fixture.initCode ?? "", "A");
  const line = a.lines.find((text) => text.startsWith("recovery code ")) ?? "";
  return { a, code: line.slice("recovery code ".length) };
}

async function invited(a: Machine, url: string, label: string): Promise<string> {
  a.lines.length = 0;
  await invite(a.deps, url, { label, lasts: DAY, wait: false });
  return (a.lines.at(-1) ?? "").split(" ").at(-1) ?? "";
}

function joiner(a: Machine, url: string): Machine {
  return machine({ sleep: () => sync(a.deps, url) });
}

type Forged = { readonly valid?: boolean; readonly wrapping?: Uint8Array };

async function postJoin(url: string, line: string, forged: Forged = {}): Promise<void> {
  const parsed = await decodeInvite(line);
  const signing = await signingKeys();
  const request = {
    invite: parsed.id,
    device: randomId(),
    signing: signing.publicKey,
    wrapping: forged.wrapping ?? (await wrappingKeys()).publicKey,
    nonce: randomId(),
  };

  const mac = forged.valid ? await joinMac(parsed.secret, request) : new Uint8Array(32);

  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  const response = await fetch(`${url}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-skills-protocol": "1" },
    body: JSON.stringify({
      request: { ...request, signing: base64(request.signing), wrapping: base64(request.wrapping) },
      mac: base64(mac),
      signature: base64(await sign("join", signing, canonicalJoin(request))),
      expires: parsed.expires,
    }),
  });

  expect(response.status).toBe(202);
}

test("enrolls, revokes, recovers and rotates against a live hub", async () => {
  const fixture = await hub();
  const { a, code } = await founded(fixture);
  expect(a.lines.filter((line) => /^recovery code( [0-9A-Z]{4}){20}$/.test(line))).toHaveLength(1);
  expect(a.lines.at(-1)).toMatch(/^device A [0-9a-f]{32} enrolled$/);

  a.lines.length = 0;
  await status(a.deps, fixture.url);
  expect(a.lines.slice(0, 5)).toEqual([
    `hub ${fixture.url} (local)`,
    expect.stringMatching(/^device A [0-9a-f]{32}$/),
    "devices 2",
    "epoch 1",
    "chain 1 entry",
  ]);

  expect(await init(a.deps, fixture.url, fixture.initCode ?? "", "A")).toBe("reseed");

  const line = await invited(a, fixture.url, "B");
  const b = joiner(a, fixture.url);
  await join(b.deps, fixture.url, line);

  expect(b.lines.slice(0, 2)).toEqual(["vault founded by A", "device B added by A"]);
  expect(b.lines.slice(2)).toEqual([expect.stringMatching(/^head [0-9a-f]{64}$/), "enrolled"]);
  expect(await refusal(join(machine().deps, fixture.url, line))).toBe("invite consumed");

  a.lines.length = 0;
  await devices(a.deps);
  expect(a.lines).toHaveLength(3);
  expect(a.lines[1]).toMatch(/^[0-9a-f]{32} B enrolled 1\.\.1$/);

  const bId = a.lines[1]?.split(" ")[0] ?? "";
  a.lines.length = 0;
  await revoke(a.deps, fixture.url, bId);
  expect(a.lines.at(-1)).toBe("revoked B, epoch 2, cutoff 0");

  b.lines.length = 0;
  await status(b.deps, fixture.url);
  expect(b.lines.at(-1)).toBe(
    "the hub refuses this device as revoked, enroll this machine again with an invite from another machine",
  );

  const c = machine();
  await recover(c.deps, fixture.url, code, "C");
  expect(c.lines.at(-1)).toMatch(/^device C [0-9a-f]{32} enrolled$/);

  c.lines.length = 0;
  await devices(c.deps);
  expect(c.lines.find((text) => / C /.test(text))).toMatch(/ C enrolled 1\.\.2$/);

  a.lines.length = 0;
  await rotateRecovery(a.deps, fixture.url);
  expect(a.lines.at(-1)).toBe("epoch 3");
  expect(await refusal(recover(machine().deps, fixture.url, code, "D"))).toBe(
    "recovery identity revoked",
  );
});

test("a join rerun after the inviter settled it adopts the chain", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const line = await invited(a, fixture.url, "B");
  const b = machine({
    sleep: async () => {
      throw new Error("interrupted");
    },
  });

  await expect(join(b.deps, fixture.url, line)).rejects.toThrow("interrupted");
  await sync(a.deps, fixture.url);

  const rerun = { ...b.deps, sleep: async () => {} };
  await join(rerun, fixture.url, line);
  expect(b.lines.at(-1)).toBe("enrolled");
});

test("refuses a wrong or expired join MAC", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const line = await invited(a, fixture.url, "B");
  await postJoin(fixture.url, line);

  a.lines.length = 0;
  await sync(a.deps, fixture.url);
  expect(a.lines).toEqual([
    "join refused for invite B: the join request does not match its MAC",
    "pushed 0 events, 0 blobs, pulled 0 events, 0 blobs, conflicts 0",
  ]);

  const parsed = await decodeInvite(await invited(a, fixture.url, "C"));
  const later = { ...a.deps, now: () => parsed.expires + 1 };
  await postJoin(fixture.url, await encodeInvite(parsed));

  a.lines.length = 0;
  await sync(later, fixture.url);
  expect(a.lines).toContain("join refused for invite C: the invite has expired");
  expect(a.lines.filter((text) => text.includes("added"))).toEqual([]);

  a.lines.length = 0;
  await status(a.deps, fixture.url);
  expect(a.lines[4]).toBe("chain 1 entry");
});

async function tampered(line: string, change: (invite: Invite) => Invite): Promise<string> {
  return encodeInvite(change(await decodeInvite(line)));
}

test("refuses a chain off the invite's checkpoint", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const line = await tampered(await invited(a, fixture.url, "B"), (invite) => {
    const checkpoint = { ...invite.checkpoint, head: crypto.getRandomValues(new Uint8Array(32)) };
    return new Invite({ ...invite, checkpoint }, invite.secret);
  });

  const b = joiner(a, fixture.url);
  expect(await refusal(join(b.deps, fixture.url, line))).toBe(
    "the hub's chain does not extend the invite's checkpoint",
  );

  expect(b.lines).toEqual([]);
});

test("refuses a fingerprint other than the invite's", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const line = await tampered(await invited(a, fixture.url, "B"), (invite) => {
    const fingerprint = crypto.getRandomValues(new Uint8Array(16));
    return new Invite(
      { ...invite, checkpoint: { ...invite.checkpoint, fingerprint } },
      invite.secret,
    );
  });

  const b = joiner(a, fixture.url);
  expect(await refusal(join(b.deps, fixture.url, line))).toBe(
    "the hub's founding entry is not the one the invite names",
  );
});

test("recover refuses a founding entry other than the code's", async () => {
  const fixture = await hub();
  const { code } = await founded(fixture);
  const decoded = await decodeRecovery(code);
  const other = await encodeRecovery(decoded.secret, crypto.getRandomValues(new Uint8Array(16)));
  const c = machine();
  expect(await refusal(recover(c.deps, fixture.url, other, "C"))).toBe(
    "the hub's founding entry is not the one the recovery code names",
  );

  expect(c.lines).toEqual([]);
});

test("a join with a second invite enrolls as a fresh device", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const first = await invited(a, fixture.url, "B");
  const b = machine({
    sleep: async () => {
      throw new Error("interrupted");
    },
  });

  await expect(join(b.deps, fixture.url, first)).rejects.toThrow("interrupted");

  const second = await invited(a, fixture.url, "B again");
  await join({ ...b.deps, sleep: () => sync(a.deps, fixture.url) }, fixture.url, second);
  expect(b.lines.at(-1)).toBe("enrolled");
});

test("an invite rerun reprints the unexpired invite", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const first = await decodeInvite(await invited(a, fixture.url, "B"));
  const again = await decodeInvite(await invited(a, fixture.url, "B"));
  expect(again.id).toBe(first.id);
});

test("revoke refuses the device that runs it", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const own = (a.lines.at(-1) ?? "").split(" ").at(-2) ?? "";
  expect(await refusal(revoke(a.deps, fixture.url, own))).toBe(
    "revoke runs on another enrolled device, never on the one it revokes",
  );
});

test("a revoked store joins again as a new device", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const b = joiner(a, fixture.url);
  await join(b.deps, fixture.url, await invited(a, fixture.url, "B"));

  a.lines.length = 0;
  await devices(a.deps);

  const first = a.lines[1]?.split(" ")[0] ?? "";
  await revoke(a.deps, fixture.url, first);
  await join(b.deps, fixture.url, await invited(a, fixture.url, "B again"));

  const line = b.lines.at(-2) ?? "";
  expect(b.lines.at(-1)).toBe("enrolled");
  expect(line).toMatch(/^head /);

  a.lines.length = 0;
  await devices(a.deps);
  expect(a.lines.filter((text) => / enrolled /.test(text))).toHaveLength(3);
  expect(a.lines.find((text) => text.startsWith(first))).toMatch(/ revoked /);
});

test("a join rerun after expiry adopts an enrollment the inviter already made", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const line = await invited(a, fixture.url, "B");
  const parsed = await decodeInvite(line);
  const b = machine({
    sleep: async () => {
      throw new Error("interrupted");
    },
  });

  await expect(join(b.deps, fixture.url, line)).rejects.toThrow("interrupted");
  await sync(a.deps, fixture.url);

  await join({ ...b.deps, now: () => parsed.expires + 1 }, fixture.url, line);
  expect(b.lines.at(-1)).toBe("enrolled");
});

test("recover replaces a device whose keys this store lost", async () => {
  const fixture = await hub();
  const { a, code } = await founded(fixture);
  const old = (a.lines.at(-1) ?? "").split(" ").at(-2) ?? "";
  await a.deps.keys.delete(old as never);

  a.lines.length = 0;
  await recover(a.deps, fixture.url, code, "A again");
  expect(a.lines).toContain(`device ${old} has no keys here, revoke it from an enrolled device`);
  expect(a.lines.at(-1)).toMatch(/^device A again [0-9a-f]{32} enrolled$/);
});

test("recover drafts afresh over a saved entry that enrolls no device here", async () => {
  const fixture = await hub();
  const { a, code } = await founded(fixture);
  const old = (a.lines.at(-1) ?? "").split(" ").at(-2) ?? "";
  await a.deps.keys.delete(old as never);
  setOutgoing(a.deps.store, { from: 1, wire: crypto.getRandomValues(new Uint8Array(200)) });

  a.lines.length = 0;
  await recover(a.deps, fixture.url, code, "A again");
  expect(a.lines.at(-1)).toMatch(/^device A again [0-9a-f]{32} enrolled$/);
});

test("a join request that breaks a membership rule is skipped, and later ones still settle", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const own = (a.lines.at(-1) ?? "").split(" ").at(-2) ?? "";
  const keys = await a.deps.keys.read(own as never);
  if (keys === "not enrolled") throw new Error("the founder has no keys");

  await postJoin(fixture.url, await invited(a, fixture.url, "reused"), {
    valid: true,
    wrapping: keys.wrap.publicKey,
  });

  a.lines.length = 0;
  const b = joiner(a, fixture.url);
  await join(b.deps, fixture.url, await invited(a, fixture.url, "B"));
  expect(b.lines.at(-1)).toBe("enrolled");
  expect(a.lines).toContain(
    "join refused for invite reused: entry 1: an entry breaks a membership rule",
  );
});
