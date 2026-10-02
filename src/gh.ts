import { describe, read } from "./read.ts";

export async function ghOutput(args: readonly string[]): Promise<string | undefined> {
  const result = await read(["gh", ...args], { deadline: 30_000 });
  process.stderr.write(result.stderr);

  if (!result.ok) {
    process.stderr.write(describe(result.failure) + "\n");
    return undefined;
  }

  return result.code === 0 ? result.stdout : undefined;
}
