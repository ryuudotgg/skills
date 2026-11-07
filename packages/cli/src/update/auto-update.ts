import { lines, setSingleValue } from "../delivery.ts";

export const autoUpdateKey = "AUTO_UPDATE";
export const autoUpdateValues = ["off", "notify", "on"] as const;

export type AutoUpdate = (typeof autoUpdateValues)[number];
export type AutoUpdateReading =
  | { kind: "set"; value: AutoUpdate }
  | { kind: "unset" }
  | { kind: "invalid"; value: string };

export function isAutoUpdate(value: string): value is AutoUpdate {
  return (autoUpdateValues as readonly string[]).includes(value);
}

function autoUpdateLines(content: string): string[] {
  return lines(content).filter((line) => line.startsWith(`${autoUpdateKey}=`));
}

export function readAutoUpdate(content: string): AutoUpdateReading {
  const value = autoUpdateLines(content)
    .at(-1)
    ?.slice(autoUpdateKey.length + 1);

  if (value === undefined) return { kind: "unset" };
  return isAutoUpdate(value) ? { kind: "set", value } : { kind: "invalid", value };
}

export function setAutoUpdate(content: string, value: AutoUpdate): string {
  return setSingleValue(content, autoUpdateKey, value);
}

export function autoUpdateChange(content: string, value?: AutoUpdate): string[] | undefined {
  if (value === undefined) return undefined;
  const rows = autoUpdateLines(setAutoUpdate(content, value));
  return rows.join("\n") === autoUpdateLines(content).join("\n") ? undefined : rows;
}

export function autoUpdateFlag(value: string): AutoUpdate {
  if (!isAutoUpdate(value))
    throw new Error(`install.sh: --auto-update ${value} is not off, notify or on`);

  return value;
}

export function autoUpdateNote(config: { content: string; invalid: boolean }): string | undefined {
  const reading = readAutoUpdate(config.content);
  if (config.invalid || reading.kind === "set") return undefined;

  const state =
    reading.kind === "unset"
      ? `${autoUpdateKey} is unset`
      : `${autoUpdateKey}=${reading.value} is not off, notify or on`;

  return `${state}, so skills never updates itself; run ./install.sh with no flags at a terminal with CI unset to choose, or pass --auto-update off|notify|on`;
}
