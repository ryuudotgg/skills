import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { appendLog } from "../plans/commit.ts";
import { cleanup, hub, machine, runCleanup } from "../test/hub-machines.ts";
import { init } from "./enroll.ts";
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
