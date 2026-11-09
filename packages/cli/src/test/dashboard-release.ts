import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packDashboard } from "../release/dashboard.ts";
import { dashboardAsset, sumsAsset } from "../update/dashboard.ts";

const repo = resolve(import.meta.dir, "../../../..");
const key = (args: string) => `api ${args}`.replace(/[^A-Za-z0-9._-]/gu, "_");

export const checkoutVersion = (
  JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }
).version;

export async function dashboardRelease(root: string, version: string) {
  const dist = join(root, "dist");
  const stubs = join(root, "gh");
  const assets = join(root, "assets");
  const log = join(root, "gh.log");

  mkdirSync(dist, { recursive: true });
  mkdirSync(stubs, { recursive: true });
  writeFileSync(join(dist, "index.html"), `<p>dashboard ${version}</p>`);
  writeFileSync(log, "");

  const packed = await packDashboard(version, dist, assets);

  writeFileSync(
    join(stubs, key(`--hostname github.com repos/ryuudotgg/skills/releases/tags/v${version}`)),
    JSON.stringify({
      tag_name: `v${version}`,
      draft: false,
      prerelease: false,
      published_at: "2026-11-10T00:00:00Z",
      html_url: `https://github.com/ryuudotgg/skills/releases/tag/v${version}`,
      assets: [
        { id: 7, name: dashboardAsset(version), state: "uploaded" },
        { id: 8, name: sumsAsset, state: "uploaded" },
        { id: 9, name: sumsAsset, state: "starter" },
      ],
    }),
  );

  for (const [id, path] of [
    [7, packed.tarball],
    [8, packed.sums],
  ] as const)
    symlinkSync(
      path,
      join(
        stubs,
        key(
          `--hostname github.com --header Accept: application/octet-stream repos/ryuudotgg/skills/releases/assets/${id}`,
        ),
      ),
    );

  return {
    env: { GH_STUB_DIR: stubs, GH_STUB_LOG: log },
    stubPath: join(repo, "scripts/stubs"),
    sums: packed.sums,
    index: `<p>dashboard ${version}</p>`,
    breakSums: () => writeFileSync(packed.sums, `${"f".repeat(64)}  ${dashboardAsset(version)}\n`),
    releaseReads: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.includes("releases/tags")).length,
    calls: () => readFileSync(log, "utf8"),
  };
}
