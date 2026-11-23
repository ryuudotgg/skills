import { join, resolve } from "node:path";

const skills = join(resolve(import.meta.dir, "../../.."), "skills/playbook/bin/skills");

const START_LIMIT_MS = 20_000;

export type Dash = {
  process: Bun.Subprocess<"ignore", "pipe", "inherit">;
  url: string;
  origin: string;
  token: string;
};

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();

  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (text.includes("\n")) return text.slice(0, text.indexOf("\n"));
  }

  throw new Error(`skills dash printed no line: ${text}`);
}

export async function startDash(options: {
  dist: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<Dash> {
  const child = Bun.spawn([skills, "dash", "--no-open", "--dist", options.dist], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });

  const limit = setTimeout(() => child.kill("SIGTERM"), START_LIMIT_MS);
  try {
    const url = await firstLine(child.stdout);
    const token = url.slice(url.indexOf("#token=") + "#token=".length);
    return { process: child, url, origin: new URL(url).origin, token };
  } catch (error) {
    child.kill("SIGTERM");
    await child.exited;
    throw error;
  } finally {
    clearTimeout(limit);
  }
}

export async function stopDash(dash: Dash): Promise<void> {
  dash.process.kill("SIGTERM");
  await dash.process.exited;
}
