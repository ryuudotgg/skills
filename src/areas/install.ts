import type { Area } from "../registry.ts";
import { legacyWatch } from "../test/watch.ts";

export const testUsage =
  "skills test [--all | --list | --parity <suite> [--stub <path>=<command>]... | <name>...] [--jobs <n>]";

export const install: Area = {
  verbs: [
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
  ports: [],
  suites: [
    {
      name: "validate",
      argv: ["python3", "scripts/validate.py"],
      files: ["scripts/validate.py"],
      watch: ["**"],
      seconds: 0.2,
    },
    {
      name: "test-validate",
      argv: ["sh", "scripts/test-validate.sh"],
      files: ["scripts/test-validate.sh"],
      watch: ["**"],
      seconds: 2.7,
    },
    {
      name: "test-install",
      argv: ["sh", "scripts/test-install.sh"],
      files: ["scripts/test-install.sh"],
      watch: [
        ...legacyWatch,
        "install.sh",
        "hooks/**",
        "scripts/*.py",
        "agents/**",
        "README.md",
        "skills/playbook/references/delivery.md",
      ],
      seconds: 85.3,
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
      argv: ["bun", "test"],
      files: ["src/**/*.test.ts"],
      watch: ["skills/*/reviewer.conf"],
      seconds: 60,
    },
    {
      name: "typecheck",
      argv: ["bun", "run", "typecheck"],
      files: [],
      watch: [],
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
        "hooks/*.sh",
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
