import { isAbsolute, relative, sep } from "node:path";

export const PLAN_FILE = /^\d{3}-.*\.md$/;
export const CTX_FILE = /^ctx-.*\.md$/;

export function plansDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLANS_DIR || `${env.HOME ?? ""}/Plans`;
}

export function isCopyKey(stored: string): boolean {
  const parts = stored.split(sep);
  const [project = "", folder = "", name = ""] = parts;
  if (!project || project.startsWith(".") || isAbsolute(stored)) return false;
  if (parts.length === 2) return PLAN_FILE.test(folder) || CTX_FILE.test(folder);

  return parts.length === 3 && folder === "done" && PLAN_FILE.test(name);
}

export function workingCopyKey(root: string, path: string): string | undefined {
  const stored = relative(root, path);
  return isCopyKey(stored) ? stored : undefined;
}
