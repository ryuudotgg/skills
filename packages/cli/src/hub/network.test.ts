import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTemporary } from "../test/process.ts";
import { hubSetting } from "./network.ts";

let temporary: string;
let conf: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "skills-hub-network-"));
  conf = join(temporary, "skills.conf");
});

afterEach(async () => {
  await removeTemporary(temporary);
});

test("a repeated hub key uses its last line and the environment still wins", async () => {
  await writeFile(
    conf,
    [
      "HUB_URL=https://first.example.ts.net",
      "HUB_NETWORK=public",
      "HUB_URL=https://second.example.ts.net",
      "HUB_NETWORK=tailscale",
      "",
    ].join("\n"),
  );

  const env = { HOME: temporary, SKILLS_CONF: conf };
  expect(hubSetting(env, "HUB_URL")).toBe("https://second.example.ts.net");
  expect(hubSetting(env, "HUB_NETWORK")).toBe("tailscale");

  const overridden = { ...env, HUB_URL: "https://env.example.ts.net", HUB_NETWORK: "local" };
  expect(hubSetting(overridden, "HUB_URL")).toBe("https://env.example.ts.net");
  expect(hubSetting(overridden, "HUB_NETWORK")).toBe("local");
});
