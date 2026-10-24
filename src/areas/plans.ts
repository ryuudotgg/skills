import { processIo } from "../io.ts";
import type { Area, Verb } from "../registry.ts";

type Module = typeof import("../plans/verbs.ts");
type Handler = (args: readonly string[], usage: string) => Promise<number>;
type Handlers = {
  [Name in keyof Module as Module[Name] extends Handler ? Name : never]: Module[Name];
};

function verb(
  name: string,
  usage: string,
  grammar: readonly string[],
  handler: keyof Handlers,
  allow: boolean,
): Verb {
  return {
    name: ["plans", name],
    allow,
    usage,
    grammar,
    async run(args) {
      const handlers = await import("../plans/verbs.ts");
      return handlers[handler](args, usage);
    },
  };
}

const row =
  "<id>\t<slug>\t<status>\t<pri>\t<effort>\t<blocked_by>\t<ctx>\t<branch>\t<updated>\t<note>";

export const plans: Area = {
  verbs: [
    {
      name: ["plans", "wave"],
      allow: true,
      usage: "skills plans wave <Project> [--dry-run]",
      grammar: [
        "model <instance>/<model> | inherit",
        "effort <effort> | inherit",
        "launch <id> <slug>",
        "held <id>: shares <path> with <id>",
        "held <id>: <id> is unprobed",
        "unprobed <id>: <reason>",
      ],
      async run(args) {
        const { waveVerb } = await import("../plans/wave.ts");
        return waveVerb(args, this.usage, processIo());
      },
    },
    verb(
      "frontier",
      "skills plans frontier [--next | --stacks-on <id>] [Project]",
      [
        "READY <n>",
        "<id> <pri> <effort> <slug> <note | stacks on <id> (<branch>)>",
        "BLOCKED <n>",
        "<id> <pri> <slug> waits on <ids>[ (two stacks)]",
        "<id> <pri> <slug> <branch> <note>",
        "REVIEW <n>",
        "<id> <pri> <slug> <branch>",
        "DOING <id> <slug> <branch>[, ...]",
        "<id>",
      ],
      "frontierVerb",
      true,
    ),
    {
      name: ["plans", "set-row"],
      allow: true,
      usage: "skills plans set-row <Project> <id> <STATUS> [branch|-] [note|-]",
      grammar: [row],
      async run(args, ctx) {
        const { setRowVerb } = await import("../plans/verbs.ts");
        return setRowVerb(args, this.usage, ctx.root, processIo());
      },
    },
    verb(
      "add",
      "skills plans add <Project> <slug> <pri> <effort> [blocked_by|-] [ctx|-] [note|-]",
      [row],
      "addVerb",
      true,
    ),
    verb("log", "skills plans log <Project> <id> <event> [detail]", [], "logVerb", true),
    verb(
      "close",
      "skills plans close [--dry-run] <Project> <id> <DONE|DROPPED> <note> [--sha <sha>]",
      [row, "<id> is already closed"],
      "closeVerb",
      true,
    ),
    {
      name: ["plans", "start"],
      allow: true,
      usage: "skills plans start <Project> <id>",
      grammar: ["<base>", row],
      async run(args, ctx) {
        const { startVerb } = await import("../plans/stack-verbs.ts");
        return startVerb(args, this.usage, ctx.root, processIo());
      },
    },
    verb(
      "lint",
      "skills plans lint <Project> [id]",
      ["<file>: <problem>", "<n> error(s)", "ok"],
      "lintVerb",
      true,
    ),
    verb(
      "handoff",
      "skills plans handoff <Project> <id>",
      ["babysit <branch> ...", "next <id>"],
      "handoffVerb",
      true,
    ),
    verb("chain", "skills plans chain <branch>", ["<branch>"], "chainVerb", true),
    {
      name: ["plans", "stack-base"],
      allow: true,
      usage: "skills plans stack-base [--cut] <Project> <id>",
      grammar: ["<base>"],
      async run(args, ctx) {
        const { stackBaseVerb } = await import("../plans/stack-verbs.ts");
        return stackBaseVerb(args, this.usage, ctx.root, processIo());
      },
    },
    {
      name: ["plans", "below"],
      allow: true,
      usage: "skills plans below <Project> <base>",
      grammar: ["open\t<id>\t<branch>\t<number>\t<url>"],
      async run(args, ctx) {
        const { belowVerb } = await import("../plans/stack-verbs.ts");
        return belowVerb(args, this.usage, ctx.root, processIo());
      },
    },
  ],
  suites: [],
};
