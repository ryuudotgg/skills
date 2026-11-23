import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as joinPath } from "node:path";
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
import { tryLock, withLock } from "../lock.ts";
import { openStore } from "../plans/store.ts";
import { startHubFixture, type HubFixture } from "../test/hub-fixture.ts";
import { connect } from "./client.ts";
import {
  devices,
  enrolled,
  init,
  invite,
  join,
  recover,
  revoke,
  rotateRecovery,
  sentence,
  settle,
  type Deps,
} from "./enroll.ts";
import { keyStore } from "./keys.ts";
import { Offline } from "./network.ts";
import { LONG_BUDGET, shortSync, statusVerb, syncVerb } from "./sync.ts";
import {
  adopt,
  readLocal,
  readOutgoing,
  readPending,
  setOutgoing,
  setPending,
  verifiedLocal,
} from "./vault.ts";

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

test("an invite long past expiry is pruned", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const parsed = await decodeInvite(await invited(a, fixture.url, "B"));
  const paths: string[] = [];
  const recording = async (target: string, init: RequestInit) => {
    paths.push(new URL(target).pathname);
    return fetch(target, init);
  };

  const later = {
    ...a.deps,
    now: () => parsed.expires + 6 * 60 * 1000,
    connect: (url: string) => connect(url, "local", recording),
  };

  await sync(later, fixture.url);
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.filter((path) => path.endsWith("/v1/pending"))).toEqual([]);
  expect(a.deps.store.db.query("SELECT count(*) AS n FROM invites").get()).toEqual({ n: 0 });
  expect(a.deps.store.db.query("SELECT key FROM meta WHERE key LIKE 'invite:%'").all()).toEqual([]);
});

