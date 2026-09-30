import { dirname, join, resolve } from "node:path";
import { plans } from "./areas/plans.ts";
import { round } from "./areas/round.ts";
import { pr } from "./areas/pr.ts";
import { stack } from "./areas/stack.ts";
import { hooks } from "./areas/hooks.ts";
import { install } from "./areas/install.ts";
import { tools } from "./areas/tools.ts";
import type { Area, Context } from "./registry.ts";

export const areas: readonly Area[] = [plans, round, pr, stack, hooks, install, tools];
export const suites = areas.flatMap((area) => area.suites);
const verbs = areas.flatMap((area) => area.verbs);
const ports = areas.flatMap((area) => area.ports);
const repo = resolve(import.meta.dir, "..");

function usage(): string {
  return `usage: skills [--root <skills dir>] <verb>\n\n${verbs.map((verb) => verb.usage).join("\n")}\n`;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  let root = join(repo, "skills");
  if (args[0] === "--root") {
    args.shift();

    const value = args.shift();
    if (!value || value.startsWith("--")) {
      process.stderr.write(`--root needs a skills directory\n${usage()}`);

      return 2;
    }

    root = resolve(value);
  }

  if (args[0] === "--help") {
    process.stdout.write(usage());

    return 0;
  }

  const verb = verbs.find((entry) => entry.name.every((word, index) => args[index] === word));
  if (!verb) {
    process.stderr.write(usage());

    return 2;
  }

  const ctx: Context = {
    root,
    repo: dirname(root),
    bin: join(repo, "skills/playbook/bin/skills"),
    suites,
    ports,
  };

  try {
    return await verb.run(args.slice(verb.name.length), ctx);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);

    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
