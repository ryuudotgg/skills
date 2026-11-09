import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Id } from "skills-core";
import { startHub, type RunningHub } from "../../../../apps/hub/src/main.ts";

export type HubFixture = {
  readonly url: string;
  readonly dir: string;
  readonly incarnation: Id;
  readonly initCode: string | undefined;
  readonly stop: () => Promise<void>;
  readonly restart: (options?: { readonly restored?: boolean }) => Promise<void>;
};

export async function startHubFixture(
  options: { readonly dir?: string } = {},
): Promise<HubFixture> {
  const owned = options.dir === undefined;
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "skills-hub-"));
  const log = (line: string) => appendFileSync(join(dir, "hub.log"), `${line}\n`);
  const launch = (port: number) => startHub({ data: dir, listen: `127.0.0.1:${port}`, log });

  let hub: RunningHub = await launch(0);
  let stopped = false;

  return {
    get url() {
      return hub.url;
    },
    dir,
    get incarnation() {
      return hub.incarnation;
    },
    get initCode() {
      return hub.initCode;
    },
    async stop() {
      if (stopped) return;

      stopped = true;
      await hub.stop();

      if (process.env.HUB_KEEP === "1") process.stderr.write(`hub fixture kept ${dir}\n`);
      else if (owned) rmSync(dir, { recursive: true, force: true });
    },
    async restart(restart = {}) {
      await hub.stop();
      if (restart.restored === true) writeFileSync(join(dir, ".restored"), "");
      hub = await launch(hub.port);
    },
  };
}
