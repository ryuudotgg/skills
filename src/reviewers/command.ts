import { readDelivery } from "../delivery.ts";
import type { CommandOutput } from "../round/types.ts";
import { readDeclarations, type Declaration } from "./declaration.ts";

export function runReviewers(
  args: readonly string[],
  root: string,
  env: NodeJS.ProcessEnv,
): CommandOutput {
  const active = args[0] === "--active";
  const keys = active ? args.slice(1) : args;
  const key = keys[0];
  if (keys.length !== 1 || !key || (key !== "--settings" && !/^[A-Z][A-Z0-9_]*$/.test(key)))
    return {
      code: 2,
      stdout: "",
      stderr: "usage: skills reviewers [--active] <KEY|--settings>\n",
    };

  let installed: Declaration[];
  try {
    installed = readDeclarations(root);
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }

  const delivery = active ? readDelivery(root, env) : undefined;
  const selected = installed.filter(
    (entry) => !delivery || (delivery.mode === "prs" && delivery.active.includes(entry.name)),
  );

  const stdout = selected.flatMap((entry) => {
    if (key === "--settings")
      return entry.settings.map(
        (setting) => `${entry.name}\t${setting.name}\t${setting.defaultValue}\t${setting.pattern}\n`,
      );

    const value = entry.fields.get(key);
    return value === undefined ? [] : [`${entry.name}\t${value}\n`];
  }).join("");

  return { code: 0, stdout, stderr: "" };
}
