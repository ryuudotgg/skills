import { processIo, type Io } from "../io.ts";
import type { Area, Verb } from "../registry.ts";

type Module = typeof import("../plans/verbs.ts");
type Handler = (args: readonly string[], usage: string, io: Io) => Promise<number>;
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
      return handlers[handler](args, usage, processIo());
    },
  };
}

const row =
  "<id>\t<slug>\t<status>\t<pri>\t<effort>\t<blocked_by>\t<ctx>\t<branch>\t<updated>\t<note>";

const facts = [
  "label <label>",
  "device <id> | -",
  "environment <id> | -",
  "os <platform> <version> | -",
  "arch <arch>",
  "tool <name> <version> | absent: <reason>",
  "checkout <Project> <path> <origin> | -",
  "captured <iso>",
];

type MachineModule = typeof import("../plans/machine.ts");

function machineVerb(
  name: string,
  usage: string,
  grammar: readonly string[],
  handler: "showVerb" | "labelVerb" | "refreshVerb",
): Verb {
  return {
    name: ["machine", name],
    allow: true,
    usage,
    grammar,
    async run(args) {
      const handlers: MachineModule = await import("../plans/machine.ts");
      return handlers[handler](args, usage, processIo());
    },
  };
}

type IssuesModule = typeof import("../plans/issues.ts");

function issuesVerb(
  name: string,
  usage: string,
  grammar: readonly string[],
  handler: "fileVerb" | "listVerb" | "showVerb" | "closeVerb" | "linkVerb" | "renumberVerb",
): Verb {
  return {
    name: ["issues", name],
    allow: true,
    usage,
    grammar,
    async run(args) {
      const handlers: IssuesModule = await import("../plans/issues.ts");
      return handlers[handler](args, usage, processIo());
    },
  };
}

const issueLine = "<Project>#<n>\topen|closed\t<title>\t<Project>/<id> | -";

const issuesVerbs = [
  {
    ...issuesVerb(
      "file",
      "skills issues file <Target> <title> [--body <file>] [--from <Project>/<id>] [--blocks <Project>/<id>]",
      ["<Project>#<n>"],
      "fileVerb",
    ),
    sync: true,
  },
  issuesVerb("list", "skills issues list [Project] [--all]", [issueLine], "listVerb"),
  issuesVerb(
    "show",
    "skills issues show <Project>#<n>",
    [
      "<Project>#<n> conflict: <title> | <title>, run skills issues renumber <Project>#<n>",
      "<title>",
      "from <Project>/<id> | -",
      "filed <iso>",
      "open | closed: <reason>",
      "blocks <Project>/<id>",
      "resolves <Project>/<id>",
      "",
      "<body>",
    ],
    "showVerb",
  ),
  {
    ...issuesVerb("close", "skills issues close <Project>#<n> <reason>", [issueLine], "closeVerb"),
    sync: true,
  },
  {
    ...issuesVerb("link", "skills issues link <Project>#<n> <id>", [issueLine], "linkVerb"),
    sync: true,
  },
  {
    ...issuesVerb(
      "renumber",
      "skills issues renumber <Project>#<n>",
      ["<Project>#<n>"],
      "renumberVerb",
    ),
    sync: true,
  },
];

