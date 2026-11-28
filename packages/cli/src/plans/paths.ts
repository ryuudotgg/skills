import { realpathSync } from "node:fs";
import { dirname, sep } from "node:path";

export function plansDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLANS_DIR || `${env.HOME ?? ""}/Plans`;
}

export function logicalPath(real: string, env: NodeJS.ProcessEnv, cwd: string): string {
  const pwd = env.PWD;
  try {
    if (!pwd || realpathSync(pwd) !== realpathSync(cwd)) return real;
  } catch {
    return real;
  }

  for (let ancestor = pwd; dirname(ancestor) !== ancestor; ancestor = dirname(ancestor))
    try {
      const resolved = realpathSync(ancestor);
      if (resolved !== ancestor && (real === resolved || real.startsWith(resolved + sep)))
        return ancestor + real.slice(resolved.length);
    } catch {}

  return real;
}
