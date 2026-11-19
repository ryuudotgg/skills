import { processIo, type Io } from "./io.ts";
import { describe, read } from "./read.ts";
import { write } from "./write.ts";

export type ProcessResult = { code: number | undefined; output: string };
type RunOptions = {
  capture?: boolean;
  write?: boolean;
  timeout?: number;
  stderr?: "inherit" | "ignore";
};

export function argumentsFor(
  args: readonly string[],
  names: string,
  long: readonly string[] = [],
): { options: Map<string, string>; files: string[] } | undefined {
  const options = new Map<string, string>();

  let index = 0;
  while (index < args.length) {
    const option = args[index] ?? "";
    if (option === "--") {
      index++;
      break;
    }

    if (!option.startsWith("-") || option === "-") break;

    const spelled = option.startsWith("--");
    const name = spelled ? option.slice(2) : (option[1] ?? "");
    if (!(spelled ? long : names).includes(name) || options.has(name)) return undefined;

    const value = !spelled && option.length > 2 ? option.slice(2) : args[++index];
    if (value === undefined) return undefined;

    options.set(name, value);
    index++;
  }

  return { options, files: args.slice(index) };
}

export async function run(
  cwd: string,
  argv: readonly string[],
  options: RunOptions = {},
  io: Io = processIo(),
): Promise<ProcessResult> {
  if (!options.write) {
    const result = await read(argv, { cwd, env: io.env, deadline: options.timeout ?? 10_000 });
    if (options.stderr !== "ignore") io.err(result.stderr);
    if (!result.ok) {
      if (options.stderr !== "ignore") io.err(describe(result.failure) + "\n");
      return { code: undefined, output: "" };
    }

    if (!options.capture) io.err(result.stdout);

    return { code: result.code, output: options.capture ? result.stdout : "" };
  }

  try {
    const result = await write(argv, {
      cwd,
      env: io.env,
      stdout: options.capture || io.capture ? "pipe" : 2,
      stderr: options.stderr === "ignore" ? "ignore" : io.capture ? "pipe" : "inherit",
    });

    io.err(result.stderr);
    if (!options.capture) io.err(result.stdout);

    return {
      code: result.code ?? undefined,
      output: options.capture && result.code !== null ? result.stdout : "",
    };
  } catch {
    return { code: undefined, output: "" };
  }
}

export function git(
  cwd: string,
  args: readonly string[],
  options: RunOptions = {},
  io: Io = processIo(),
): Promise<ProcessResult> {
  return run(cwd, ["git", ...args], options, io);
}
