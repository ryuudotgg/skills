import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

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

export function suiteEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("GIT_")));
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined)
    return;

  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

export function startCommand(argv: readonly string[], options: CommandOptions) {
  const [command, ...args] = argv;
  if (!command)
    throw new Error("empty command");

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? suiteEnvironment(),
    detached: true,
    stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  if (options.captureStdout !== false) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
  }

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.on("error", (error) => {
    stderr += `${error.message}\n`;
  });

  const abort = () => killGroup(child.pid);
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, options.timeout ?? 30_000);

  options.signal?.addEventListener("abort", abort, { once: true });

  if (options.signal?.aborted)
    abort();

  const result = new Promise<CommandResult>((resolve) => {
    let finished = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (finished)
        return;

      finished = true;

      clearTimeout(timer);
      clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", abort);
      child.stdout?.destroy();
      child.stderr?.destroy();

      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    };

    child.on("exit", (code) => {
      graceTimer = setTimeout(() => finish(code), 2000);
    });

    child.on("close", finish);
  });

  return { child, result };
}

export async function runCommand(
  argv: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return startCommand(argv, options).result;
}

export async function removeTemporary(directory: string): Promise<void> {
  if (!existsSync(directory))
    return;

  const result = await runCommand(["chmod", "-R", "u+rwx", directory], { cwd: dirname(directory) });
  if (result.code !== 0 || result.timedOut)
    throw new Error(`cleanup: ${result.stderr || "chmod failed"}`);

  await rm(directory, { recursive: true, force: true });
}

export async function withInterrupts(
  run: (signal: AbortSignal) => Promise<number>,
): Promise<number> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals)
    process.on(signal, interrupt);

  try {
    const code = await run(controller.signal);
    return controller.signal.aborted ? 130 : code;
  } catch (error) {
    if (controller.signal.aborted)
      return 130;
    throw error;
  } finally {
    for (const signal of signals)
      process.off(signal, interrupt);
  }
}
