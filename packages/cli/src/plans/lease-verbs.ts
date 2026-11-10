import { breakLease, pinPlans } from "../hub/plan-leases.ts";
import { PIN_DEFAULT } from "../hub/leases.ts";
import type { Io } from "../io.ts";

export async function pinVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const ids: string[] = [];

  let lasts: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--for" && lasts === undefined && index + 1 < args.length) lasts = args[++index];
    else if (arg.startsWith("-")) {
      io.err(`usage: ${usage}\n`);
      return 2;
    } else ids.push(arg);
  }

  const [project, ...plans] = ids;
  if (project === undefined || plans.length === 0) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const lines = await pinPlans(project, plans, lasts ?? PIN_DEFAULT, io.env);
  for (const { line } of lines) io.out(`${line}\n`);
  return lines.every((line) => line.ok) ? 0 : 1;
}

export async function leaseBreakVerb(
  args: readonly string[],
  usage: string,
  io: Io,
): Promise<number> {
  const [project, id, ...extra] = args;
  if (project === undefined || id === undefined || extra.length > 0) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const result = await breakLease(project, id, io.env);
  if (!result.ok) {
    io.err(`lease break: ${result.reason}\n`);
    return 1;
  }

  io.out(`${result.line}\n`);
  return 0;
}
