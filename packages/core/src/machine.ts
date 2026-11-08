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

export const CAPABILITIES = ["macos", "linux", "xcode", "android", "docker", "node"] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(word: string): word is Capability {
  return (CAPABILITIES as readonly string[]).includes(word);
}

export function needsWords(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((word) => word.trim())
        .filter(Boolean),
    ),
  ];
}

export function planNeeds(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;

  const end = lines.indexOf("---", 1);
  const front = end < 0 ? [] : lines.slice(1, end);
  const words = needsWords(
    front
      .filter((line) => line.startsWith("needs:"))
      .map((line) => line.slice("needs:".length))
      .join(","),
  );

  return words.length > 0 ? words : undefined;
}

const HOLDS: Record<Capability, (facts: Facts) => boolean> = {
  macos: (facts) => facts.os.platform === "darwin",
  linux: (facts) => facts.os.platform === "linux",
  xcode: (facts) => "version" in facts.tools.xcode,
  android: (facts) => "version" in facts.tools.android,
  docker: (facts) => "version" in facts.tools.docker,
  node: (facts) => "version" in facts.tools.node,
};

export function lacking(needs: readonly string[], facts: Facts | undefined): string[] {
  return needs.filter((word) => !facts || !isCapability(word) || !HOLDS[word](facts));
}

export function meets(needs: readonly string[], facts: Facts, project: string): boolean {
  return lacking(needs, facts).length === 0 && facts.checkouts[project] !== undefined;
}

export function toolLine(name: ToolName, tool: Tool): string {
  return `tool ${name} ${"version" in tool ? tool.version : `absent: ${tool.reason}`}`;
}
