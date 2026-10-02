import { describe, read } from "./read.ts";
import { processIo, type Io } from "./io.ts";

export async function ghOutput(args: readonly string[], io: Io = processIo()): Promise<string | undefined> {
  const result = await read(["gh", ...args], { cwd: io.cwd, env: io.env, deadline: 30_000 });
  io.err(result.stderr);

  if (!result.ok) {
    io.err(describe(result.failure) + "\n");
    return undefined;
  }

  return result.code === 0 ? result.stdout : undefined;
}
