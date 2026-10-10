import { availableParallelism } from "node:os";
import type { Area } from "../registry.ts";

// A fixed 4 starved the 3 core macOS runner: --parallel already runs a worker per core.
const concurrentCases = Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)));

export const testUsage = "skills test [--all | --list | <name>...] [--jobs <n>]";

export const install: Area = {
  verbs: [
    {
      name: ["install"],
      usage: "skills install [--with <name>]... [--without <name>]...",
      grammar: [
        "mode   hands-off|prs",
        "with   <extension>",
        "warn   <path> (<reason>)",
        "config <path>",
        "skill  <name>",
        "agent  <name>",
        "rules  <group> <summary>",
        "left   <group> <summary> (<reason>)",
        "note   <text>",
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
      name: ["fast-mode"],
      usage: "skills fast-mode",
      grammar: ["codex=yes|no", "claude=yes|no"],
      async run(_args) {
        const { readFastModes } = await import("../fast-mode.ts");
        const result = readFastModes(process.env);
        process.stdout.write(
          Object.entries(result.modes)
            .map(([provider, on]) => `${provider}=${on ? "yes" : "no"}\n`)
            .join(""),
        );

        for (const note of result.notes) process.stderr.write(`fast-mode: ${note}\n`);

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
  suites: [
    {
      name: "check",
      argv: ["sh", "skills/playbook/bin/skills", "check"],
      files: [],
      watch: ["**"],
      seconds: 0.2,
    },
    {
      name: "bun",
      argv: [
        "bun",
        "test",
        "--parallel",
        "--timeout=20000",
        `--max-concurrency=${concurrentCases}`,
      ],
      files: ["src/**/*.test.ts"],
      watch: [
        "src/**",
        "scripts/stubs/**",
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
      name: "lint",
      argv: ["bun", "run", "lint"],
      files: [],
      watch: [
        "src/**",
        "skills/*/reviewer.ts",
        "docs/**",
        ".oxlintrc.json",
        ".oxfmtrc.json",
        "package.json",
      ],
      seconds: 1,
    },
    {
      name: "format",
      argv: ["bun", "run", "format"],
      files: [],
      watch: [
        "src/**",
        "skills/*/reviewer.ts",
        "docs/**",
        "docs/**/*.md",
        "docs/**/*.mdx",
        ".oxlintrc.json",
        ".oxfmtrc.json",
        "package.json",
      ],
      seconds: 2,
    },
    {
      name: "stanza",
      argv: ["bun", "run", "stanza"],
      files: [],
      watch: [
        "src/**",
        "skills/*/reviewer.ts",
        "docs/**",
        ".oxlintrc.json",
        ".oxfmtrc.json",
        "package.json",
      ],
      seconds: 3,
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
        "src/frontmatter.ts",
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
