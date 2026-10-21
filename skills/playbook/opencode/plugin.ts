import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Input = Record<string, unknown>;
type Event = { tool: string; input: unknown };
type Result = { output?: unknown; content?: string | readonly unknown[]; metadata?: unknown };
type After = Event &
  ({ status: "completed"; result: Result } | { status: "error"; error?: unknown });

type Events = { "execute.before": Event; "execute.after": After };
type Context = {
  location: { directory: string };
  tool: {
    hook<Name extends keyof Events>(
      name: Name,
      callback: (event: Events[Name]) => Promise<void>,
    ): Promise<unknown>;
  };
};

type Options = { cli: string; env: NodeJS.ProcessEnv; timeout: number };
type Payload = { tool_name: string; tool_input: Input; cwd: string };
type Mapping = {
  phase: "pre-tool-use" | "post-tool-use";
  payload: (input: Input, directory: string, env: NodeJS.ProcessEnv) => Payload;
};

const unavailable =
  "Blocked: the commit guard could not run, so every shell command stays blocked.";

function object(value: unknown): Input {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Input)
    : {};
}

function pathFrom(value: unknown, directory: string, env: NodeJS.ProcessEnv): string {
  if (typeof value !== "string") throw new Error("Expected a path");

  const home = env.HOME || homedir();
  const expanded = value === "~" ? home : value.startsWith("~/") ? home + value.slice(1) : value;
  return resolve(directory, expanded);
}

const tools: Record<string, Mapping> = {
  shell: {
    phase: "pre-tool-use",
    payload: (input, directory, env) => ({
      tool_name: "Bash",
      tool_input: { command: input.command },
      cwd: pathFrom(input.workdir ?? ".", directory, env),
    }),
  },
  edit: {
    phase: "post-tool-use",
    payload: (input, directory, env) => ({
      tool_name: "Edit",
      tool_input: {
        file_path: pathFrom(input.path, directory, env),
        old_string: input.oldString,
        new_string: input.newString,
        replace_all: input.replaceAll,
      },
      cwd: directory,
    }),
  },
  write: {
    phase: "post-tool-use",
    payload: (input, directory, env) => ({
      tool_name: "Write",
      tool_input: { file_path: pathFrom(input.path, directory, env), content: input.content },
      cwd: directory,
    }),
  },
  patch: {
    phase: "post-tool-use",
    payload: (input, directory, env) => {
      if (typeof input.patchText !== "string") throw new Error("Expected patch text");

      return {
        tool_name: "apply_patch",
        tool_input: {
          command: input.patchText
            .replaceAll("\r", "")
            .replace(/^[\t ]*(\*\*\* .*?)[\t ]*$/gm, "$1")
            .replace(
              /^(\*\*\* (?:Add File|Update File|Delete File|Move to): )(.+)$/gm,
              (_line, header: string, path: string) =>
                header + pathFrom(path.trim(), directory, env),
            ),
        },
        cwd: directory,
      };
    },
  },
};

function mapping(event: Event): Mapping | undefined {
  return Object.hasOwn(tools, event.tool)
    ? tools[event.tool]
    : typeof object(event.input).command === "string"
      ? tools.shell
      : undefined;
}

function run(phase: Mapping["phase"], payload: Payload, directory: string, options: Options) {
  return new Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    timedOut: boolean;
  }>((accept, reject) => {
    const child = spawn(options.cli, ["hook", phase], {
      cwd: directory,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });

    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;

      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }

      child.stdout.destroy();
      child.stdin.destroy();
      accept({ code: null, signal: "SIGKILL", stdout, timedOut });
    }, options.timeout);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      accept({ code, signal, stdout, timedOut });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

async function before(event: Event, directory: string, options: Options): Promise<void> {
  let reason = unavailable;
  try {
    const selected = mapping(event);
    if (selected?.phase !== "pre-tool-use") return;

    const result = await run(
      selected.phase,
      selected.payload(object(event.input), directory, options.env),
      directory,
      options,
    );

    if (!result.timedOut && !result.signal) {
      if (result.code === 0 && result.stdout === "") return;

      const verdict = object(object(JSON.parse(result.stdout)).hookSpecificOutput);
      if (
        verdict.permissionDecision === "deny" &&
        typeof verdict.permissionDecisionReason === "string"
      )
        reason = verdict.permissionDecisionReason;
    }
  } catch {}

  throw new Error(reason);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function content(result: Result): readonly unknown[] {
  if (typeof result.content === "string") return [{ type: "text", text: result.content }];
  if (result.content?.length) return result.content;
  return [{ type: "text", text: stringify(result.output) }];
}

async function after(event: After, directory: string, options: Options): Promise<void> {
  try {
    if (event.status !== "completed") return;

    const selected = mapping(event);
    if (selected?.phase !== "post-tool-use") return;

    const result = await run(
      selected.phase,
      selected.payload(object(event.input), directory, options.env),
      directory,
      options,
    );

    if (result.code !== 0 || result.signal || result.timedOut) return;

    const verdict = object(JSON.parse(result.stdout));
    if (verdict.decision !== "block" || typeof verdict.reason !== "string") return;

    event.result = {
      ...event.result,
      content: [{ type: "text", text: verdict.reason }, ...content(event.result)],
    };
  } catch {}
}

export function createPlugin(options: Partial<Options> = {}) {
  const settings = {
    cli: resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../bin/skills"),
    env: process.env,
    timeout: 30_000,
    ...options,
  };

  return {
    id: "skills-guard",
    async setup(ctx: Context): Promise<void> {
      await ctx.tool.hook("execute.before", (event) =>
        before(event, ctx.location.directory, settings),
      );

      await ctx.tool.hook("execute.after", (event) =>
        after(event, ctx.location.directory, settings),
      );
    },
  };
}

export default createPlugin();
