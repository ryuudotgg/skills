import { setting } from "./claude.ts";
import { childPath, note, object, parseTimestamp, recentFiles, recordsFromFile } from "./jsonl.ts";
import type { Notes } from "./jsonl.ts";

export type CodexRun = {
  model: string;
  effort: string;
  startedAt: number;
  endedAt: number;
  originator: string;
};

export function readCodexRuns(home: string, cutoffMicros: number, notes: Notes): CodexRun[] {
  const root = childPath(home, ".codex/sessions");
  const runs: CodexRun[] = [];

  let mixed = 0;
  for (const path of recentFiles([root, "*", "*", "*", "rollout-*.jsonl"], cutoffMicros, notes)) {
    let startedAt: number | null = null;
    let endedAt: number | null = null;
    const models = new Set<string>();
    const efforts = new Set<string>();

    let originator = "unknown";
    for (const record of recordsFromFile(path, notes)) {
      const timestamp = parseTimestamp(record.timestamp);
      if (timestamp !== null) {
        startedAt = startedAt === null ? timestamp : Math.min(startedAt, timestamp);
        endedAt = endedAt === null ? timestamp : Math.max(endedAt, timestamp);
      }

      const payload = record.payload;
      if (!object(payload)) continue;

      if (record.type === "turn_context") {
        const model = payload.model;
        let effort = payload.effort;
        const collaborationMode = payload.collaboration_mode;
        if ((typeof effort !== "string" || !effort) && object(collaborationMode) && object(collaborationMode.settings))
          effort = collaborationMode.settings.reasoning_effort;

        if (typeof model === "string" && model) models.add(model);
        if (typeof effort === "string" && effort) efforts.add(effort);
      }

      if (record.type === "session_meta" && typeof payload.originator === "string" && payload.originator)
        originator = payload.originator;
    }

    if (startedAt === null || endedAt === null || startedAt < cutoffMicros) continue;
    if (models.size > 1 || efforts.size > 1) mixed++;
    runs.push({ model: setting(models), effort: setting(efforts), startedAt, endedAt, originator });
  }

  if (mixed) note(notes, `${mixed} rollout(s) changed model or effort mid run and are grouped as mixed`);

  return runs;
}