test("readLocal reads one snapshot", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const home = mkdtempSync(joinPath(tmpdir(), "hub-snapshot-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));

  const path = joinPath(home, "plans.db");
  a.deps.store.db.run("VACUUM INTO ?", [path]);

  await join(joiner(a, fixture.url).deps, fixture.url, await invited(a, fixture.url, "B"));
  const longer = readLocal(a.deps.store);
  const membership = await verifiedLocal(longer);
  if (membership === undefined) throw new Error("A holds no chain");

  const first = openStore(path, { drain: false });
  cleanup.push(() => first.db.close());

  const second = openStore(path, { drain: false });
  cleanup.push(() => second.db.close());

  const query = first.db.query.bind(first.db);
  first.db.query = ((sql: string) => {
    if (sql.includes("FROM membership")) adopt(second, longer.wires, membership);
    return query(sql);
  }) as typeof first.db.query;

  const read = await verifiedLocal(readLocal(first));
  expect(read?.checkpoint.length).toBe(1);
  expect(readLocal(second).checkpoint?.length).toBe(2);
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

function cutPost(path: string, before: "request" | "answer") {
  return async (target: string, init: RequestInit): Promise<Response> => {
    const cut = init.method === "POST" && new URL(target).pathname.endsWith(path);
    if (cut && before === "request")
      throw new TypeError("the connection dropped before the request");

    const response = await fetch(target, init);
    if (cut) throw new TypeError("the connection dropped before the answer");

    return response;
  };
}

function cutOff(m: Machine, path: string, before: "request" | "answer"): Deps {
  return { ...m.deps, connect: (url) => connect(url, "local", cutPost(path, before)) };
}

async function listed(m: Machine, id: string): Promise<string | undefined> {
  m.lines.length = 0;
  await devices(m.deps);
  return m.lines.find((line) => line.startsWith(`${id} `));
}

test("a rerun prints the label the chain holds", async () => {
  const fixture = await hub();
  const { a, code } = await founded(fixture);
  const own = readLocal(a.deps.store).device ?? "";

  a.lines.length = 0;
  await recover(a.deps, fixture.url, code, "Other");
  expect(a.lines.at(-1)).toBe(`device A ${own} enrolled`);
  expect(await listed(a, own)).toStartWith(`${own} A enrolled `);

  const second = await hub();
  const b = machine();
  const founding = init(cutOff(b, "/v1/vault", "answer"), second.url, second.initCode ?? "", "A");
  await expect(founding).rejects.toThrow(Offline);

  b.lines.length = 0;
  await init(b.deps, second.url, second.initCode ?? "", "Other");
  const founder = readLocal(b.deps.store).device ?? "";
  expect(b.lines.at(-1)).toBe(`device A ${founder} enrolled`);
  expect(await listed(b, founder)).toStartWith(`${founder} A enrolled `);

  const c = machine();
  const recovering = recover(cutOff(c, "/v1/recover", "request"), fixture.url, code, "A again");
  await expect(recovering).rejects.toThrow(Offline);

  await recover(c.deps, fixture.url, code, "Third");
  const recovered = readLocal(c.deps.store).device ?? "";
  expect(c.lines.at(-1)).toBe(`device A again ${recovered} enrolled`);
  expect(await listed(c, recovered)).toStartWith(`${recovered} A again enrolled `);
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

const cli = joinPath(import.meta.dir, "../cli.ts");

function cliEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(joinPath(tmpdir(), "hub-cli-"));
  mkdirSync(joinPath(home, "Plans"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  return { HOME: home, HUB_KEYS: "file", HUB_NETWORK: "local", PATH: process.env.PATH };
}

type Terminal = {
  readonly output: () => string;
  readonly prompted: (prompt: string) => Promise<void>;
  readonly type: (keys: string) => void;
  readonly exited: Promise<number>;
};

function atTerminal(args: readonly string[], env: NodeJS.ProcessEnv): Terminal {
  const decoder = new TextDecoder();
  let output = "";
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, "hub", ...args], {
    cwd: env.HOME,
    env,
    terminal: {
      data: (_, data) => {
        output += decoder.decode(data, { stream: true });
      },
    },
  });

  cleanup.push(() => {
    child.kill();
    child.terminal?.close();
  });

  return {
    output: () => output,
    async prompted(prompt) {
      for (const started = Date.now(); !output.includes(prompt); await Bun.sleep(10))
        if (Date.now() - started > 15_000) throw new Error(`no prompt in: ${output}`);
    },
    type: (keys) => child.terminal?.write(keys),
    exited: child.exited,
  };
}

async function piped(args: readonly string[], env: NodeJS.ProcessEnv, stdin?: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, "hub", ...args], {
    cwd: env.HOME,
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code, output: stdout + stderr };
}

const INIT_PROMPT = "the hub's init code: ";

const RECOVER_PROMPT = "the recovery code: ";

const CANCELS = [
  { keys: "\r", code: 1 },
  { keys: "\x04", code: 1 },
  { keys: "\x03", code: 130 },
  { keys: "\x1b[A\x03", code: 130 },
];

test("prompt: init and recover read a typed code at a terminal without echoing it", async () => {
  const fixture = await hub();
  const initCode = fixture.initCode ?? "";

  const founder = atTerminal(["init", fixture.url, "--label", "A"], cliEnv());
  await founder.prompted(INIT_PROMPT);
  founder.type("\x1b");
  await Bun.sleep(50);
  founder.type(`[D${initCode}\x1bOC\r`);

  expect(await founder.exited).toBe(0);
  expect(founder.output()).toMatch(/device A [0-9a-f]{32} enrolled/);
  expect(founder.output()).not.toContain(initCode);

  const recovery = /recovery code ((?:[0-9A-Z]{4} ?){20})/.exec(founder.output())?.[1] ?? "";
  expect(recovery).not.toBe("");

  const recovered = atTerminal(["recover", fixture.url, "--label", "B"], cliEnv());
  await recovered.prompted(RECOVER_PROMPT);
  recovered.type(`${recovery}\r`);

  expect(await recovered.exited).toBe(0);
  expect(recovered.output()).toMatch(/device B [0-9a-f]{32} enrolled/);
  expect(recovered.output()).not.toContain(recovery);
});

test("prompt: an empty line, EOF or Ctrl-C at the init prompt founds no vault", async () => {
  const fixture = await hub();
  for (const cancel of CANCELS) {
    const session = atTerminal(["init", fixture.url, "--label", "A"], cliEnv());
    await session.prompted(INIT_PROMPT);
    session.type(cancel.keys);
    expect(await session.exited).toBe(cancel.code);
    if (cancel.code === 1) expect(session.output()).toContain("--code");
  }

  const { a } = await founded(fixture);
  expect(a.lines.at(-1)).toMatch(/^device A [0-9a-f]{32} enrolled$/);
});

test("prompt: an empty line, EOF or Ctrl-C at the recover prompt enrolls no device", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);

  for (const cancel of CANCELS) {
    const session = atTerminal(["recover", fixture.url, "--label", "B"], cliEnv());
    await session.prompted(RECOVER_PROMPT);
    session.type(cancel.keys);
    expect(await session.exited).toBe(cancel.code);
    if (cancel.code === 1) expect(session.output()).toContain("pipe");
  }

  a.lines.length = 0;
  await status(a.deps, fixture.url);
  expect(a.lines).toContain("devices 2");
});

test("piped: init takes the code from stdin or --code, and recover from stdin, with no prompt", async () => {
  const stdinHub = await hub();
  const fromStdin = await piped(
    ["init", stdinHub.url, "--label", "A"],
    cliEnv(),
    stdinHub.initCode,
  );

  expect(fromStdin.code).toBe(0);
  expect(fromStdin.output).toMatch(/device A [0-9a-f]{32} enrolled/);
  expect(fromStdin.output).not.toContain(INIT_PROMPT);

  const flagHub = await hub();
  const fromFlag = await piped(
    ["init", flagHub.url, "--label", "A", "--code", flagHub.initCode ?? ""],
    cliEnv(),
  );

  expect(fromFlag.code).toBe(0);
  expect(fromFlag.output).toMatch(/device A [0-9a-f]{32} enrolled/);
  expect(fromFlag.output).not.toContain(INIT_PROMPT);

  const recoveryHub = await hub();
  const { code: recovery } = await founded(recoveryHub);

  const recovered = await piped(["recover", recoveryHub.url, "--label", "B"], cliEnv(), recovery);
  expect(recovered.code).toBe(0);
  expect(recovered.output).toMatch(/device B [0-9a-f]{32} enrolled/);
  expect(recovered.output).not.toContain(RECOVER_PROMPT);
});

function hubLock(m: Machine): string {
  return joinPath(dirname(m.deps.store.db.filename), "hub.lock");
}

type Waiting = { readonly deps: Deps; readonly b: Machine; readonly joined: () => Promise<void> };

function joinText(a: Machine): string {
  const line = a.lines.find((text) => text.startsWith("skills hub join "));
  return line?.split(" ").at(-1) ?? "";
}

type Joiner = { readonly b: Machine; readonly posted: Promise<void>; readonly poll: () => void };

function postingJoiner(): Joiner {
  const posted = Promise.withResolvers<void>();
  const polling = Promise.withResolvers<void>();
  const b = machine({
    sleep: async () => {
      posted.resolve();
      await polling.promise;
      await Bun.sleep(10);
    },
  });

  return { b, posted: posted.promise, poll: polling.resolve };
}

function waitingInvite(a: Machine, url: string, step: () => Promise<void>): Waiting {
  const { b, posted, poll } = postingJoiner();
  let joining: Promise<void> | undefined;
  const deps: Deps = {
    ...a.deps,
    sleep: async () => {
      joining ??= join(b.deps, url, joinText(a));
      await posted;
      await step();
      await Bun.sleep(10);
    },
  };

  const joined = () => {
    poll();
    return joining ?? Promise.reject(new Error("B never joined"));
  };

  return { deps, b, joined };
}

test("a waiting invite frees hub.lock", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  let locked = 0;
  const waiting = waitingInvite(a, fixture.url, () =>
    withLock(hubLock(a), "hub.lock", () => void locked++, 100),
  );

  expect(await invite(waiting.deps, fixture.url, { label: "B", lasts: DAY, wait: true })).toBe(0);
  await waiting.joined();

  expect(locked).toBeGreaterThan(0);
  expect(waiting.b.lines.at(-1)).toBe("enrolled");
});