const machineVerbs = [
  machineVerb("show", "skills machine show [--json]", [...facts, "<JSON object>"], "showVerb"),
  { ...machineVerb("label", "skills machine label <name>", facts, "labelVerb"), sync: true },
  {
    ...machineVerb("refresh", "skills machine refresh [--environment <id>]", facts, "refreshVerb"),
    sync: true,
  },
];

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
        "held <id>: pinned by <label>",
        "held <id>: conflict with <label>",
        "held <id>: needs <cap>,<cap>, [this machine has no facts yet, run skills machine refresh; ]run on <labels> | no known machine has it",
        "unprobed <id>: <reason>",
      ],
      sync: true,
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
        "read <id> <thread> <checkout> | -",
        "skip <id> <reason>",
        "nudge <id> <cause> <thread> <run> <message>",
      ],
      async run(args) {
        const { resumeVerb } = await import("../plans/resume.ts");
        return resumeVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["plans", "schedule"],
      allow: true,
      usage: "skills plans schedule [Project]",
      grammar: ["task machine|project <title>\t<schedule JSON>", "off <title>: <reason>"],
      async run(args) {
        const { scheduleVerb } = await import("../plans/schedule.ts");
        return scheduleVerb(args, this.usage, processIo());
      },
    },
    verb(
      "frontier",
      "skills plans frontier [--next | --stacks-on <id>] [--at <time>] [Project]",
      [
        "READY <n>",
        "<id> <pri> <effort> <slug> <note | stacks on <id> (<branch>)>[  needs <cap>,<cap>][  pinned by <label> | conflict with <label>]",
        "BLOCKED <n>",
        "<id> <pri> <slug> waits on <ids>[ (two stacks)]",
        "<id> <pri> <slug> <branch> <note>",
        "REVIEW <n>",
        "<id> <pri> <slug> <branch>",
        "DOING <id> <slug> <branch>[ on <label> | conflict with <label>][ (<label>, stale <n> min)][, ...]",
        "INBOX <n>",
        "<Project>#<n> <title> from <Project>/<id> | -",
        "<Project>#<n> conflict: <title> | <title>, run skills issues renumber <Project>#<n>",
        "<id>",
      ],
      "frontierVerb",
      true,
    ),
    {
      name: ["plans", "set-row"],
      allow: true,
      usage: "skills plans set-row <Project> <id>[,<id>...] <STATUS> [branch|-] [note|-]",
      grammar: [row],
      sync: true,
      async run(args, ctx) {
        const { setRowVerb } = await import("../plans/verbs.ts");
        return setRowVerb(args, this.usage, ctx.root, processIo());
      },
    },
    {
      ...verb(
        "add",
        "skills plans add <Project> <slug> <pri> <effort> [blocked_by|-] [ctx|-] [note|-] [--resolves <Project>#<n>]",
        [row],
        "addVerb",
        true,
      ),
      sync: true,
    },
    {
      ...verb("log", "skills plans log <Project> <id> <event> [detail]", [], "logVerb", true),
      sync: true,
    },
    {
      name: ["plans", "import"],
      allow: true,
      usage: "skills plans import",
      grammar: ["imported <n> rows, <n> events, <n> files"],
      sync: true,
      async run(args) {
        const { importVerb } = await import("../plans/import.ts");
        return importVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["plans", "show"],
      allow: true,
      usage:
        "skills plans show <Project> <id | ctx-slug> [--at <time>] | --conflict <Project> <id | ctx-slug>",
      grammar: ["<line copied from a plan or ctx file>"],
      async run(args) {
        const { showVerb } = await import("../plans/revisions.ts");
        return showVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["plans", "history"],
      allow: true,
      usage: "skills plans history <Project> <id | ctx-slug>",
      grammar: ["<recorded>\t<sha256>\t<machine>\t<bytes>[\t(fetching)]"],
      async run(args) {
        const { historyVerb } = await import("../plans/revisions.ts");
        return historyVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["plans", "checkout"],
      allow: true,
      usage: "skills plans checkout <Project> <id | ctx-slug>",
      grammar: ["<path> written", "<path> current"],
      sync: true,
      async run(args) {
        const { checkoutVerb } = await import("../plans/revisions.ts");
        return checkoutVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["recall"],
      allow: true,
      usage: "skills recall <query> [--project <Project>] [--limit <n>] [--json]",
      grammar: [
        "<Project>\t<ref>\t<section>\t<status>\t<snippet>\t<path>",
        '{"project", "ref", "section", "status", "snippet", "path", "recorded", "rank"}',
      ],
      async run(args) {
        const { recallVerb } = await import("../plans/recall-verb.ts");
        return recallVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["digest"],
      allow: true,
      usage: "skills digest [--week <YYYY-MM-DD>]",
      grammar: ["digest <year>-W<nn> written", "digest <year>-W<nn> exists"],
      sync: true,
      async run(args) {
        const { digestVerb } = await import("../plans/digest.ts");
        return digestVerb(args, this.usage, processIo());
      },
    },
    ...machineVerbs,
    ...issuesVerbs,
    {
      name: ["threads", "resume"],
      allow: true,
      usage: "skills threads resume [--facts]",
      grammar: [
        "off",
        "every <n>m",
        "read <branch> <pr url>",
        "skip <branch> <reason>",
        "nudge <branch> <cause> <thread> <run> <message>",
      ],
      async run(args) {
        const { threadsResumeVerb } = await import("../plans/threads.ts");
        return threadsResumeVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["threads", "log"],
      allow: true,
      usage: "skills threads log <branch> <start|handback|nudge> [detail]",
      grammar: [],
      sync: true,
      async run(args) {
        const { threadsLogVerb } = await import("../plans/threads.ts");
        return threadsLogVerb(args, this.usage, processIo());
      },
    },
    {
      ...verb(
        "close",
        "skills plans close [--dry-run] <Project> <id> <DONE|DROPPED> <note> [--sha <sha> | --no-merge]",
        [row, "landed: <landed line>", "<id> is already closed"],
        "closeVerb",
        true,
      ),
      sync: true,
    },
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
      sync: true,
      async run(args) {
        const { sweepVerb } = await import("../plans/sweep.ts");
        return sweepVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["plans", "release"],
      allow: false,
      usage: "skills plans release <Project> [--dry-run] [--facts]",
      grammar: [
        "released <id> <path>",
        "would release <id> <path>",
        "kept <id> <path>: <reason>",
        "released <n> of <m>",
        "would release <n> of <m>",
      ],
      async run(args) {
        const { releaseVerb } = await import("../plans/release.ts");
        return releaseVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["reap"],
      allow: false,
      usage: "skills reap (<Project> | --mine) [--dry-run]",
      grammar: [
        "reaped <kind> <name> <owner>",
        "would reap <kind> <name> <owner>",
        "kept <kind> <name> <owner>: <reason>",
        "skipped <kind>: <reason>",
        "reaped <n> of <m>",
        "would reap <n> of <m>",
      ],
      async run(args) {
        const { reapVerb } = await import("../plans/reap.ts");
        return reapVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["device"],
      allow: true,
      usage: "skills device ios|android [--type <type>]",
      grammar: ["<udid>", "emulator-<port>"],
      async run(args) {
        const { deviceVerb } = await import("../plans/device.ts");
        return deviceVerb(args, this.usage, processIo());
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
        "left <id> held by <label> since <time>",
        "left <id> needs <cap>,<cap>, [this machine has no facts yet, run skills machine refresh; ]run on <labels> | no known machine has it",
      ],
      sync: true,
      async run(args, ctx) {
        const { startVerb } = await import("../plans/stack-verbs.ts");
        return startVerb(args, this.usage, ctx.root, processIo());
      },
    },
    {
      name: ["plans", "pin"],
      allow: true,
      usage: "skills plans pin <Project> <id>... [--for <duration>]",
      grammar: ["pinned <id> until <time>", "pin <id> refused: <reason>"],
      sync: true,
      async run(args) {
        const { pinVerb } = await import("../plans/lease-verbs.ts");
        return pinVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["plans", "bind"],
      allow: true,
      usage: "skills plans bind <Project> | --clear",
      grammar: ["bound <path> to <Project>", "unbound <path>"],
      async run(args) {
        const { bindVerb } = await import("../plans/bind.ts");
        return bindVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["plans", "lease", "break"],
      allow: false,
      usage: "skills plans lease break <Project> <id>",
      grammar: ["broke lease of <label>"],
      sync: true,
      async run(args) {
        const { leaseBreakVerb } = await import("../plans/lease-verbs.ts");
        return leaseBreakVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["plans", "move"],
      allow: false,
      usage: "skills plans move <Project> <id> [--to <label | device id> | --file <path>]",
      grammar: [
        "moved <Project> <id> to <target>, <n> commits, <m> changed files, <k> untracked",
        "/plans do <id>",
        "move: the move waits to reach the hub, run skills hub sync",
      ],
      sync: true,
      async run(args) {
        const { moveVerb } = await import("../plans/move.ts");
        return moveVerb(args, this.usage, processIo());
      },
    },
    {
      name: ["plans", "adopt"],
      allow: false,
      usage: "skills plans adopt <Project> <id> [--file <path>]",
      grammar: ["adopted <Project> <id> into <checkout> on <branch>", "/plans do <id>"],
      sync: true,
      async run(args) {
        const { adoptVerb } = await import("../plans/adopt.ts");
        return adoptVerb(args, this.usage, processIo());
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
      sync: true,
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
