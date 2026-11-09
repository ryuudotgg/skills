import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkoutVersion, dashboardRelease } from "../test/dashboard-release.ts";
import { runCommand, suiteEnvironment } from "../test/process.ts";
import { dashboardAsset, expectedSum, installDashboard } from "./dashboard.ts";

const repo = resolve(import.meta.dir, "../../../..");
const cli = join(repo, "packages/cli/src/cli.ts");
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function fixture(version = "2.0.0") {
  const root = mkdtempSync(join(tmpdir(), "skills-dashboard-"));
  scratch.push(root);

  const release = await dashboardRelease(root, version);
  const env: NodeJS.ProcessEnv = {
    ...suiteEnvironment(),
    ...release.env,
    PATH: `${release.stubPath}:${process.env.PATH}`,
    HOME: root,
  };

  delete env.AGENTS_DIR;

  return { ...release, env, dashboard: join(root, ".agents/dashboard") };
}

test("reads the release, verifies the tarball and skips gh once the build is there", async () => {
  const fx = await fixture();

  expect(await installDashboard("2.0.0", fx.env)).toEqual({ kind: "installed" });
  expect(readFileSync(join(fx.dashboard, "2.0.0/index.html"), "utf8")).toBe(fx.index);
  expect(readdirSync(fx.dashboard)).toEqual(["2.0.0"]);

  const calls = fx.calls();
  expect(calls.split("\n").filter(Boolean)).toHaveLength(3);

  expect(await installDashboard("2.0.0", fx.env)).toEqual({ kind: "present" });
  expect(fx.calls()).toBe(calls);
});

test("replaces a build left without index.html and sweeps stale scratch", async () => {
  const fx = await fixture();
  mkdirSync(join(fx.dashboard, "2.0.0"), { recursive: true });
  writeFileSync(join(fx.dashboard, "2.0.0/index.js"), "partial");
  mkdirSync(join(fx.dashboard, ".fetch-old"));
  utimesSync(join(fx.dashboard, ".fetch-old"), 0, 0);

  expect(await installDashboard("2.0.0", fx.env)).toEqual({ kind: "installed" });
  expect(readdirSync(fx.dashboard)).toEqual(["2.0.0"]);
  expect(readdirSync(join(fx.dashboard, "2.0.0"))).toEqual(["index.html"]);
});

test("another process holding the install lock keeps the target until it lets go", async () => {
  const fx = await fixture();
  mkdirSync(join(fx.dashboard, "2.0.0"), { recursive: true });
  writeFileSync(join(fx.dashboard, "2.0.0/index.js"), "partial");

  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { withLock } = await import(${JSON.stringify(join(repo, "packages/cli/src/lock.ts"))});
       await withLock(${JSON.stringify(join(fx.dashboard, "../.dashboard.lock"))}, "holder", async () => {
         console.log("held");
         await Bun.sleep(3000);
       });`,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );

  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("held\n");

    let settled = false;
    const install = installDashboard("2.0.0", fx.env).finally(() => {
      settled = true;
    });

    await Bun.sleep(2000);
    expect(settled).toBe(false);
    expect(readdirSync(join(fx.dashboard, "2.0.0"))).toEqual(["index.js"]);

    expect(await install).toEqual({ kind: "installed" });
    expect(readdirSync(join(fx.dashboard, "2.0.0"))).toEqual(["index.html"]);
  } finally {
    holder.kill();
    await holder.exited;
  }
});

test("a dashboard directory it cannot write refuses instead of throwing", async () => {
  const fx = await fixture();
  mkdirSync(join(fx.dashboard, ".."), { recursive: true });
  writeFileSync(fx.dashboard, "not a directory");

  expect(await installDashboard("2.0.0", fx.env)).toMatchObject({
    kind: "refused",
    reason: expect.stringMatching(/^cannot install skills-dashboard-2\.0\.0\.tar\.gz: /),
  });
});

test("a sum mismatch leaves no byte behind", async () => {
  const fx = await fixture();
  fx.breakSums();

  expect(await installDashboard("2.0.0", fx.env)).toEqual({
    kind: "refused",
    reason: "skills-dashboard-2.0.0.tar.gz does not match its sha256 in SHA256SUMS",
  });

  expect(readdirSync(fx.dashboard)).toEqual([]);
});

test("names a release it cannot read", async () => {
  const fx = await fixture();

  expect(await installDashboard("3.0.0", fx.env)).toMatchObject({
    kind: "refused",
    reason: expect.stringMatching(/^cannot read the release of v3\.0\.0: gh stub: no fixture /),
  });
});

test("skills dash fetch installs once, then reads no release", async () => {
  const fx = await fixture(checkoutVersion);
  const fetch = () =>
    runCommand([process.execPath, "--no-env-file", cli, "dash", "fetch"], {
      cwd: repo,
      env: fx.env,
    });

  expect(await fetch()).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(readdirSync(join(fx.dashboard, checkoutVersion))).toEqual(["index.html"]);

  const calls = fx.calls();
  expect(await fetch()).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(fx.calls()).toBe(calls);
});

async function dash(env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, "dash", "--no-open"], {
    cwd: repo,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const first = await Promise.race([
    child.stdout
      .getReader()
      .read()
      .then(({ value }) => new TextDecoder().decode(value)),
    child.exited.then(() => ""),
  ]);

  if (first) {
    await Bun.sleep(200);
    child.kill("SIGTERM");
  }

  const code = await child.exited;
  const stderr = await new Response(child.stderr).text();
  return { code, url: first.trim(), stderr };
}

test("skills dash with no build fetches it once, and refuses a bad sum with one line", async () => {
  const fx = await fixture(checkoutVersion);

  const served = await dash(fx.env);
  expect(served.code).toBe(0);
  expect(served.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]{32,}$/);
  expect(readFileSync(join(fx.dashboard, checkoutVersion, "index.html"), "utf8")).toBe(fx.index);
  expect(fx.releaseReads()).toBe(1);

  rmSync(fx.dashboard, { recursive: true });
  fx.breakSums();

  const refused = await dash(fx.env);
  expect(refused).toEqual({
    code: 1,
    url: "",
    stderr: `dash: no dashboard build for ${checkoutVersion}: ${dashboardAsset(checkoutVersion)} does not match its sha256 in SHA256SUMS\n`,
  });

  expect(readdirSync(fx.dashboard)).toEqual([]);
});

test("reads sha256sum lines, binary markers included", () => {
  const sum = "A".repeat(64);
  expect(expectedSum(`${"b".repeat(64)}  other.tar.gz\n${sum} *x.tar.gz\n`, "x.tar.gz")).toBe(
    "a".repeat(64),
  );

  expect(expectedSum(`${sum}  x.tar.gz.sig\n`, "x.tar.gz")).toBeUndefined();
});
