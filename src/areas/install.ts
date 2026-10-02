import type { Area } from "../registry.ts";

export const testUsage =
  "skills test [--all | --list | --parity <suite> [--stub <path>=<command>]... | <name>...] [--jobs <n>]";

export const install: Area = {
  verbs: [
    {
      name: ["install"],
      usage: "skills install [--with <name>]... [--without <name>]...",
      grammar: [
        "mode   hands-off|prs",
        "with   <extension>",
        "config <path>",
        "skill  <name>",
        "agent  <name>",
        "skip   <name> (<reason>)",
        "prune  <name>",
        "off    <name>",
        "unlink <name>",
      ],
      async run(args, ctx) {
        const { installVerb } = await import("../install/install.ts");
        return installVerb(args, ctx);
      },
    },
    {
      name: ["delivery"],
      usage: "skills delivery",
      grammar: ["hands-off|prs", "<extension>"],
      async run(_args, ctx) {
        const { realpathSync } = await import("node:fs");
        const { readDelivery } = await import("../delivery.ts");
        const result = readDelivery(realpathSync(ctx.root), process.env);
        process.stdout.write(`${[result.mode, ...result.active].join("\n")}\n`);
        for (const note of result.notes) process.stderr.write(`delivery-mode: ${note}\n`);

        return 0;
      },
    },
    {
      name: ["test"],
      usage: testUsage,
      grammar: [
        "ok <name> <seconds>s",
        "FAIL <name> <seconds>s",
        "ok <n> suites",
        "FAIL <k> of <n> suites",
        "<name>",
      ],
      async run(args, ctx) {
        const { runTest } = await import("../test/command.ts");
        return runTest(args, ctx);
      },
    },
  ],
  ports: [{ legacy: "skills/playbook/scripts/delivery-mode.sh", verb: ["delivery"] }],
  suites: [
    {
      name: "check",
      argv: ["sh", "skills/playbook/bin/skills", "check"],
      files: [],
      watch: ["**"],
      seconds: 0.2,
    },
    {
      name: "test-gh",
      argv: ["sh", "scripts/stubs/test-gh.sh"],
      files: ["scripts/stubs/test-gh.sh"],
      watch: ["scripts/stubs/**"],
      seconds: 0.1,
    },
    {
      name: "bun",
      argv: ["bun", "test", "--parallel", "--timeout=20000"],
      files: ["src/**/*.test.ts"],
      watch: [
        "src/**",
        "skills/*/reviewer.conf",
        "install.sh",
        "agents/**",
        "README.md",
        "skills/playbook/references/delivery.md",
        "docs/content/docs/agents/*.mdx",
      ],
      seconds: 70,
    },
    {
      name: "typecheck",
      argv: ["bun", "run", "typecheck"],
      files: [],
      watch: ["src/**"],
      seconds: 1,
    },
    {
      name: "docs",
      cwd: "docs",
      argv: [
        "sh",
        "-c",
        "bun install --frozen-lockfile --silent && bun --preload ./scripts/preload.ts scripts/validate.ts",
      ],
      files: [],
      seconds: 3,
      watch: [
        "docs/**",
        "docs/content/**/*.mdx",
        "docs/content/**/*.md",
        "src/hooks/guards.ts",
        "src/deny-set.ts",
        "src/reviewers/declaration.ts",
        "agents/*.md",
        "skills/*/SKILL.md",
        "skills/playbook/playbooks/*.md",
        "skills/playbook/references/codex-arms.md",
        "skills/playbook/references/delivery.md",
        "skills/*/reviewer.conf",
      ],
    },
  ],
};
