import { processIo } from "../io.ts";
import type { Area, Verb } from "../registry.ts";

type Handler = "scanVerb" | "listVerb" | "policyVerb" | "restoreVerb";

function verb(
  name: string,
  usage: string,
  grammar: readonly string[],
  handler: Handler,
  allow = true,
): Verb {
  return {
    name: ["sessions", name],
    allow,
    usage,
    grammar,
    async run(args) {
      const handlers = await import("../sessions/verbs.ts");
      return handlers[handler](args, usage, processIo());
    },
  };
}

export const sessions: Area = {
  verbs: [
    verb("scan", "skills sessions scan", ["scanned <n> transcripts, <m> changed"], "scanVerb"),
    verb(
      "list",
      "skills sessions list [Project] [--plan <Project>/<id>]",
      [
        "<host>\t<session>\t<Project> | -\t<id>,<id> | -\t<branch> | -\t<label> | -\t<start>\t<end> | -\t<model>/<effort>,<model>/<effort> | -\t<tokens>\t<policy>",
      ],
      "listVerb",
    ),
    verb(
      "policy",
      "skills sessions policy <Project> [full|redacted|stats|off]",
      ["<Project> <policy>", "<Project> redacted (default)"],
      "policyVerb",
      false,
    ),
    verb(
      "restore",
      "skills sessions restore [--project <Project>] [--since <time>]",
      [
        "wrote <host> <session> <path>",
        "wrote <host> <session> <path> through chunk <n>, chunk <n+1> missing",
        "cd <root> && claude --resume <session>",
        "codex resume <session>",
        "skipped <host> <session> exists | no checkout for <Project> | chunk 0 missing",
        "restored <n>, skipped <m>",
      ],
      "restoreVerb",
    ),
  ],
  suites: [],
};
