import type { Host } from "skills-core";
import type { RuleId } from "./guards.ts";
import { object } from "./payload.ts";

export type Blocked = { reason: string; rules: RuleId[] };

const HOOK_BUSY_MS = 100;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function hostOf(payload: Record<string, unknown>): Host {
  if (payload.host === "opencode") return "opencode";

  const input = object(payload.tool_input);
  if (
    payload.tool_name === "apply_patch" ||
    typeof payload.turn_id === "string" ||
    Array.isArray(input?.command) ||
    /(?:^|\/)\.codex\//.test(text(payload.transcript_path))
  )
    return "codex";

  return "claude";
}

export async function recordBlock(
  blocked: Blocked,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    const { recordEvent } = await import("../plans/record.ts");
    const cwd = text(payload.cwd) || process.cwd();
    await recordEvent(
      "hook-block",
      { rules: [...new Set(blocked.rules)], host: hostOf(payload) },
      { cwd },
      env,
      HOOK_BUSY_MS,
    );
  } catch {}
}
