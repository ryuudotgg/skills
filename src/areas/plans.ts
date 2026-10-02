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
): Verb {
  return {
    name: ["plans", name],
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
    verb(
      "frontier",
      "skills plans frontier [--next | --stacks-on <id>] [Project]",
      [
        "READY <n>",
        "<id> <pri> <effort> <slug> <note | stacks on <id> (<branch>)>",
        "BLOCKED <n>",
        "<id> <pri> <slug> waits on <ids>[ (two stacks)]",
        "REVIEW <n>",
        "<id> <pri> <slug> <branch>",
        "DOING <id> <slug> <branch>[, ...]",
        "<id>",
      ],
      "frontierVerb",
    ),
    verb(
      "set-row",
      "skills plans set-row <Project> <id> <STATUS> [branch|-] [note|-]",
      [row],
      "setRowVerb",
    ),
    verb(
      "add",
      "skills plans add <Project> <slug> <pri> <effort> [blocked_by|-] [ctx|-] [note|-]",
      [row],
      "addVerb",
    ),
    verb("log", "skills plans log <Project> <id> <event> [detail]", [], "logVerb"),
    verb(
      "close",
      "skills plans close <Project> <id> <DONE|DROPPED> <note>",
      [row, "<id> is already closed"],
      "closeVerb",
    ),
    {
      name: ["plans", "start"],
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
    ),
    verb(
      "handoff",
      "skills plans handoff <Project> <id>",
      ["babysit <branch> ...", "next <id>"],
      "handoffVerb",
    ),
    verb("chain", "skills plans chain <branch>", ["<branch>"], "chainVerb"),
    {
      name: ["plans", "stack-base"],
      usage: "skills plans stack-base [--cut] <Project> <id>",
      grammar: ["<base>"],
      async run(args, ctx) {
        const { stackBaseVerb } = await import("../plans/stack-verbs.ts");
        return stackBaseVerb(args, this.usage, ctx.root, processIo());
      },
    },
    {
      name: ["plans", "below"],
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
