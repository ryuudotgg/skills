import { availableParallelism } from "node:os";
import type { Area } from "../registry.ts";

// A fixed 4 starved the 3 core macOS runner: --parallel already runs a worker per core.
const concurrentCases = Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)));

export const testUsage = "skills test [--all | --list | <name>...] [--jobs <n>]";

export const updateUsage = "skills update [--check]";

export const installUsage =
  "skills install [--with <name>]... [--without <name>]... [--arms <value>] [--auto-update off|notify|on] [--hub-url <url> [--hub-network public|tailscale|local]] [--verbose]";

export const install: Area = {
  verbs: [
    {
      name: ["install"],
      allow: false,
      usage: installUsage,
      grammar: [
        "mode   hands-off|prs",
        "with   <extension>",
        "warn   <path> (<reason>)",
        "config <path>",
        "skill  <name>",
        "agent  <name>",
        "claude add <event> <command>",
        "claude replace <event> <old> with <command>",
        "claude drop <event> <command> (<reason>)",
        "rules  <group> <summary>",
        "left   <group> <summary> (<reason>)",
        "codex  <group> <summary>",
        "codex  <path> (<reason>)",
        "left   codex <group> <summary> (<reason>)",
        "opencode <group> <summary>",
        "opencode <path>",
        "left   opencode <group> <summary> (<reason>)",
        "note   opencode <text>",
        "skip   opencode <group> <reason>",
        "note   <text>",
        "skip   <name> (<reason>)",
        "prune  <name>",
        "off    <name>",
        "unlink <name>",
        "hub    <url> (<mode>)",
        "next   <step>",
        "joining <url>, waiting for the inviting machine to accept",
        "enrolled",
      ],
      async run(args, ctx) {
        const { installVerb } = await import("../install/install.ts");
        return installVerb(args, ctx);
      },
    },
    {
      name: ["update"],
      allow: false,
      usage: updateUsage,
      grammar: [
        "updated v<old> -> v<new> <url>",
        "available v<new> <url>",
        "current v<version>",
        "refused <reason>",
      ],
      async run(args, ctx) {
        const { runUpdate } = await import("../update/update.ts");
        return runUpdate(args, this.usage, ctx.repo);
      },
    },
    {
      name: ["delivery"],
      allow: true,
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
      allow: true,
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
      name: ["arms"],
      allow: true,
      usage: "skills arms",
      grammar: [
        "<family> cli=yes|no [<tier>=<provider/model>[#variant]]...",
        "implementation=lead|codex|opencode",
      ],
      async run(_args) {
        const { armFamilies, readArms, tierTokens } = await import("../arms.ts");
        const { roster, implementation, notes } = readArms(process.env);
        for (const family of armFamilies.filter((family) => roster.families.includes(family))) {
          const cli = Bun.which(family, { PATH: process.env.PATH ?? "" }) ? "yes" : "no";
          const tiers = family === "opencode" ? tierTokens(roster) : [];
          process.stdout.write([family, `cli=${cli}`, ...tiers].join(" ") + "\n");
        }

        process.stdout.write(`implementation=${implementation}\n`);

        for (const note of notes) process.stderr.write(`arms: ${note}\n`);

        return 0;
      },
    },
    {
      name: ["test"],
      allow: false,
      usage: testUsage,
      grammar: [
        "ok <name> <seconds>s",
        "FAIL <name> <seconds>s",
        "flaky <file>: <test name>",
        "ok <n> suites",
        "ok <n> suites, <m> flaky",
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
      files: ["packages/cli/src/**/*.test.ts"],
      watch: [
        "packages/cli/src/**",
        "packages/core/src/**",
        "scripts/stubs/**",
        "skills/*/reviewer.conf",
        "skills/*/reviewer.ts",
        "skills/playbook/opencode/**",
        "apps/hub/src/**",
        "apps/hub/package.json",
        "apps/hub/compose*.yaml",
        "apps/dashboard/package.json",
        "evals/cases/plans-do-adopted/fixture/**",
        "evals/cases/plans-do-adopted/fixture/**/*.md",
        "evals/cases/plans-do-adopted/fixture/**/*.mdx",
        "evals/cases/plans-do-adopted/plans/pack.tar",
        "evals/cases/opencode-single-seats/fixture/**",
        "evals/cases/opencode-single-seats/opencode/**",
        "install.sh",
        "agents/*.md",
        "README.md",
        "CONTRIBUTING.md",
        "skills/playbook/playbooks/*.md",
        "skills/playbook/references/codex-arms.md",
        "skills/playbook/references/opencode-arms.md",
        "skills/playbook/references/rule-groups.md",
        "apps/docs/content/docs/agents/*.mdx",
      ],
      seconds: 70,
      graph: {
        sources: ["packages/cli/src/**/*.ts", "packages/core/src/**/*.ts"],
        unimported: [
          "packages/cli/src/evals/gh.ts",
          "packages/cli/src/test/preload.ts",
          "skills/*/reviewer.ts",
        ],
      },
    },
    {
      name: "core",
      cwd: "packages/core",
      argv: ["bun", "test"],
      files: ["packages/core/test/*.test.ts"],
      watch: ["packages/core/**"],
      seconds: 1,
    },
    {
      name: "typecheck",
      argv: ["bun", "run", "typecheck"],
      files: [],
      watch: [
        "packages/cli/src/**",
        "packages/core/**",
        "skills/*/reviewer.ts",
        "skills/playbook/opencode/**",
        "apps/dashboard/**",
        "apps/hub/**",
      ],
      seconds: 1,
    },
    {
      name: "lint",
      argv: ["bun", "run", "lint"],
      files: [],
      watch: [
        "packages/cli/src/**",
        "packages/core/**",
        "skills/*/reviewer.ts",
        "skills/playbook/opencode/**",
        "apps/docs/**",
        "apps/dashboard/**",
        "apps/hub/**",
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
        "packages/cli/src/**",
        "packages/core/**",
        "skills/*/reviewer.ts",
        "skills/playbook/opencode/**",
        "apps/docs/**",
        "apps/dashboard/**",
        "apps/hub/**",
        "apps/docs/**/*.md",
        "apps/docs/**/*.mdx",
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
        "packages/cli/src/**",
        "packages/core/**",
        "skills/*/reviewer.ts",
        "skills/playbook/opencode/**",
        "apps/docs/**",
        "apps/dashboard/**",
        "apps/hub/**",
        ".oxlintrc.json",
        ".oxfmtrc.json",
        "package.json",
      ],
      seconds: 3,
    },
    {
      name: "docs",
      cwd: "apps/docs",
      argv: ["bun", "--preload", "./scripts/preload.ts", "scripts/validate.ts"],
      files: [],
      seconds: 3,
      watch: [
        "apps/docs/**",
        "apps/docs/content/**/*.mdx",
        "apps/docs/content/**/*.md",
        "packages/cli/src/hooks/guards.ts",
        "packages/cli/src/deny-set.ts",
        "packages/cli/src/frontmatter.ts",
        "packages/cli/src/io.ts",
        "packages/cli/src/reviewers/declaration.ts",
        "agents/*.md",
        "skills/*/SKILL.md",
        "skills/playbook/playbooks/*.md",
        "skills/playbook/references/codex-arms.md",
        "skills/playbook/references/rule-groups.md",
        "skills/*/reviewer.conf",
      ],
    },
  ],
};
