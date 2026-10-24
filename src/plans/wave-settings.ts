import { lines, type DeliveryConfig } from "../delivery.ts";

export const waveKeys = ["PLANS_WAVE_MODEL", "PLANS_WAVE_EFFORT"] as const;
export type WaveSettings = { model: string; effort: string; notes: string[] };

export function waveSettingsFrom(config: DeliveryConfig): WaveSettings {
  const result: WaveSettings = { model: "inherit", effort: "inherit", notes: [] };
  if (config.invalid) {
    result.notes.push(config.notes[0] ?? `${config.path}: invalid config, wave settings skipped`);
    return result;
  }

  if (!config.path) return result;

  for (const key of waveKeys) {
    const values = lines(config.content)
      .filter((line) => line.startsWith(`${key}=`))
      .map((line) => line.slice(key.length + 1));

    if (values.length === 0) continue;
    if (values.length > 1) {
      result.notes.push(`${config.path}: ${key} is set more than once, skipped`);
      continue;
    }

    const value = values[0]!;
    const valid = key === "PLANS_WAVE_MODEL" ? /^[^\s/]+\/\S+$/.test(value) : /^\S+$/.test(value);
    if (!valid) result.notes.push(`${config.path}: ${key}=${value} is not valid, skipped`);
    else if (key === "PLANS_WAVE_MODEL") result.model = value;
    else result.effort = value;
  }

  return result;
}
