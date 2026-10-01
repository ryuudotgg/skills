import { dirname, join, resolve } from "node:path";
import { hooks } from "./areas/hooks.ts";
import type { Area, Context } from "./registry.ts";

const entryArgs = process.argv.slice(2);
const hookArgs = entryArgs[0] === "--root" ? entryArgs.slice(2) : entryArgs;
const preToolEntry = import.meta.main && hookArgs[0] === "hook" && hookArgs[1] === "pre-tool-use";

export const areas: readonly Area[] = preToolEntry
  ? [hooks]
  : await Promise.all([
      import("./areas/plans.ts").then((area) => area.plans),
      import("./areas/round.ts").then((area) => area.round),
      import("./areas/review.ts").then((area) => area.review),
      import("./areas/pr.ts").then((area) => area.pr),
      import("./areas/stack.ts").then((area) => area.stack),
      Promise.resolve(hooks),
      import("./areas/install.ts").then((area) => area.install),
      import("./areas/tools.ts").then((area) => area.tools),
    ]);
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

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
