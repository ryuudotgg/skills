import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipe, within } from "../read.ts";

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type CommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  signal?: AbortSignal;
  input?: boolean;
  captureStdout?: boolean;
};

export type StartedChild = {
  readonly pid: number | undefined;
  readonly stdin: Writable | undefined;
  kill(signal?: NodeJS.Signals): void;
};

const GRACE = 2_000;

export function suiteEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("GIT_")));
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;

  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

type Collected = Pick<ReturnType<typeof pipe>, "done" | "cancel"> & { text(): string };

function collect(stream: ReadableStream<Uint8Array> | undefined): Collected {
  if (stream === undefined) return { done: Promise.resolve(), text: () => "", cancel() {} };

  const piped = pipe(stream);
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  return { done: piped.done, cancel: piped.cancel, text: () => decoder.decode(piped.bytes()) };
}

function stdinOf(sink: Bun.FileSink): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      void (async () => {
        await sink.write(chunk);
        await sink.flush();
      })().then(
        () => done(),
        (error: Error) => done(error),
      );
    },
    final(done) {
      void (async () => {
        await sink.end();
      })().then(
        () => done(),
        (error: Error) => done(error),
      );
    },
  });
}

function failed(error: unknown): { child: StartedChild; result: Promise<CommandResult> } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    child: { pid: undefined, stdin: undefined, kill() {} },
    result: Promise.resolve({ code: 1, stdout: "", stderr: `${message}\n`, timedOut: false }),
  };
}

export function startCommand(argv: readonly string[], options: CommandOptions) {
  const [command] = argv;
  if (!command) throw new Error("empty command");

  let child: Bun.Subprocess<"pipe" | "ignore", "pipe" | "ignore", "pipe">;
  try {
    child = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: options.env ?? suiteEnvironment(),
      detached: true,
      stdin: options.input ? "pipe" : "ignore",
      stdout: options.captureStdout === false ? "ignore" : "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return failed(error);
  }

  const stdout = collect(child.stdout instanceof ReadableStream ? child.stdout : undefined);
  const stderr = collect(child.stderr);

  let timedOut = false;
  const abort = () => killGroup(child.pid);
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, options.timeout ?? 30_000);

  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  const result = (async (): Promise<CommandResult> => {
    await child.exited;
    await within(
      Promise.all([stdout.done, stderr.done]).catch(() => {}),
      GRACE,
    );

    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    stdout.cancel();
    stderr.cancel();

    const code = child.signalCode === null ? (child.exitCode ?? 1) : 1;
    return { code, stdout: stdout.text(), stderr: stderr.text(), timedOut };
  })();

  const stdin = options.input && typeof child.stdin === "object" ? stdinOf(child.stdin) : undefined;
  const started: StartedChild = {
    pid: child.pid,
    stdin,
    kill: (signal = "SIGTERM") => child.kill(signal),
  };

  return { child: started, result };
}

export async function runCommand(
  argv: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return startCommand(argv, options).result;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function writable(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }

  if (info.isSymbolicLink()) return;

  try {
    await chmod(path, info.mode | 0o700);
    if (!info.isDirectory()) return;

    const names = await readdir(path);
    await Promise.all(names.map((name) => writable(join(path, name))));
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

export async function removeTemporary(directory: string): Promise<void> {
  await writable(directory);
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}

export async function withInterrupts(
  run: (signal: AbortSignal) => Promise<number>,
): Promise<number> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, interrupt);

  try {
    const code = await run(controller.signal);
    return controller.signal.aborted ? 130 : code;
  } catch (error) {
    if (controller.signal.aborted) return 130;
    throw error;
  } finally {
    for (const signal of signals) process.off(signal, interrupt);
  }
}
