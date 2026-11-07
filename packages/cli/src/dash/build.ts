import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentsDir } from "../update/notice.ts";

export type Installed = { kind: "installed" } | { kind: "refused"; reason: string };

export type Installer = (version: string, target: string) => Promise<Installed>;

export type Build = { kind: "build"; dir: string } | { kind: "refused"; line: string };

export const installRelease: Installer = async (_version, target) => ({
  kind: "refused",
  reason: `not installed at ${target}`,
});

const hasIndex = (dir: string) => existsSync(join(dir, "index.html"));
export async function resolveBuild(
  dist: string | undefined,
  version: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  install: Installer = installRelease,
): Promise<Build> {
  if (dist !== undefined) {
    const dir = resolve(cwd, dist);
    return hasIndex(dir)
      ? { kind: "build", dir }
      : { kind: "refused", line: `dash: no dashboard build at ${dir}: no index.html` };
  }

  const refused = (reason: string): Build => ({
    kind: "refused",
    line: `dash: no dashboard build for ${version}: ${reason}`,
  });

  const agents = agentsDir(env);
  if (agents === undefined) return refused("HOME is not set");

  const dir = join(dirname(agents), "dashboard", version);
  if (hasIndex(dir)) return { kind: "build", dir };

  const installed = await install(version, dir);
  if (installed.kind === "refused") return refused(installed.reason);

  return hasIndex(dir) ? { kind: "build", dir } : refused(`no index.html in ${dir}`);
}
