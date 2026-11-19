import { GRACE, pipe, within } from "./read.ts";

export type WriteOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Uint8Array;
  stdout: "pipe" | 2;
  stderr: "pipe" | "inherit" | "ignore";
};

export type Written = { code: number | null; stdout: string; bytes: Uint8Array; stderr: string };

export async function write(argv: readonly string[], options: WriteOptions): Promise<Written> {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env,
    stdin: options.input ?? "ignore",
    stdout: options.stdout,
    stderr: options.stderr,
  });

  const output = child.stdout instanceof ReadableStream ? pipe(child.stdout) : undefined;
  const errors = child.stderr instanceof ReadableStream ? pipe(child.stderr) : undefined;
  try {
    await child.exited;

    // A gh extension runs as a grandchild that keeps the pipe open after gh itself is killed.
    await within(Promise.all([output?.done, errors?.done]), GRACE);

    const bytes = output ? output.bytes() : new Uint8Array();
    return {
      code: child.exitCode,
      stdout: new TextDecoder().decode(bytes),
      bytes,
      stderr: errors ? new TextDecoder().decode(errors.bytes()) : "",
    };
  } finally {
    output?.cancel();
    errors?.cancel();
    child.unref();
  }
}
