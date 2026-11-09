import type { SettingsSources } from "../reviewers/settings.ts";

export const outgoingKeys = {
  body: { conf: "PR_BODY", git: "skills.pr-body", values: ["off", "agent"] },
  disclosure: { conf: "AGENT_DISCLOSURE", git: "skills.agent-disclosure", values: ["off", "on"] },
} as const;

type OutgoingKeys = typeof outgoingKeys;

export function outgoingSetting<Name extends keyof OutgoingKeys>(
  name: Name,
  sources: SettingsSources,
): OutgoingKeys[Name]["values"][number] {
  const key = outgoingKeys[name];
  const allowed: readonly string[] = key.values;
  const layers = [
    sources.lines
      .filter((line) => line.startsWith(`${key.conf}=`))
      .map((line) => line.slice(key.conf.length + 1)),
    sources.git.get(key.git) ?? [],
  ];

  let value: OutgoingKeys[Name]["values"][number] = key.values[0];
  for (const candidates of layers)
    if (candidates.length === 1 && allowed.includes(candidates[0]!))
      value = candidates[0] as typeof value;

  return value;
}