function envOf(m: Machine, url: string): NodeJS.ProcessEnv {
  const home = dirname(m.deps.store.db.filename);
  return {
    PATH: process.env.PATH,
    HOME: home,
    HUB_KEYS: "file",
    HUB_NETWORK: "local",
    HUB_URL: url,
    PLANS_DIR: home,
    SKILLS_CONF: joinPath(home, "skills.conf"),
  };
}

test("a quiet sync runs while an invite waits", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const env = envOf(a, fixture.url);
  const kinds: string[] = [];
  const waiting = waitingInvite(a, fixture.url, async () => {
    kinds.push((await shortSync(env)).kind);
  });

  expect(await invite(waiting.deps, fixture.url, { label: "B", lasts: DAY, wait: true })).toBe(0);
  await waiting.joined();

  expect(kinds.length).toBeGreaterThan(0);
  expect(new Set(kinds)).toEqual(new Set(["synced"]));
  expect(waiting.b.lines.at(-1)).toBe("enrolled");
});

test("a waiting invite skips a round while hub.lock is held", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);

  let release = () => {};
  let holder: ReturnType<typeof tryLock<void>> | undefined;
  const chain: number[] = [];
  const waiting = waitingInvite(a, fixture.url, async () => {
    if (holder === undefined) {
      const { promise, resolve } = Promise.withResolvers<void>();
      release = resolve;
      holder = tryLock(hubLock(a), () => promise);
      return;
    }

    chain.push(readLocal(a.deps.store).wires.length);
    release();
  });

  expect(await invite(waiting.deps, fixture.url, { label: "B", lasts: DAY, wait: true })).toBe(0);
  await waiting.joined();

  expect(await holder).toEqual({ held: false, value: undefined });
  expect(chain[0]).toBe(1);
  expect(readLocal(a.deps.store).wires).toHaveLength(2);
  expect(waiting.b.lines.at(-1)).toBe("enrolled");
});

