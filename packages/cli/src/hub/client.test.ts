import { expect, test } from "bun:test";
import { randomId, signingKeys } from "skills-core";
import { connect, type Fetch } from "./client.ts";
import { Offline } from "./network.ts";

const INCARNATION = "0123456789abcdef0123456789abcdef";

const OTHER = "fedcba9876543210fedcba9876543210";

function recording(): { fetcher: Fetch; seen: { url: string; host: string | null }[] } {
  const seen: { url: string; host: string | null }[] = [];
  const fetcher: Fetch = async (url, init) => {
    seen.push({ url, host: new Headers(init.headers).get("host") });
    return Response.json(
      { min: 1, max: 1, incarnation: INCARNATION },
      { headers: { "x-skills-incarnation": INCARNATION } },
    );
  };

  return { fetcher, seen };
}

test("local http connects to the address it checked, naming the host in a header", async () => {
  const { fetcher, seen } = recording();
  const client = await connect("http://hub.home:8080", "local", fetcher, async () => ["10.0.0.5"]);
  await client.call("GET", "/v1/version", undefined, undefined);

  expect(seen.map((request) => request.url)).toEqual([
    "http://10.0.0.5:8080/v1/version",
    "http://10.0.0.5:8080/v1/version",
  ]);

  expect(seen.every((request) => request.host === "hub.home:8080")).toBe(true);
});

test("local http refuses a host that resolves outside the private ranges", async () => {
  const { fetcher } = recording();
  const refused = connect("http://hub.home:8080", "local", fetcher, async () => [
    "10.0.0.5",
    "8.8.8.8",
  ]);

  await expect(refused).rejects.toThrow(
    "HUB_NETWORK=local takes only private addresses, and hub.home is 8.8.8.8",
  );
});

test("public mode refuses plain http", async () => {
  const { fetcher } = recording();
  await expect(connect("http://10.0.0.5:8080", "public", fetcher)).rejects.toThrow(
    "HUB_NETWORK=public takes an https hub URL",
  );
});

test("a body that stalls past the deadline rejects with the client's timeout sentence", async () => {
  const stalling: Fetch = async (url, init) => {
    if (url.endsWith("/v1/version"))
      return Response.json({ min: 1, max: 1, incarnation: INCARNATION });

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"'));
        init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
      },
    });

    return new Response(body, { headers: { "x-skills-incarnation": INCARNATION } });
  };

  const client = await connect(
    "https://hub.example",
    "public",
    stalling,
    undefined,
    Date.now() + 200,
  );

  const call = client.call("GET", "/v1/events", undefined, undefined);

  await expect(call).rejects.toBeInstanceOf(Offline);
  await expect(call).rejects.toThrow(/^the hub did not answer in time$/);
});

test("local http tries the next checked address when one refuses the connection", async () => {
  const { fetcher, seen } = recording();
  const refusing: Fetch = async (url, init) => {
    if (url.startsWith("http://[::1]"))
      throw Object.assign(new TypeError("refused"), { code: "ECONNREFUSED" });

    return fetcher(url, init);
  };

  const client = await connect("http://hub.home:8080", "local", refusing, async () => [
    "::1",
    "127.0.0.1",
  ]);

  expect(String(client.incarnation)).toBe(INCARNATION);
  expect(seen.map((request) => request.url)).toEqual(["http://127.0.0.1:8080/v1/version"]);
});

test("a signed call answered without the incarnation header is parsed once and never resent", async () => {
  const signer = { device: randomId(), keys: await signingKeys() };
  const seen: string[] = [];
  let served = INCARNATION;
  let answer = (): Response =>
    new Response("Bad Gateway", { status: 502, headers: { "content-type": "text/plain" } });

  const fetcher: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    seen.push(`${init.method ?? "GET"} ${path}`);

    if (path === "/v1/version")
      return Response.json(
        { min: 1, max: 1, incarnation: served },
        { headers: { "x-skills-incarnation": served } },
      );

    return answer();
  };

  const client = await connect("https://hub.example", "public", fetcher);
  const call = client.call("POST", "/v1/leases", { plan: "001" }, signer);

  await expect(call).rejects.toBeInstanceOf(Offline);
  await expect(call).rejects.toThrow(/^the hub answered 502 with a body that is not JSON$/);
  expect(seen).toEqual(["GET /v1/version", "POST /v1/leases"]);

  seen.length = 0;
  served = OTHER;
  let refused = false;
  answer = () => {
    if (refused) return Response.json({}, { headers: { "x-skills-incarnation": OTHER } });

    refused = true;
    return Response.json(
      { reason: "incarnation", message: "stale incarnation" },
      { status: 401, headers: { "x-skills-incarnation": OTHER } },
    );
  };

  expect(await client.call("POST", "/v1/leases", { plan: "001" }, signer)).toEqual({});
  expect(seen).toEqual(["POST /v1/leases", "GET /v1/version", "POST /v1/leases"]);
  expect(String(client.incarnation)).toBe(OTHER);
});

test("a body that breaks off mid read rejects as the hub being unreachable", async () => {
  const breaking: Fetch = async (url) => {
    if (url.endsWith("/v1/version"))
      return Response.json({ min: 1, max: 1, incarnation: INCARNATION });

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"'));
        setTimeout(() => controller.error(new Error("socket reset")), 10);
      },
    });

    return new Response(body, { headers: { "x-skills-incarnation": INCARNATION } });
  };

  const client = await connect("https://hub.example", "public", breaking);
  const call = client.call("GET", "/v1/events", undefined, undefined);

  await expect(call).rejects.toBeInstanceOf(Offline);
  await expect(call).rejects.toThrow(/^the hub is unreachable: socket reset$/);
});
