import type { Area } from "../registry.ts";
import { testVerb } from "../test/command.ts";
import { legacyWatch } from "../test/watch.ts";

export const install: Area = {
  verbs: [testVerb],
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
      watch: [],
      seconds: 20,
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
        "skills/playbook/scripts/reviewers.sh",
        "skills/playbook/scripts/deny-set.sh",
        "skills/*/reviewer.conf",
      ],
    },
  ],
};
