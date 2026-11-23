import type { Area } from "../registry.ts";

export const evalUsage = "skills eval <case> [--grade] [--without <skills>]";

export const logUsage = "skills log <file> <project> <plan> <branch> <evidence> <result>";

export const auditUsage =
  "skills audit [-h] [--days DAYS] [--json] [--prs] [--project-dir PROJECT_DIR] [--compare OLD [NEW] | --digest]";

export const tools: Area = {
  verbs: [
    {
      name: ["check"],
      allow: true,
      usage: "skills check [<root>]",
      grammar: ["<file>:<line>: <message>", "<file>: <message>", "<n> error(s)", "ok"],
      async run(args, ctx) {
        if (args.length > 1 || args[0]?.startsWith("-")) {
          process.stderr.write(`usage: ${this.usage}\n`);
          return 2;
        }

        const { check } = await import("../check/check.ts");
        const errors = check(args[0] ?? ctx.repo, ctx);
        process.stdout.write(
          `${errors.length ? [...errors, `${errors.length} error(s)`].join("\n") : "ok"}\n`,
        );

        return errors.length ? 1 : 0;
      },
    },
    {
      name: ["eval"],
      allow: false,
      usage: evalUsage,
      grammar: [
        "transcript: <path>",
        "status:     <path>",
        "diff:       <path>",
        "remote:     <path>",
        "gh:         <path>",
        "expectations:",
        "LEAKED <name>",
        "HIDDEN <name>",
        "UNCHECKED <name>",
      ],
      sync: true,
      async run(args, ctx) {
        const { runEval } = await import("../evals/run.ts");
        return runEval(args, ctx);
      },
    },
    {
      name: ["log"],
      allow: false,
      usage: logUsage,
      grammar: [],
      async run(args) {
        const { logDecision } = await import("../decision-log.ts");
        return logDecision(args);
      },
    },
    {
      name: ["audit"],
      allow: true,
      usage: auditUsage,
      grammar: [
        "<JSON object>\\n",
        "Session audit, last <days> days through <iso>",
        "Saved <path>",
        "Compared with <path>",
        "Nothing to compare: no saved run before <name> in <dir>",
        "Audit compare, <iso> to <iso>",
        "<flag|ok|new|gone>  <field>  <old> to <new>[, <change>]",
        "<n> flagged",
      ],
      ownsHelp: true,
      async run(args) {
        const { audit } = await import("../audit/audit.ts");
        const result = await audit(args, {
          env: process.env,
          now: new Date(),
          cwd: process.cwd(),
          terminal: process.stdout.isTTY ? { width: process.stdout.columns || 80 } : undefined,
        });

        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);

        return result.code;
      },
    },
  ],
  suites: [],
};
