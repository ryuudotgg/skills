export type ReadFailure =
  | { kind: "spawn"; read: string; detail: string }
  | { kind: "deadline"; read: string; deadline: number }
  | { kind: "held"; read: string }
  | { kind: "signal"; read: string; signal: string };

export type Read =
  | { ok: true; code: number; stdout: string; bytes: Uint8Array; stderr: string }
  | { ok: false; failure: ReadFailure; stderr: string };

export type ReadOptions = {
  deadline: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
};

export const GRACE = 1000;

function label(argv: readonly string[]): string {
  return argv
    .slice(0, 4)
    .map((token) => token.split(/\s/, 1)[0]!.slice(0, 40))
    .join(" ");
}

export function describe(failure: ReadFailure): string {
  switch (failure.kind) {
    case "spawn":
      return `${failure.read}: cannot start (${failure.detail})`;

    case "deadline":
      return `${failure.read}: no exit within ${failure.deadline / 1000} s`;

    case "held":
      return `${failure.read}: a child process kept its output open`;

    case "signal":
      return `${failure.read}: died on ${failure.signal}`;
  }
}

export async function within<Value>(
  promise: Promise<Value>,
  milliseconds: number,
): Promise<Value | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function pipe(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let ended = false;
  const done = (async () => {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
      chunks.push(chunk.value);

    ended = true;
  })();

  return {
    done,
    ended: () => ended,
    cancel: () => {
      if (!ended) void reader.cancel().catch(() => {});
    },
    bytes: () => {
      const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));

      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }

      return bytes;
    },
  };
}

export async function read(argv: readonly string[], options: ReadOptions): Promise<Read> {
  const name = label(argv);

  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return { ok: false, failure: { kind: "spawn", read: name, detail: String(error) }, stderr: "" };
  }

  const stdout = pipe(child.stdout);
  const stderr = pipe(child.stderr);
  try {
    const code = await within(child.exited, options.deadline);
    if (code === undefined) {
      child.kill("SIGTERM");
      if ((await within(child.exited, GRACE)) === undefined) child.kill("SIGKILL");

      return {
        ok: false,
        failure: { kind: "deadline", read: name, deadline: options.deadline },
        stderr: new TextDecoder().decode(stderr.bytes()),
      };
    }

    await within(Promise.all([stdout.done, stderr.done]), GRACE);
    const error = new TextDecoder().decode(stderr.bytes());
    if (child.signalCode)
      return {
        ok: false,
        failure: { kind: "signal", read: name, signal: child.signalCode },
        stderr: error,
      };

    if (!stdout.ended()) return { ok: false, failure: { kind: "held", read: name }, stderr: error };

    const bytes = stdout.bytes();
    return { ok: true, code, stdout: new TextDecoder().decode(bytes), bytes, stderr: error };
  } finally {
    stdout.cancel();
    stderr.cancel();
    child.unref();
  }
}

export function readSync(argv: readonly string[], options: ReadOptions): Read {
  const name = label(argv);
  try {
    const child = Bun.spawnSync([...argv], {
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.deadline,
      killSignal: "SIGKILL",
    });

    const stderr = new TextDecoder().decode(child.stderr);
    if (child.exitedDueToTimeout)
      return {
        ok: false,
        failure: child.signalCode
          ? { kind: "deadline", read: name, deadline: options.deadline }
          : { kind: "held", read: name },
        stderr,
      };

    if (child.signalCode)
      return {
        ok: false,
        failure: { kind: "signal", read: name, signal: child.signalCode },
        stderr,
      };

    return {
      ok: true,
      code: child.exitCode,
      stdout: new TextDecoder().decode(child.stdout),
      bytes: child.stdout,
      stderr,
    };
  } catch (error) {
    return { ok: false, failure: { kind: "spawn", read: name, detail: String(error) }, stderr: "" };
  }
}
