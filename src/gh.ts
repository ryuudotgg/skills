export async function ghOutput(args: readonly string[]): Promise<string | undefined> {
  try {
    const child = Bun.spawn(["gh", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
      timeout: 30_000,
      killSignal: "SIGTERM",
    });

    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? output : undefined;
  } catch {
    return undefined;
  }
}
