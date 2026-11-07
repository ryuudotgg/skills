import { lines, readDeliveryConfig, setSingleValue, type DeliveryConfig } from "./delivery.ts";

export const armFamilies = ["claude", "codex", "opencode"] as const;
export const armTiers = ["luna", "terra", "sol", "astra"] as const;

export type Family = (typeof armFamilies)[number];
export type Tier = (typeof armTiers)[number];
export type OpencodeModel = { model: string; variant?: string };
export type Roster = { families: Family[]; opencode: Partial<Record<Tier, OpencodeModel>> };
export type OpencodeCatalog = { model: string; variants: string[] }[];

export const implementers = ["lead", "codex", "opencode"] as const;

export type Implementer = (typeof implementers)[number];

export const rosterKey = "ARMS_ROSTER";
export const implementationKey = "ARMS_IMPLEMENTATION";
export const defaultRoster: Readonly<Roster> = { families: ["claude", "codex"], opencode: {} };
const catalogTimeout = 15_000;

export function modelValue(model: OpencodeModel): string {
  return `${model.model}${model.variant === undefined ? "" : `#${model.variant}`}`;
}

export function tierTokens(roster: Roster): string[] {
  if (!roster.families.includes("opencode")) return [];

  return armTiers.flatMap((tier) => {
    const model = roster.opencode[tier];
    return model ? [`${tier}=${modelValue(model)}`] : [];
  });
}

export function serializeRoster(roster: Roster): string {
  return [
    ...armFamilies.filter((family) => roster.families.includes(family)),
    ...tierTokens(roster),
  ].join(" ");
}

export function parseRoster(value: string): { roster: Roster; notes: string[] } {
  const roster: Roster = { families: [], opencode: {} };
  const notes: string[] = [];
  for (const token of value.split(/\s+/).filter(Boolean)) {
    if (armFamilies.includes(token as Family)) {
      const family = token as Family;
      if (roster.families.includes(family)) notes.push(`${family} is repeated, skipped`);
      else roster.families.push(family);

      continue;
    }

    const separator = token.indexOf("=");
    const tier = (separator < 0 ? "" : token.slice(0, separator)) as Tier;
    const picked = token.slice(separator + 1);

    const variantAt = picked.lastIndexOf("#");
    const model = variantAt < 0 ? picked : picked.slice(0, variantAt);
    const variant = variantAt < 0 ? undefined : picked.slice(variantAt + 1);
    const providerAt = model.indexOf("/");
    if (
      separator < 0 ||
      !armTiers.includes(tier) ||
      providerAt <= 0 ||
      providerAt === model.length - 1 ||
      model.includes("=") ||
      variant === ""
    ) {
      notes.push(`${token} is not an arm family or tier model, skipped`);
      continue;
    }

    if (roster.opencode[tier]) notes.push(`${tier} is repeated, skipped`);
    else roster.opencode[tier] = { model, ...(variant === undefined ? {} : { variant }) };
  }

  if (!roster.families.includes("opencode")) {
    for (const tier of armTiers)
      if (roster.opencode[tier]) notes.push(`${tier} requires opencode, skipped`);

    roster.opencode = {};
  } else if (!roster.opencode.sol) {
    notes.push("opencode requires a sol model, skipped");
    roster.families = roster.families.filter((family) => family !== "opencode");
    roster.opencode = {};
  }

  if (!roster.families.length) notes.push("no arm families selected");

  return { roster, notes };
}

export function parseImplementation(
  value: string,
  roster: Roster,
): { implementation: Implementer; notes: string[] } {
  if (!implementers.includes(value as Implementer))
    return {
      implementation: "lead",
      notes: [`${value || "an empty value"} is not lead, codex or opencode`],
    };

  const implementation = value as Implementer;
  if (implementation !== "lead" && !roster.families.includes(implementation))
    return {
      implementation: "lead",
      notes: [`${implementation} is not in the roster`],
    };

  return { implementation, notes: [] };
}

export function implementationFrom(config: DeliveryConfig, roster: Roster) {
  const rows = lines(config.content).filter((line) => line.startsWith(`${implementationKey}=`));
  if (!rows.length) return { implementation: "lead" as Implementer, notes: [] };

  const result = parseImplementation(rows[0]!.slice(implementationKey.length + 1).trim(), roster);
  result.notes = result.notes.map((note) => `${note}, the lead writes the code`);
  if (rows.length > 1)
    result.notes.unshift(`${implementationKey} is set more than once, first row wins`);

  return { ...result, notes: result.notes.map((note) => `${config.path}: ${note}`) };
}

