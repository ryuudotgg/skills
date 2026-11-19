import type { SettingsSources } from "../reviewers/settings.ts";

export const outgoingKeys = {
  body: { conf: "PR_BODY", git: "skills.pr-body", values: ["off", "agent"] },
  disclosure: { conf: "AGENT_DISCLOSURE", git: "skills.agent-disclosure", values: ["off", "on"] },
} as const;

type OutgoingKeys = typeof outgoingKeys;

export function outgoingSetting<Name extends keyof OutgoingKeys>(
  name: Name,
  sources: SettingsSources,
): { value: OutgoingKeys[Name]["values"][number]; notes: string[] } {
  const key = outgoingKeys[name];
  const allowed: readonly string[] = key.values;
  const layers: [string, string[]][] = [
    [
      `${sources.conf}: ${key.conf}`,
      sources.lines
        .filter((line) => line.startsWith(`${key.conf}=`))
        .map((line) => line.slice(key.conf.length + 1)),
    ],
    [`git config ${key.git}`, sources.git.get(key.git) ?? []],
  ];

  let value: OutgoingKeys[Name]["values"][number] = key.values[0];
  const notes: string[] = [];
  for (const [source, candidates] of layers) {
    if (candidates.length === 0) continue;

    if (candidates.length > 1) {
      notes.push(`${source} is set more than once, skipped`);
      continue;
    }

    const candidate = candidates[0]!;
    if (allowed.includes(candidate)) value = candidate as typeof value;
    else notes.push(`${source}=${candidate} is not valid, skipped`);
  }

  return { value, notes };
}