test("a waiting invite signs on the chain a sync extended between rounds", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const { b, posted, poll } = postingJoiner();
  const c = joiner(a, fixture.url);

  let joining: Promise<void> | undefined;
  const deps: Deps = {
    ...a.deps,
    sleep: async () => {
      if (joining === undefined) {
        const forB = joinText(a);
        await join(c.deps, fixture.url, await invited(a, fixture.url, "C"));
        joining = join(b.deps, fixture.url, forB);
      }

      await posted;
    },
  };

  expect(await invite(deps, fixture.url, { label: "B", lasts: DAY, wait: true })).toBe(0);
  poll();
  await joining;

  expect(readLocal(a.deps.store).wires).toHaveLength(3);
  expect(b.lines.slice(0, 3)).toEqual([
    "vault founded by A",
    "device C added by A",
    "device B added by A",
  ]);

  expect(b.lines.at(-1)).toBe("enrolled");
});

test("an expired invite leaves a join a sync settled under hub.lock alone", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);

  let now = Date.now();
  let joining: Promise<void> | undefined;
  let sync: ReturnType<typeof tryLock<void>> | undefined;
  const { b, posted, poll } = postingJoiner();
  const deps: Deps = {
    ...a.deps,
    now: () => now,
    sleep: async () => {
      if (joining !== undefined) return Bun.sleep(10);

      joining = join(b.deps, fixture.url, joinText(a));
      await posted;

      const { promise, resolve } = Promise.withResolvers<void>();
      sync = tryLock(hubLock(a), async () => {
        resolve();
        now += DAY;
        await settle(a.deps, await enrolled(a.deps, fixture.url));
      });

      await promise;
    },
  };

  expect(await invite(deps, fixture.url, { label: "B", lasts: 60_000, wait: true })).toBe(0);
  expect(await sync).toEqual({ held: false, value: undefined });

  poll();
  await joining;

  expect(a.lines).not.toContain("invite expired");
  expect(b.lines.at(-1)).toBe("enrolled");
});