export function rosterLines(content: string): string[] {
  return lines(content).filter((line) => line.startsWith(`${rosterKey}=`));
}

export function rosterFrom(config: DeliveryConfig) {
  const rows = rosterLines(config.content);
  if (!rows.length)
    return {
      roster: structuredClone(defaultRoster) as Roster,
      saved: false,
      notes: [...config.notes],
    };

  const result = parseRoster(rows[0]!.slice(rosterKey.length + 1));
  if (rows.length > 1) result.notes.unshift(`${rosterKey} is set more than once, first row wins`);

  return {
    ...result,
    saved: true,
    notes: [...config.notes, ...result.notes.map((note) => `${config.path}: ${note}`)],
  };
}

export function rewriteRoster(content: string, roster: Roster): string {
  const value = serializeRoster(roster);
  if (!rosterLines(content).length && value === serializeRoster(defaultRoster)) return content;
  return setSingleValue(content, rosterKey, value);
}

export function rosterChange(content: string, roster: Roster): string[] | undefined {
  const rows = rosterLines(rewriteRoster(content, roster));
  return rows.join("\n") === rosterLines(content).join("\n") ? undefined : rows;
}

export function readArms(env: NodeJS.ProcessEnv) {
  const config = readDeliveryConfig(env);
  const { roster, notes } = rosterFrom(config);
  const implementation = implementationFrom(config, roster);
  return {
    roster,
    implementation: implementation.implementation,
    notes: [...notes, ...implementation.notes],
  };
}

export async function readOpencodeCatalog(env: NodeJS.ProcessEnv): Promise<OpencodeCatalog> {
  const executable = Bun.which("opencode", { PATH: env.PATH ?? "" });
  if (!executable) throw new Error("opencode is not on PATH");

  const run = async (args: string[]) => {
    const command = `opencode ${args.join(" ")}`;
    const child = Bun.spawn([executable, ...args], { env, stdout: "pipe", stderr: "pipe" });
    let timer: Timer | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${command} did not finish within ${catalogTimeout / 1000}s`));
      }, catalogTimeout);
    });

    // A service opencode starts can inherit the pipes and hold them open past the child's exit.
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
      deadline,
    ]).finally(() => clearTimeout(timer));

    const reason = stderr.trim().split("\n")[0] || `exit ${code}`;
    if (code !== 0) throw new Error(`${command} failed: ${reason}`);

    return stdout;
  };

  const [listed, response] = await Promise.allSettled([
    run(["models"]),
    run(["api", "model.list"]),
  ]).then((settled) =>
    settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    }),
  );

  const models = lines(listed!)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!models.length) throw new Error("opencode models returned no models");

  let data: unknown;
  try {
    data = JSON.parse(response!);
  } catch {
    throw new Error("opencode api model.list returned invalid JSON");
  }

  if (!data || typeof data !== "object" || !("data" in data) || !Array.isArray(data.data))
    throw new Error("opencode api model.list returned no data array");

  const variants = new Map<string, string[]>();
  for (const entry of data.data) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.providerID !== "string" ||
      typeof entry.id !== "string" ||
      (entry.variants !== undefined &&
        (!Array.isArray(entry.variants) ||
          !entry.variants.every(
            (variant: unknown) =>
              variant &&
              typeof variant === "object" &&
              "id" in variant &&
              typeof variant.id === "string",
          )))
    )
      throw new Error("opencode api model.list returned an invalid model");

    variants.set(
      `${entry.providerID}/${entry.id}`,
      (entry.variants ?? []).map((variant: { id: string }) => variant.id),
    );
  }

  return [...new Set(models)].map((model) => ({ model, variants: variants.get(model) ?? [] }));
}

export function validateRoster(roster: Roster, catalog: OpencodeCatalog): void {
  for (const tier of armTiers) {
    const picked = roster.opencode[tier];
    if (!picked) continue;

    const model = catalog.find((entry) => entry.model === picked.model);
    if (!model) throw new Error(`OpenCode ${tier} model ${picked.model} is not in the catalog`);
    if (picked.variant !== undefined && !model.variants.includes(picked.variant))
      throw new Error(`OpenCode ${tier} variant ${modelValue(picked)} is not in the catalog`);
  }
}
