import type { Area } from "../registry.ts";

export const tools: Area = {
  verbs: [
    {
      name: ["check"],
      usage: "skills check [<root>]",
      grammar: ["<file>:<line>: <message>", "<file>: <message>", "<n> error(s)", "ok"],
      async run(args, ctx) {
        if (args.length === 1 && args[0] === "--help") {
          process.stdout.write("skills check [<root>]\n");
          return 0;
        }

        if (args.length > 1 || args[0]?.startsWith("-")) {
          process.stderr.write("usage: skills check [<root>]\n");
          return 2;
        }

        const { check } = await import("../check/check.ts");
        const errors = check(args[0] ?? ctx.repo, ctx);
        process.stdout.write(`${errors.length ? [...errors, `${errors.length} error(s)`].join("\n") : "ok"}\n`);

        return errors.length ? 1 : 0;
      },
    },
    {
      name: ["eval"],
      usage: "skills eval <case> [--grade]",
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
      async run(args, ctx) {
        const { runEval } = await import("../evals/run.ts");
        return runEval(args, ctx);
      },
    },
    {
      name: ["log"],
      usage: "skills log <file> <project> <plan> <branch> <evidence> <result>",
      grammar: [],
      async run(args) {
        const { logDecision } = await import("../decision-log.ts");
        return logDecision(args);
      },
    },
    {
      name: ["audit"],
      usage: "skills audit [--days N] [--json] [--project-dir D]",
      grammar: ["<JSON object>\\n", "Session audit, last <days> days through <iso>"],
      async run(args) {
        const { audit } = await import("../audit/audit.ts");
        const result = audit(args, { env: process.env, now: new Date(), cwd: process.cwd() });
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);

        return result.code;
      },
    },
  ],
  ports: [{ legacy: "scripts/validate.py", verb: ["check"] }],
  suites: [],
};
