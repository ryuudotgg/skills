import type { PlanEvent } from "./events.ts";

export const MACHINE_EVENT = "machine";

export const TOOLS = ["xcode", "android", "docker", "bun", "node", "gh"] as const;

export type ToolName = (typeof TOOLS)[number];

export type Tool = { version: string } | { absent: true; reason: string };

export type Checkout = { path: string; origin: string | null };

export type Facts = {
  label: string;
  environment: string | null;
  os: { platform: string; version: string | null };
  arch: string;
  tools: Record<ToolName, Tool>;
  checkouts: Record<string, Checkout>;
  captured: string;
};

const FACT_AGE_LIMIT = 24 * 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function nullableText(value: unknown): string | null | undefined {
  return value === null ? null : text(value);
}

function toolFrom(value: unknown): Tool | undefined {
  const fields = record(value);
  const version = text(fields?.version);
  if (version !== undefined) return { version };

  const reason = text(fields?.reason);
  return fields?.absent === true && reason !== undefined ? { absent: true, reason } : undefined;
}

function checkoutFrom(value: unknown): Checkout | undefined {
  const fields = record(value);
  const path = text(fields?.path);
  const origin = nullableText(fields?.origin);
  return path !== undefined && origin !== undefined ? { path, origin } : undefined;
}

export function factsFrom(payload: unknown): Facts | undefined {
  const fields = record(payload);
  const os = record(fields?.os);
  const tools = record(fields?.tools);
  const checkouts = record(fields?.checkouts);

  const label = text(fields?.label);
  const environment = nullableText(fields?.environment);
  const arch = text(fields?.arch);
  const captured = text(fields?.captured);

  const platform = text(os?.platform);
  const version = nullableText(os?.version);
  if (!tools || !checkouts || label === undefined || environment === undefined) return undefined;
  if (platform === undefined || version === undefined || arch === undefined) return undefined;
  if (captured === undefined || Number.isNaN(Date.parse(captured))) return undefined;

  const parsedTools: Partial<Record<ToolName, Tool>> = {};
  for (const name of TOOLS) {
    const tool = toolFrom(tools[name]);
    if (!tool) return undefined;
    parsedTools[name] = tool;
  }

  const parsedCheckouts: [string, Checkout][] = [];
  for (const [project, value] of Object.entries(checkouts)) {
    const checkout = checkoutFrom(value);
    if (!checkout) return undefined;
    parsedCheckouts.push([project, checkout]);
  }

  return {
    label,
    environment,
    os: { platform, version },
    arch,
    tools: parsedTools as Record<ToolName, Tool>,
    checkouts: Object.fromEntries(parsedCheckouts),
    captured,
  };
}

export function factsStale(facts: Facts | undefined, now: number): boolean {
  if (!facts) return true;
  const age = now - Date.parse(facts.captured);
  return !(age >= 0 && age < FACT_AGE_LIMIT);
}

function sameCheckout(left: Checkout | undefined, right: Checkout): boolean {
  return left?.path === right.path && left.origin === right.origin;
}

export function withCheckout(facts: Facts, project: string, checkout: Checkout): Facts | undefined {
  if (sameCheckout(facts.checkouts[project], checkout)) return undefined;
  return { ...facts, checkouts: { ...facts.checkouts, [project]: checkout } };
}

export function toolLine(name: ToolName, tool: Tool): string {
  return `tool ${name} ${"version" in tool ? tool.version : `absent: ${tool.reason}`}`;
}

export function machineLabels(events: Iterable<PlanEvent>): Map<string, string> {
  const labels = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "stored" || event.type !== MACHINE_EVENT) continue;
    const label = text(record(event.payload)?.label);
    if (label !== undefined) labels.set(event.machine, label);
  }

  return labels;
}

export function machineLabel(labels: ReadonlyMap<string, string>, machine: string): string {
  return labels.get(machine) ?? machine.slice(0, 8);
}
