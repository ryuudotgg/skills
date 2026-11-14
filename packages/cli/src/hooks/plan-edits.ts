import { resolve } from "node:path";
import { plansDir, workingCopyKey } from "../plans/paths.ts";
import { parsePayload } from "./payload.ts";

export async function recordPlanEdits(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    const root = resolve(plansDir(env));
    const keys = new Set(
      parsePayload(payload).paths.flatMap((path) => workingCopyKey(root, resolve(path)) ?? []),
    );

    if (keys.size === 0) return;

    const { recordCopies } = await import("./plan-edits-store.ts");
    recordCopies(root, [...keys]);
  } catch {}
}
