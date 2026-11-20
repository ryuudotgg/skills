import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMNS, LOG_HEADER } from "skills-core";
import { connect, type Fetch } from "../hub/client.ts";
import { enrolled, init, invite, join as joinVault, settle, type Deps } from "../hub/enroll.ts";
import { keyStore } from "../hub/keys.ts";
import type { Clock } from "../hub/network.ts";
import { LONG_BUDGET, syncVerb } from "../hub/sync.ts";
import { appendLog } from "../plans/commit.ts";
import { importStore } from "../plans/import.ts";
import { openStore, type Store } from "../plans/store.ts";
import { startHubFixture, type HubFixture } from "./hub-fixture.ts";

export const DAY = 24 * 60 * 60 * 1000;

export const cleanup: (() => Promise<void> | void)[] = [];
export async function runCleanup(): Promise<void> {
  for (const step of cleanup.splice(0).reverse()) await step();
}

export type Machine = { root: string; store: Store; deps: Deps; lines: string[] };

function plans(root: string, files: Record<string, string>): void {
  mkdirSync(join(root, "Skills", "done"), { recursive: true });

  const rows = ["001\tone", "002\ttwo"].map((head) =>
    [head, "TODO", "P1", "S", "-", "-", "-", "2026-11-07", "-"].join("\t"),
  );

  writeFileSync(join(root, "Skills", "index.tsv"), [COLUMNS.join("\t"), ...rows, ""].join("\n"));
  writeFileSync(join(root, "log.tsv"), LOG_HEADER);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
}

