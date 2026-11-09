import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { dashboardDir, installDashboard, type Fetched } from "../update/dashboard.ts";

export type Installer = (version: string, env: NodeJS.ProcessEnv) => Promise<Fetched>;

export type Build = { kind: "build"; dir: string } | { kind: "refused"; line: string };

const hasIndex = (dir: string) => existsSync(join(dir, "index.html"));
export async function resolveBuild(
  dist: string | undefined,
  version: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  install: Installer = installDashboard,
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

  const dir = dashboardDir(env, version);
  if (dir === undefined) return refused("HOME is not set");
  if (hasIndex(dir)) return { kind: "build", dir };

  const installed = await install(version, env);
  if (installed.kind === "refused") return refused(installed.reason);

  return hasIndex(dir) ? { kind: "build", dir } : refused(`no index.html in ${dir}`);
}
