import { processIo } from "../io.ts";
import type { Area, Verb } from "../registry.ts";

type Handler = "scanVerb" | "listVerb";

function verb(name: string, usage: string, grammar: readonly string[], handler: Handler): Verb {
  return {
    name: ["sessions", name],
    allow: true,
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
        "<host>\t<session>\t<Project> | -\t<id>,<id> | -\t<branch> | -\t<label> | -\t<start>\t<end> | -\t<model>/<effort>,<model>/<effort> | -\t<tokens>",
      ],
      "listVerb",
    ),
  ],
  suites: [],
};