test("an expired invite waiting on hub.lock drops itself without the hub", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);

  let now = Date.now();
  let release = () => {};
  let holder: ReturnType<typeof tryLock<void>> | undefined;
  const deps: Deps = {
    ...a.deps,
    now: () => now,
    sleep: async () => {
      if (holder === undefined) {
        const { promise, resolve } = Promise.withResolvers<void>();
        release = resolve;
        holder = tryLock(hubLock(a), () => promise);
        now += DAY;
        return;
      }

      await fixture.stop();
      release();
      await holder;
    },
  };

  expect(await invite(deps, fixture.url, { label: "B", lasts: 60_000, wait: true })).toBe(1);
  expect(a.lines.at(-1)).toBe("invite expired");
  expect(a.deps.store.db.query("SELECT COUNT(*) AS n FROM invites").get()).toEqual({ n: 0 });
});

test("a waiting invite whose expired row another invite swept reports it expired", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);

  let now = Date.now();
  let swept = false;
  const deps: Deps = {
    ...a.deps,
    now: () => now,
    sleep: async () => {
      if (swept) return;

      swept = true;
      now += DAY;
      await invite(deps, fixture.url, { label: "C", lasts: DAY, wait: false });
    },
  };

  expect(await invite(deps, fixture.url, { label: "B", lasts: 60_000, wait: true })).toBe(1);
  expect(a.lines.at(-1)).toBe("invite expired");
});

test("an invite started under a held hub.lock refuses", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const deps: Deps = {
    ...a.deps,
    sleep: () => Promise.reject(new Error("the invite waited under a held hub.lock")),
  };

  const held = await tryLock(hubLock(a), () =>
    refusal(invite(deps, fixture.url, { label: "B", lasts: DAY, wait: true })),
  );

  expect(held).toEqual({
    held: false,
    value: "another skills hub verb is changing this store, run this once it ends",
  });

  expect(a.deps.store.db.query("SELECT COUNT(*) AS n FROM invites").get()).toEqual({ n: 0 });
});

const LOST_ROTATION =
  "a recovery rotation landed without its code being shown, run skills hub recovery rotate again";

function isMembershipPost(target: string, init: RequestInit): boolean {
  return init.method === "POST" && new URL(target).pathname.endsWith("/v1/membership");
}

async function dropMembershipAnswer(target: string, init: RequestInit): Promise<Response> {
  const response = await fetch(target, init);

  if (isMembershipPost(target, init))
    throw new TypeError("the connection dropped before the answer");

  return response;
}

async function dropMembershipRequest(target: string, init: RequestInit): Promise<Response> {
  if (isMembershipPost(target, init))
    throw new TypeError("the connection dropped before the request");

  return fetch(target, init);
}

async function cutOffRotation(
  fixture: HubFixture,
  fetcher = dropMembershipAnswer,
): Promise<Machine> {
  const { a } = await founded(fixture);
  const cutOff = { ...a.deps, connect: (url: string) => connect(url, "local", fetcher) };

  await expect(rotateRecovery(cutOff, fixture.url)).rejects.toThrow(Offline);
  return a;
}

function pendingRows(m: Machine): unknown[] {
  return m.deps.store.db
    .query("SELECT key FROM meta WHERE key IN ('outgoing', 'lost_rotation') ORDER BY key")
    .all();
}

