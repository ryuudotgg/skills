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
    {
      name: ["plans", "resume"],
      allow: true,
      usage: "skills plans resume <Project> [--facts]",
      grammar: [
        "off",
        "every <n>m",
        "read <id> <thread> | -",
        "skip <id> <reason>",
        "nudge <id> <cause> <thread> <run> <message>",
      ],
      async run(args) {
        const { resumeVerb } = await import("../plans/resume.ts");
        return resumeVerb(args, this.usage, processIo());
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
      name: ["plans", "sweep"],
      allow: true,
      usage: "skills plans sweep <Project> [--dry-run] [--json]",
      grammar: [
        "closed <id> #<pr> <slug>",
        "would close <id> #<pr> <slug>",
        "checkout <id> <path> clean|dirty|unpushed|busy|primary|current|unreadable",
        "draft <id> #<pr> <plan file>",
        "refused <id> #<pr>: <reason>",
        "already <id> #<pr>: closed by another run",
        "live <id> #<pr>: merged while its thread still works",
        "open <id> #<pr>",
        "conflict <id> #<pr> <sha>",
        "sent <id> #<pr> <sha>",
        '{"lines": [<line>], "conflicts": [{"id", "slug", "pr", "sha", "thread", "sent"}], "busy": {<path>: <id>}}',
        "unmerged <id> #<pr>: closed without merging, the operator's call",
        "elsewhere <id> #<pr>: merged into <base>, not the default branch",
        "nopr <id> <branch>",
        "skipped <id> <branch>: the default branch",
        "unstarted <id> #<pr>: merged, but log.tsv has no start for the row",
        "unreadable <id> <branch>: <reason>",
        "unreadable checkouts: git worktree list failed",
        "removed <path>",
        "would remove <path>",
        "kept <path>: <reason>",
        "closed <n> of <m>",
        "would close <n> of <m>",
        "nothing left to close",
      ],
      async run(args) {
        const { sweepVerb } = await import("../plans/sweep.ts");
        return sweepVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["plans", "start"],
      allow: true,
      usage: "skills plans start <Project> <id | ctx-slug>",
      grammar: [
        "<base>",
        row,
        "left <id> effort <effort>",
        "left <id> waits on <id> <status>",
        "left <id> in or behind a blocker cycle",
      ],
      async run(args, ctx) {
        const { startVerb } = await import("../plans/stack-verbs.ts");
        return startVerb(args, this.usage, ctx.root, processIo());
      },
    },
    verb(
      "lint",
      "skills plans lint <Project> [id | --overlap]",
      [
        "<file>: <problem>",
        "<n> error(s)",
        "overlap <id> <id> <path>",
        "unprobed <id>: <reason>",
        "ok",
      ],
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
      name: ["brief"],
      allow: true,
      usage: "skills brief <Project> <id> <route>",
      grammar: ["<key>: <value>", "<line copied from a skill file>"],
      async run(args, ctx) {
        const { briefVerb, readSetup } = await import("../plans/brief.ts");
        const io = processIo();
        return briefVerb(
          args,
          this.usage,
          () => readSetup(ctx.root, ctx.repo, ctx.bin, io.env),
          io,
        );
      },
    },
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