export async function machine(
  files?: Record<string, string>,
  from?: string,
  fetcher?: Fetch,
): Promise<Machine> {
  const root = mkdtempSync(join(tmpdir(), "hub-sync-"));
  if (from !== undefined) cpSync(from, root, { recursive: true });
  else if (files !== undefined) plans(root, files);

  await importStore({ PLANS_DIR: root });

  const store = openStore(join(root, "plans.db"));
  const lines: string[] = [];
  const deps: Deps = {
    store,
    keys: keyStore(
      { HOME: join(root, ".home"), HUB_KEYS: "file", PATH: process.env.PATH },
      "linux",
    ),
    connect: (url, deadline, clock) =>
      connect(url, "local", fetcher ?? fetch, undefined, deadline, clock),
    now: Date.now,
    sleep: async () => {},
    out: (line) => lines.push(line),
  };

  cleanup.push(() => {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  return { root, store, deps, lines };
}

export async function hub(): Promise<HubFixture> {
  const started = await startHubFixture();
  cleanup.push(() => started.stop());
  return started;
}

export async function sync(m: Machine, url: string, publishQuarantine = false): Promise<string[]> {
  m.lines.length = 0;
  await syncVerb(m.deps, url, { budget: LONG_BUDGET, publishQuarantine, quiet: false });
  return [...m.lines];
}

export async function deletedOn(
  m: Machine,
  url: string,
  ids: readonly string[],
): Promise<string[]> {
  const current = await enrolled(m.deps, url, false);
  const body = await current.client.call("POST", "/v1/blobs/have", { ids }, current.signer);
  return (body.deleted as string[]).toSorted();
}

export async function enrolledPair(
  fixture: HubFixture,
  fetcher?: Fetch,
): Promise<{ a: Machine; b: Machine }> {
  const a = await machine({ "Skills/001-one.md": "# 001 one\n", "Skills/ctx-x.md": "# ctx\n" });
  await appendLog("Skills", "001", "start", "feat/one", { PLANS_DIR: a.root });
  await init(a.deps, fixture.url, fixture.initCode ?? "", "A");

  const b = await machine(undefined, undefined, fetcher);
  await enroll(a, b, fixture, "B");

  return { a, b };
}

export async function syncedPair(
  fixture: HubFixture,
  fetcher?: Fetch,
): Promise<{ a: Machine; b: Machine }> {
  const pair = await enrolledPair(fixture, fetcher);
  await sync(pair.a, fixture.url);
  await sync(pair.b, fixture.url);
  return pair;
}

export async function enroll(
  a: Machine,
  b: Machine,
  fixture: HubFixture,
  label: string,
): Promise<void> {
  a.lines.length = 0;
  await invite(a.deps, fixture.url, { label, lasts: DAY, wait: false });
  const line = (a.lines.at(-1) ?? "").split(" ").at(-1) ?? "";
  const settleInvites = async () =>
    void (await settle(a.deps, await enrolled(a.deps, fixture.url)));

  await joinVault({ ...b.deps, sleep: settleInvites }, fixture.url, line);
}

export type Wire = {
  slow: boolean;
  requests: number;
  aborted: number;
  hang?: string;
  hold?: { readonly path: string; readonly ms: number };
};

const LATENCY = 300;

function pause(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export function slowFetch(wire: Wire, bytesPerMs: number): typeof fetch {
  let free = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (!wire.slow) return fetch(input, init);

    wire.requests++;
    const bytes = typeof init?.body === "string" ? Buffer.byteLength(init.body) : 0;
    const start = Math.max(Date.now(), free);
    free = start + bytes / bytesPerMs;

    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const hangs = wire.hang !== undefined && path.startsWith(wire.hang);
    try {
      await pause(hangs ? 600_000 : free - Date.now() + LATENCY, init?.signal);
      return await fetch(input, init);
    } catch (error) {
      if (init?.signal?.aborted === true) wire.aborted++;
      throw error;
    }
  }) as typeof fetch;
}

let working = 0;
let stirs = 0;
let counting = false;

function stir(by: number): void {
  working += by;
  stirs++;
}

async function counted<T>(work: () => Promise<T>): Promise<T> {
  stir(1);
  try {
    return await work();
  } finally {
    stir(-1);
  }
}

// WebCrypto settles on a thread pool, tens to thousands of event loop turns later, so a lane
// sealing or signing is only visible to the pump through this count.
function countCrypto(): void {
  if (counting) return;

  counting = true;

  const subtle = Object.getPrototypeOf(crypto.subtle) as Record<string, unknown>;
  const originals = new Map<string, PropertyDescriptor>();
  for (const name of Object.getOwnPropertyNames(subtle)) {
    const descriptor = Object.getOwnPropertyDescriptor(subtle, name);
    const original = descriptor?.value as unknown;
    if (name === "constructor" || descriptor === undefined || typeof original !== "function")
      continue;

    originals.set(name, descriptor);
    subtle[name] = function (this: SubtleCrypto, ...args: unknown[]) {
      return counted(() => original.apply(this, args) as Promise<unknown>);
    };
  }

  cleanup.push(() => {
    for (const [name, descriptor] of originals) Object.defineProperty(subtle, name, descriptor);
    counting = false;
  });
}

async function quiet(): Promise<void> {
  let calm = 0;
  let seen = stirs;
  while (calm < 3) {
    await new Promise((resolve) => setImmediate(resolve));
    calm = working === 0 && seen === stirs ? calm + 1 : 0;
    seen = stirs;
  }
}

type Due = { readonly at: number; readonly order: number; readonly run: () => void };

export type Link = { readonly fetch: Fetch; readonly clock: Clock };

export function simulatedWire(wire: Wire, bytesPerMs: number): Link {
  countCrypto();

  let now = Date.now();
  let free = 0;
  const deadlines = new WeakMap<AbortSignal, number>();

  let order = 0;
  let pumping = false;
  const due: Due[] = [];
  async function pump(): Promise<void> {
    pumping = true;

    while (due.length > 0) {
      await quiet();
      due.sort((a, b) => a.at - b.at || a.order - b.order);

      const next = due.shift() as Due;
      now = Math.max(now, next.at);
      next.run();
    }

    pumping = false;
  }

  function answerAt<T>(at: number, settle: (answer: PromiseWithResolvers<T>) => void): Promise<T> {
    const answer = Promise.withResolvers<T>();
    due.push({ at, order: order++, run: () => settle(answer) });
    if (!pumping) void pump();
    return answer.promise;
  }

  const timeout = (ms: number) => {
    const signal = new AbortController().signal;
    deadlines.set(signal, now + ms);
    return signal;
  };

  const fetcher: Fetch = async (url, init) => {
    if (!wire.slow) return fetch(url, { ...init, signal: undefined });

    const deadline = init.signal ? deadlines.get(init.signal) : undefined;
    if (deadline === undefined) throw new Error(`${url} was armed off the simulated clock`);

    wire.requests++;
    const bytes = typeof init.body === "string" ? Buffer.byteLength(init.body) : 0;
    free = Math.max(now, free) + bytes / bytesPerMs;

    const { hold } = wire;
    const held = hold !== undefined && new URL(url).pathname.startsWith(hold.path);
    const finish = free + LATENCY + (held ? hold.ms : 0);
    if (held) wire.hold = undefined;

    if (finish > deadline)
      return answerAt<Response>(deadline, ({ reject }) => {
        wire.aborted++;
        reject(new DOMException("The operation timed out.", "TimeoutError"));
      });

    const response = await counted(async () => {
      const real = await fetch(url, { ...init, signal: undefined });
      const body = await real.arrayBuffer();
      const { status, statusText, headers } = real;
      return new Response(body.byteLength === 0 ? null : body, { status, statusText, headers });
    });

    return answerAt<Response>(finish, ({ resolve }) => resolve(response));
  };

  return { fetch: fetcher, clock: { now: () => now, timeout } };
}
