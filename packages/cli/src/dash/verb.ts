import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import cli from "../../package.json";
import type { Io } from "../io.ts";
import { openReadOnly, storePath } from "../plans/store.ts";
import { resolveBuild } from "./build.ts";
import { dashHandler } from "./http.ts";

const DASH_USAGE = "skills dash [--no-open] [--dist <dir>]";

type Options = { open: boolean; dist: string | undefined };

function parseOptions(args: readonly string[]): Options | undefined {
  const options: Options = { open: true, dist: undefined };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--no-open") options.open = false;
    else if (arg === "--dist" && args[index + 1] !== undefined && options.dist === undefined)
      options.dist = args[++index];
    else return undefined;
  }

  return options;
}

function openCommand(url: string): string[] | undefined {
  if (process.platform === "darwin") return ["open", url];
  if (process.platform === "linux") return ["xdg-open", url];
  return undefined;
}

function openBrowser(url: string, io: Io): void {
  const command = openCommand(url);
  if (!command) {
    io.err(`dash: no opener on ${process.platform}, open the URL by hand\n`);
    return;
  }

  try {
    Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"], env: io.env }).unref();
  } catch {
    io.err(`dash: ${command[0]} failed, open the URL by hand\n`);
  }
}

function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, resolve);
  });
}

function storeProblem(plansDb: string): string | undefined {
  if (!existsSync(plansDb)) return `no plans.db at ${plansDb}, run skills plans import`;

  try {
    openReadOnly(plansDb).close();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function dashVerb(args: readonly string[], io: Io): Promise<number> {
  const options = parseOptions(args);
  if (!options) {
    io.err(`usage: ${DASH_USAGE}\n`);
    return 2;
  }

  const build = await resolveBuild(options.dist, cli.version, io.env, io.cwd);
  if (build.kind === "refused") {
    io.err(`${build.line}\n`);
    return 1;
  }

  const plansDb = storePath(io.env);
  const readable = storeProblem(plansDb);
  if (readable) io.err(`dash: ${readable}\n`);

  const token = randomBytes(32).toString("base64url");
  const handle = dashHandler({ token, dist: build.dir, plansDb });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, served) => handle(request, `127.0.0.1:${served.port}`),
  });

  const url = `http://127.0.0.1:${server.port}/#token=${token}`;
  io.out(`${url}\n`);
  if (options.open) openBrowser(url, io);

  await untilStopped();
  await server.stop(true);

  return 0;
}