test("a quiet sync keeps the lost rotation notice", async () => {
  const fixture = await hub();
  const a = await cutOffRotation(fixture);
  expect((await shortSync(envOf(a, fixture.url))).kind).toBe("synced");
  expect(pendingRows(a)).toEqual([{ key: "lost_rotation" }]);

  a.lines.length = 0;
  await sync(a.deps, fixture.url);
  expect(a.lines.filter((line) => line === LOST_ROTATION)).toHaveLength(1);

  a.lines.length = 0;
  await sync(a.deps, fixture.url);
  expect(a.lines).not.toContain(LOST_ROTATION);
});

test("a loud run reports a lost rotation at once", async () => {
  const fixture = await hub();
  const a = await cutOffRotation(fixture);

  a.lines.length = 0;
  await sync(a.deps, fixture.url);
  expect(a.lines.filter((line) => line === LOST_ROTATION)).toHaveLength(1);
  expect(a.lines.indexOf(LOST_ROTATION)).toBeLessThan(
    a.lines.findIndex((line) => line.startsWith("pushed ")),
  );

  expect(pendingRows(a)).toEqual([]);
});

test("a quiet resend of a rotation keeps the lost rotation notice", async () => {
  const fixture = await hub();
  const a = await cutOffRotation(fixture, dropMembershipRequest);
  const saved = readOutgoing(a.deps.store);
  expect(saved).toBeDefined();
  expect(readLocal(a.deps.store).wires).toHaveLength(saved?.from ?? -1);

  expect((await shortSync(envOf(a, fixture.url))).kind).toBe("synced");
  expect(readLocal(a.deps.store).wires[saved?.from ?? -1]).toEqual(saved?.wire);
  expect(pendingRows(a)).toEqual([{ key: "lost_rotation" }]);

  a.lines.length = 0;
  await sync(a.deps, fixture.url);
  expect(a.lines.filter((line) => line === LOST_ROTATION)).toHaveLength(1);
  expect(pendingRows(a)).toEqual([]);
});

test("a join whose store changed while it waited", async () => {
  const fixture = await hub();
  const { a, code } = await founded(fixture);

  let recovered: ReturnType<typeof readLocal> | undefined;
  const b = machine({
    sleep: async () => {
      if (recovered !== undefined) return;

      await sync(a.deps, fixture.url);
      await recover(b.deps, fixture.url, code, "B");
      recovered = readLocal(b.deps.store);
    },
  });

  expect(await refusal(join(b.deps, fixture.url, await invited(a, fixture.url, "B")))).toBe(
    "this store is already enrolled",
  );

  expect(recovered).toBeDefined();
  expect(readLocal(b.deps.store)).toEqual(recovered as ReturnType<typeof readLocal>);

  let replaced: ReturnType<typeof readPending>;
  const c = machine({
    sleep: async () => {
      if (replaced !== undefined) return;

      const pending = readPending(c.deps.store);
      if (pending === undefined) throw new Error("the join recorded no pending request");

      replaced = { ...pending, invite: randomId() };
      setPending(c.deps.store, replaced);
      await sync(a.deps, fixture.url);
    },
  });

  expect(await refusal(join(c.deps, fixture.url, await invited(a, fixture.url, "C")))).toBe(
    "another skills hub verb is changing this store, run this once it ends",
  );

  expect(readLocal(c.deps.store).checkpoint).toBeUndefined();
  expect(readPending(c.deps.store)).toEqual(replaced);
});

