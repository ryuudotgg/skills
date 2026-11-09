import { expect, test } from "bun:test";
import { connect, type Fetch } from "./client.ts";

const INCARNATION = "0123456789abcdef0123456789abcdef";

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
