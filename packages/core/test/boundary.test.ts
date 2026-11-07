import { Glob, type BunPlugin } from "bun";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const core = join(import.meta.dir, "..");

type Crossings = { built: boolean; platform: string[]; outside: string[] };

async function bundleForBrowser(packageRoot: string): Promise<Crossings> {
  const source = join(packageRoot, "src");
  const platform: string[] = [];
  const outside: string[] = [];

  const watch: BunPlugin = {
    name: "core-boundary",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!/^(node|bun):/.test(args.path) && !builtinModules.includes(args.path)) return;
        platform.push(`${relative(packageRoot, args.importer)} imports ${args.path}`);
        return { path: args.path, external: true };
      });

      build.onLoad({ filter: /.*/ }, (args) => {
        if (!args.path.startsWith(source + sep)) outside.push(relative(packageRoot, args.path));
        return undefined;
      });
    },
  };

  const result = await Bun.build({
    entrypoints: [...new Glob("**/*.ts").scanSync({ cwd: source, absolute: true })],
    target: "browser",
    plugins: [watch],
    throw: false,
  });

  return { built: result.success, platform, outside };
}

test("core bundles for the browser with no node: or bun: import", async () => {
  const { built, platform } = await bundleForBrowser(core);
  expect(platform).toEqual([]);
  expect(built).toBe(true);
});

test("core imports nothing outside packages/core, so never the CLI or an app", async () => {
  const { built, outside } = await bundleForBrowser(core);
  expect(outside).toEqual([]);
  expect(built).toBe(true);
});

test("the bundle check names a platform import and a reach into the CLI or an app", async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "core-boundary-")));
  try {
    const fake = join(workspace, "packages", "core");
    mkdirSync(join(fake, "src"), { recursive: true });
    mkdirSync(join(workspace, "packages", "cli", "src"), { recursive: true });
    mkdirSync(join(workspace, "apps", "hub"), { recursive: true });

    writeFileSync(join(workspace, "packages", "cli", "src", "store.ts"), "export const cli = 1;\n");
    writeFileSync(join(workspace, "apps", "hub", "page.ts"), "export const hub = 2;\n");
    writeFileSync(
      join(fake, "src", "index.ts"),
      [
        'import { join } from "node:path";',
        'import { file } from "bun";',
        'import { cli } from "../../cli/src/store.ts";',
        'import { hub } from "../../../apps/hub/page.ts";',
        "export const all = [join, file, cli, hub];",
        "",
      ].join("\n"),
    );

    const { platform, outside } = await bundleForBrowser(fake);

    expect(platform).toEqual(["src/index.ts imports node:path", "src/index.ts imports bun"]);
    expect(outside).toEqual(["../cli/src/store.ts", "../../apps/hub/page.ts"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