async function settledAcross(loud: boolean): Promise<{ code: number; lines: string[] }> {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const { b, posted, poll } = postingJoiner();
  const settler: Deps = loud ? a.deps : { ...a.deps, quiet: true };
  const gate = Promise.withResolvers<void>();

  let joining: Promise<void> | undefined;
  let holder: ReturnType<typeof tryLock<void>> | undefined;
  const deps: Deps = {
    ...a.deps,
    sleep: async () => {
      if (holder !== undefined) {
        gate.resolve();
        await holder;
        return;
      }

      joining = join(b.deps, fixture.url, joinText(a));
      await posted;

      const settled = Promise.withResolvers<void>();
      holder = tryLock(hubLock(a), async () => {
        await settle(settler, await enrolled(settler, fixture.url));
        settled.resolve();
        await gate.promise;
      });

      await settled.promise;
    },
  };

  a.lines.length = 0;
  const code = await invite(deps, fixture.url, { label: "B", lasts: DAY, wait: true });
  gate.resolve();
  expect(await holder).toEqual({ held: false, value: undefined });

  poll();
  await joining;
  expect(b.lines.at(-1)).toBe("enrolled");

  return { code, lines: a.lines };
}

test("prints the entry a quiet sync settled", async () => {
  for (const loud of [false, true]) {
    const { code, lines } = await settledAcross(loud);
    expect(code).toBe(0);
    expect(lines.filter((line) => line === "device B added by A")).toHaveLength(1);
  }
});

test("a join whose store recovered before approval says it is enrolled", async () => {
  const fixture = await hub();
  const { a, code } = await founded(fixture);

  let recovered: ReturnType<typeof readLocal> | undefined;
  const b = machine({
    sleep: async () => {
      if (recovered !== undefined) return;
      await recover(b.deps, fixture.url, code, "B");
      recovered = readLocal(b.deps.store);
    },
  });

  expect(await refusal(join(b.deps, fixture.url, await invited(a, fixture.url, "B")))).toBe(
    "this store is already enrolled",
  );

  expect(recovered).toBeDefined();
  expect(readLocal(b.deps.store)).toEqual(recovered as ReturnType<typeof readLocal>);
});

test("a waiting invite a quiet sync settled during its sleep needs no hub", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const { b, posted, poll } = postingJoiner();
  const quiet: Deps = { ...a.deps, quiet: true };

  let joining: Promise<void> | undefined;
  const deps: Deps = {
    ...a.deps,
    sleep: async () => {
      if (joining !== undefined) return;

      joining = join(b.deps, fixture.url, joinText(a)).catch(() => {});
      await posted;
      await tryLock(hubLock(a), async () => settle(quiet, await enrolled(quiet, fixture.url)));
      await fixture.stop();
    },
  };

  a.lines.length = 0;
  expect(await invite(deps, fixture.url, { label: "B", lasts: DAY, wait: true })).toBe(0);
  expect(a.lines.filter((line) => line === "device B added by A")).toHaveLength(1);

  poll();
  await joining;
});

test("a quiet sync answers joining while a revoked store joins again", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const first = joiner(a, fixture.url);
  await join(first.deps, fixture.url, await invited(a, fixture.url, "B"));

  a.lines.length = 0;
  await devices(a.deps);
  await revoke(a.deps, fixture.url, a.lines[1]?.split(" ")[0] ?? "");

  const answers: unknown[] = [];
  const again = {
    ...first.deps,
    sleep: async () => {
      if (answers.length === 0) answers.push(await shortSync(envOf(first, fixture.url)));
      await sync(a.deps, fixture.url);
    },
  };

  await join(again, fixture.url, await invited(a, fixture.url, "B again"));

  const device = readLocal(first.deps.store).device;
  expect(answers).toEqual([{ kind: "offline", reason: `joining as device ${device}` }]);
  expect(first.lines.at(-1)).toBe("enrolled");
});

test("a quiet sync runs on an enrolled store a join left a pending row on", async () => {
  const fixture = await hub();
  const { a } = await founded(fixture);
  const b = joiner(a, fixture.url);
  await join(b.deps, fixture.url, await invited(a, fixture.url, "B"));

  const device = readLocal(b.deps.store).device;
  if (device === undefined) throw new Error("the join left no device");

  setPending(b.deps.store, { invite: randomId(), device, nonce: randomId() });
  expect((await shortSync(envOf(b, fixture.url))).kind).toBe("synced");
});
