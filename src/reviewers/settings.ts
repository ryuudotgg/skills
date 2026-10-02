import { deliveryFrom, readDeliveryConfig, type DeliveryConfig } from "../delivery.ts";
import type { CommandOutput, Dependencies, ReadRunner } from "../round/types.ts";
import { matchesSetting, readDeclarations, reviewerName, type Declaration } from "./declaration.ts";

export type SettingsSources = {
  conf: string;
  lines: string[];
  git: Map<string, string[]>;
  unknown: string[];
};

export async function readSettingsSources(
  declarations: readonly Declaration[],
  config: DeliveryConfig,
  git: ReadRunner,
): Promise<SettingsSources> {
  const conf = config.path;
  const lines = conf
    ? config.content
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => /^[A-Z0-9]+(_[A-Z0-9]+)+=/.test(line))
    : [];

  const claimed = new Set(
    declarations.flatMap((entry) => entry.settings.map((setting) => setting.key)),
  );

  const unknown = [...new Set(lines.map((line) => line.split("=", 1)[0]!))]
    .sort()
    .filter((key) => !claimed.has(key))
    .map((key) => `${conf}: ${key} is no installed reviewer's setting`);

  const values = new Map<string, string[]>();
  const result = await git(
    ["config", "--local", "--includes", "--null", "--get-regexp", "^skills\\."],
    10_000,
  );

  if (result.code === 0)
    for (const row of result.stdout.split("\0").filter(Boolean)) {
      const separator = row.indexOf("\n");
      const key = separator < 0 ? row : row.slice(0, separator);
      const entries = values.get(key) ?? [];
      entries.push(separator < 0 ? "" : row.slice(separator + 1));
      values.set(key, entries);
    }

  return { conf, lines, git: values, unknown };
}

export function resolveSettings(
  declaration: Declaration,
  active: boolean,
  sources: SettingsSources,
): { values: Record<string, string>; notes: string[] } {
  const values: Record<string, string> = {};
  const notes = [...sources.unknown];
  for (const setting of declaration.settings) {
    let value = setting.defaultValue;
    const config = sources.lines
      .filter((line) => line.startsWith(`${setting.key}=`))
      .map((line) => line.slice(setting.key.length + 1));

    const gitKey = `skills.${declaration.name}.${setting.name}`;
    const layers: [string, string[]][] = [
      [`${sources.conf}: ${setting.key}`, config],
      [`git config ${gitKey}`, sources.git.get(gitKey) ?? []],
    ];

    for (const [source, candidates] of layers) {
      if (candidates.length === 0) continue;
      if (!active) {
        notes.push(`${source} ignored, ${declaration.name} is not active`);
        continue;
      }

      if (candidates.length > 1) {
        notes.push(`${source} is set more than once, skipped`);
        continue;
      }

      const candidate = candidates[0]!;
      if (candidate && !/[\r\n]/.test(candidate) && matchesSetting(setting.pattern, candidate))
        value = candidate;
      else notes.push(`${source}=${candidate} is not valid, skipped`);
    }

    values[setting.name] = value;
  }

  return { values, notes };
}

export async function runSettings(
  args: readonly string[],
  deps: Dependencies,
): Promise<CommandOutput> {
  if (args.length !== 1 || !reviewerName.test(args[0]!))
    return { code: 2, stdout: "", stderr: "usage: skills settings <reviewer>\n" };

  let declarations: Declaration[];
  try {
    declarations = readDeclarations(deps.root);
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: `${String(error instanceof Error ? error.message : error)}\nsettings: cannot read reviewer declarations\n`,
    };
  }

  const declaration = declarations.find((entry) => entry.name === args[0]);
  if (!declaration || declaration.settings.length === 0)
    return { code: 1, stdout: "", stderr: `settings: ${args[0]} is not an installed reviewer\n` };

  const config = readDeliveryConfig(deps.env);
  const delivery = deliveryFrom(deps.root, config);
  const sources = await readSettingsSources(declarations, config, deps.git);
  const result = resolveSettings(
    declaration,
    delivery.mode === "prs" && delivery.active.includes(declaration.name),
    sources,
  );

  return {
    code: 0,
    stdout: Object.entries(result.values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
    stderr: result.notes.map((note) => `settings: ${note}\n`).join(""),
  };
}
