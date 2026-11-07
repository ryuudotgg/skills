import { readDeliveryConfig, type DeliveryConfig } from "./delivery.ts";

export const fastModeProviders = ["codex", "claude"] as const;
type Provider = (typeof fastModeProviders)[number];
type FastModes = { modes: Record<Provider, boolean>; notes: string[] };

export function fastModeKey(provider: Provider): string {
  return `${provider.toUpperCase()}_FAST_MODE`;
}

export const fastModeKeys: readonly string[] = fastModeProviders.map(fastModeKey);

export function fastModesFrom(config: DeliveryConfig): FastModes {
  const result: FastModes = { modes: { codex: false, claude: false }, notes: [] };
  if (config.invalid || !config.path) return result;

  const rows = config.content.split("\n").map((line) => line.replace(/\r$/, ""));
  for (const provider of fastModeProviders) {
    const key = fastModeKey(provider);
    const values = rows
      .filter((line) => line.startsWith(`${key}=`))
      .map((line) => line.slice(key.length + 1));

    if (values.length === 0) continue;
    if (values.length > 1)
      result.notes.push(`${config.path}: ${key} is set more than once, skipped`);
    else if (values[0] === "yes" || values[0] === "no")
      result.modes[provider] = values[0] === "yes";
    else result.notes.push(`${config.path}: ${key}=${values[0]} is not yes or no, skipped`);
  }

  return result;
}

export function readFastModes(env: NodeJS.ProcessEnv): FastModes {
  return fastModesFrom(readDeliveryConfig(env));
}
