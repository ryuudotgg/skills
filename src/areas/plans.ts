import type { Area, Verb } from "../registry.ts";
import { legacyWatch } from "../test/watch.ts";

type Handlers = typeof import("../plans/verbs.ts");

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

const row = "<id>\t<slug>\t<status>\t<pri>\t<effort>\t<blocked_by>\t<ctx>\t<branch>\t<updated>\t<note>";

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
    verb("set-row", "skills plans set-row <Project> <id> <STATUS> [branch|-] [note|-]", [row], "setRowVerb"),
    verb(
      "add",
      "skills plans add <Project> <slug> <pri> <effort> [blocked_by|-] [ctx|-] [note|-]",
      [row],
      "addVerb",
    ),
    verb("log", "skills plans log <Project> <id> <event> [detail]", [], "logVerb"),
    verb(
      "lint",
      "skills plans lint <Project> [id]",
      ["<file>: <problem>", "<n> error(s)", "ok"],
      "lintVerb",
    ),
    verb("handoff", "skills plans handoff <Project> <id>", ["babysit <branch> ...", "next <id>"], "handoffVerb"),
    verb("chain", "skills plans chain <branch>", ["<branch>"], "chainVerb"),
  ],
  ports: [],
  suites: [
    {
      name: "test-preflight",
      argv: ["sh", "skills/plans/scripts/test-preflight.sh"],
      files: ["skills/plans/scripts/test-preflight.sh"],
      watch: legacyWatch,
      seconds: 3.1,
    },
    {
      name: "test-stack-base",
      argv: ["sh", "skills/plans/scripts/test-stack-base.sh"],
      files: ["skills/plans/scripts/test-stack-base.sh"],
      watch: legacyWatch,
      seconds: 4.7,
    },
  ],
};
