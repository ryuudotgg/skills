import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { withLock } from "../lock.ts";
import { appendLog } from "../plans/commit.ts";
import { DAY, cleanup, hub, machine, runCleanup, type Machine } from "../test/hub-machines.ts";
import { enrolled, init, invite, settle } from "./enroll.ts";
import { shortSync } from "./sync.ts";
import { readPending } from "./vault.ts";
import { hubVerb } from "./verbs.ts";

afterEach(runCleanup);

function stallingProxy(upstream: string): string {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname, search } = new URL(request.url);
      if (pathname === "/v1/version") return fetch(`${upstream}${pathname}${search}`);

      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"'));
        },
      });

      return new Response(body, { headers: { "content-type": "application/json" } });
    },
  });

  cleanup.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

test("hub status prints the client's timeout sentence when a body stalls past the deadline", async () => {
  const fixture = await hub();
  const a = await machine({ "Skills/001-one.md": "# 001 one\n" });
  await appendLog("Skills", "001", "start", "feat/one", { PLANS_DIR: a.root });
  await init(a.deps, fixture.url, fixture.initCode ?? "", "A");

  const out: string[] = [];
  const err: string[] = [];
  const code = await hubVerb("status", [], "skills hub status", {
    cwd: a.root,
    env: {
      PATH: process.env.PATH,
      HOME: join(a.root, ".home"),
      HUB_KEYS: "file",
      HUB_NETWORK: "local",
      HUB_URL: stallingProxy(fixture.url),
      PLANS_DIR: a.root,
      SKILLS_CONF: join(a.root, "skills.conf"),
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    capture: true,
  });

  expect(err).toEqual([]);
  expect(out.at(-1)).toBe("offline: the hub did not answer in time\n");
  expect(out.join("")).not.toContain("operation");
  expect(code).toBe(0);
});

function envOf(m: Machine, url: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(m.root, ".home"),
    HUB_KEYS: "file",
    HUB_NETWORK: "local",
    HUB_URL: url,
    PLANS_DIR: m.root,
    SKILLS_CONF: join(m.root, "skills.conf"),
  };
}

async function requested(a: Machine, url: string): Promise<void> {
  const current = await enrolled(a.deps, url, false);
  for (let tries = 0; tries < 500; tries++) {
    const body = await current.client.call("GET", "/v1/pending", undefined, current.signer);
    if ((body.requests as unknown[]).length > 0) return;
    await Bun.sleep(10);
  }

  throw new Error("the join never reached the hub");
}

test("a waiting join frees hub.lock", async () => {
  const fixture = await hub();
  const a = await machine({ "Skills/001-one.md": "# 001 one\n" });
  await init(a.deps, fixture.url, fixture.initCode ?? "", "A");
  await invite(a.deps, fixture.url, { label: "B", lasts: DAY, wait: false });
  const line = (a.lines.at(-1) ?? "").split(" ").at(-1) ?? "";

  const b = await machine();
  const env = envOf(b, fixture.url);
  const out: string[] = [];
  const err: string[] = [];
  const joining = hubVerb("join", [fixture.url, line], "skills hub join <url> <invite>", {
    cwd: b.root,
    env,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    capture: true,
  });

  await requested(a, fixture.url);

  let locked = false;
  await withLock(join(b.root, "hub.lock"), "hub.lock", () => void (locked = true), 100);
  expect(locked).toBe(true);

  const device = readPending(b.store)?.device;
  expect(device).toBeDefined();
  expect(await shortSync(env)).toEqual({ kind: "offline", reason: `joining as device ${device}` });

  await settle(a.deps, await enrolled(a.deps, fixture.url));

  expect(await joining).toBe(0);
  expect(err).toEqual([]);
  expect(out.at(-1)).toBe("enrolled\n");
});
