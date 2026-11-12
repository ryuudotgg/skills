import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatus, readTailnet, tailscaleBinary } from "../hub/tailscale.ts";
import { hubTarget, HubTargetError, inviteOf } from "./hub.ts";
import { hubPeers, newHubUrl } from "./hub-tailscale.ts";

const recorded = readFileSync(join(import.meta.dir, "fixture/tailscale-status.json"), "utf8");

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fakeTailscale(script: string): string {
  const directory = mkdtempSync(join(tmpdir(), "skills-tailscale-"));
  directories.push(directory);

  const path = join(directory, "tailscale");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return directory;
}

test("offers peers named skills-hub", () => {
  const tailnet = parseStatus(recorded);

  expect(tailnet).toMatchObject({ kind: "up", name: "example.com", suffix: "tail0000.ts.net" });
  expect(hubPeers(tailnet)).toEqual([
    { host: "skills-hub", url: "https://skills-hub.tail0000.ts.net", online: true },
    { host: "skills-hub", url: "https://skills-hub-1.tail0000.ts.net", online: false },
  ]);
});

test("a new hub takes the first skills-hub name no peer holds", () => {
  expect(newHubUrl(parseStatus(recorded))).toBe("https://skills-hub-2.tail0000.ts.net");
  expect(newHubUrl({ kind: "up", name: "x", suffix: "tail1.ts.net", peers: [], taken: [] })).toBe(
    "https://skills-hub.tail1.ts.net",
  );

  expect(newHubUrl({ kind: "down", state: "Stopped" })).toBeUndefined();
});

test("a new hub skips names this machine or an expired node still holds", () => {
  const json = JSON.parse(recorded);
  const held = {
    ...json,
    Self: { ...json.Self, DNSName: "skills-hub-2.tail0000.ts.net." },
    Peer: {
      ...json.Peer,
      expired: {
        ...json.Peer["nodekey:e"],
        DNSName: "skills-hub-3.tail0000.ts.net.",
        Expired: true,
      },
    },
  };

  const tailnet = parseStatus(JSON.stringify(held));
  expect(newHubUrl(tailnet)).toBe("https://skills-hub-4.tail0000.ts.net");
  expect(hubPeers(tailnet).map((peer) => peer.url)).not.toContain(
    "https://skills-hub-3.tail0000.ts.net",
  );
});

test("a stopped or unreadable tailnet offers no peers", () => {
  const stopped = parseStatus(JSON.stringify({ ...JSON.parse(recorded), BackendState: "Stopped" }));
  expect(stopped).toEqual({ kind: "down", state: "Stopped" });
  expect(hubPeers(stopped)).toEqual([]);

  expect(parseStatus("not json")).toEqual({
    kind: "unknown",
    reason: "tailscale status printed no JSON",
  });

  const json = JSON.parse(recorded);
  const noDns = { ...json, CurrentTailnet: { ...json.CurrentTailnet, MagicDNSEnabled: false } };
  expect(parseStatus(JSON.stringify(noDns))).toMatchObject({ kind: "up", peers: [] });
});

test("reads tailscale status from the binary on PATH, stdout only", async () => {
  const fixture = join(import.meta.dir, "fixture/tailscale-status.json");
  const up = fakeTailscale(
    `echo 'Warning: client version != tailscaled server version' >&2\n/bin/cat '${fixture}'`,
  );

  expect(await readTailnet({ PATH: up })).toMatchObject({ kind: "up", name: "example.com" });

  const daemonGone = fakeTailscale(
    "echo 'failed to connect to local Tailscale daemon' >&2\nexit 1",
  );

  expect(await readTailnet({ PATH: daemonGone })).toEqual({
    kind: "down",
    state: "daemon unreachable",
  });

  const crashed = fakeTailscale("echo 'panic: something else' >&2\nexit 2");
  expect(await readTailnet({ PATH: crashed })).toEqual({
    kind: "unknown",
    reason: "tailscale status exited 2",
  });

  expect(tailscaleBinary({ PATH: "/nonexistent" }, [])).toBeUndefined();
  expect(await readTailnet({ PATH: "/nonexistent" }, [])).toEqual({ kind: "missing" });
});

test("tailscale mode takes only a MagicDNS name", () => {
  expect(hubTarget("https://hub239.tail0000.ts.net/", "tailscale")).toEqual({
    url: "https://hub239.tail0000.ts.net",
    network: "tailscale",
  });

  for (const url of [
    "https://hub.example.net",
    "https://tail0000.ts.net",
    "https://ts.net.example.net",
  ])
    expect(() => hubTarget(url, "tailscale")).toThrow(HubTargetError);

  expect(() => hubTarget("https://hub.example.net", "tailscale")).toThrow(
    "hub.example.net is not a tailnet name",
  );
});

test("a tailscale status that hangs reads as unknown after two seconds", async () => {
  const hung = fakeTailscale("exec /bin/sleep 5");
  const started = Date.now();

  expect(await readTailnet({ PATH: hung })).toEqual({
    kind: "unknown",
    reason: "tailscale status did not answer in time",
  });

  expect(Date.now() - started).toBeLessThan(4_000);
});

test("a MagicDNS name has four labels, and a trailing dot is dropped", () => {
  expect(() => hubTarget("https://a.hub.tail0000.ts.net", "tailscale")).toThrow(
    "is not a tailnet name",
  );

  const target = hubTarget("https://hub.tail0000.ts.net.", "tailscale");
  expect(target.url).toBe("https://hub.tail0000.ts.net");
  expect(inviteOf("skills hub join https://hub.tail0000.ts.net. abc", target)).toBe("abc");
});

test("with MagicDNS off no hub name is suggested", () => {
  const json = JSON.parse(recorded);
  const off = { ...json, CurrentTailnet: { ...json.CurrentTailnet, MagicDNSEnabled: false } };
  expect(newHubUrl(parseStatus(JSON.stringify(off)))).toBeUndefined();
});
