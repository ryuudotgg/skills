import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { extensionVerdict, lines, type DeliveryConfig, type DeliveryMode } from "../delivery.ts";
import { readRuleGroups, type RuleGroup } from "../deny-set.ts";
import { groupSummaries, parseLevels, type planClaudeRules } from "./claude-rules.ts";
import type { Choices } from "./install.ts";
import type { Level, Levels, RulesChoice } from "./rules.ts";

type RulesPreview = (mode: DeliveryMode, choice: RulesChoice) => ReturnType<typeof planClaudeRules>;

async function prompts(): Promise<typeof import("@clack/prompts")> {
  const repo = resolve(import.meta.dir, "../..");
  const module = join(repo, "node_modules/@clack/prompts");
  if (existsSync(module)) {
    try {
      return await import(Bun.resolveSync(module, repo));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }

  if (process.env.SKILLS_INSTALL_DEPENDENCIES_INSTALLED)
    throw new Error("install.sh: could not load interactive dependencies after installing them");

  const execve = process.execve;
  if (!execve) throw new Error("install.sh: could not restart for fresh module resolution");

  const child = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], {
    cwd: repo,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  if ((await child.exited) !== 0)
    throw new Error("install.sh: could not install interactive dependencies");

  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

  env.SKILLS_INSTALL_DEPENDENCIES_INSTALLED = "1";
  execve(
    process.execPath,
    [
      process.execPath,
      "--no-env-file",
      `--config=${join(repo, "bunfig.toml")}`,
      ...process.argv.slice(1),
    ],
    env,
  );

  throw new Error("install.sh: could not restart for fresh module resolution");
}

async function promptRules(
  clack: typeof import("@clack/prompts"),
  groups: RuleGroup[],
  config: DeliveryConfig,
  mode: DeliveryMode,
  preview: RulesPreview,
): Promise<Pick<Choices, "rules" | "confirmed"> | undefined> {
  const saved = parseLevels(config.content, groups).levels;
  const previous = lines(config.content).filter((line) => /^AGENT_RULES_.*=/.test(line));
  const initial = previous.length ? "customize" : (saved?.global ?? "deny");

  const selected = await clack.select<Levels["global"] | "customize">({
    message: "Rules level (Esc cancels the whole install)",
    initialValue: initial,
    options: [
      { value: "deny", label: "Deny" },
      {
        value: "ask",
        label: "Ask",
        hint: "still prompts in bypass mode, refuses in headless runs",
      },
      { value: "customize", label: "Customize" },
      { value: "off", label: "Don't manage", hint: "leave settings.json rules to you" },
    ],
  });

  if (clack.isCancel(selected)) return undefined;

  const rules: RulesChoice = { levels: { global: "deny", groups: {} }, release: false };
  if (selected === "customize") {
    const global = await clack.select<Levels["global"]>({
      message: "Default rules level",
      initialValue: saved?.global ?? "deny",
      options: [
        { value: "deny", label: "Deny" },
        { value: "ask", label: "Ask" },
        { value: "off", label: "Off" },
      ],
    });

    if (clack.isCancel(global)) return undefined;

    const overrides: Record<string, Level> = {};
    for (const group of groups) {
      if (group.kind === "retired") continue;

      const base = group.kind === "allow" && global !== "off" ? "allow" : global;
      const levels: Level[] = group.kind === "allow" ? ["allow", "off"] : ["deny", "ask", "off"];
      const level = await clack.select<Level>({
        message: group.label,
        initialValue: saved?.groups[group.id] ?? base,
        options: levels.map((value) => ({
          value,
          label: value[0]!.toUpperCase() + value.slice(1),
          hint: `${group.cells[mode]} in ${mode} mode`,
        })),
      });

      if (clack.isCancel(level)) return undefined;
      if (level !== base || Object.hasOwn(saved?.groups ?? {}, group.id))
        overrides[group.id] = level;
    }

    rules.levels = { global, groups: overrides };
  } else rules.levels = { global: selected, groups: {} };

  if (selected === "off") {
    const removal = preview(mode, { ...rules, release: true });
    if (removal.kind === "plan" && removal.changes.length) {
      const action = await clack.select({
        message: "Owned rules in settings.json",
        initialValue: "leave",
        options: [
          { value: "remove", label: "Remove owned entries" },
          { value: "leave", label: "Leave entries in place" },
        ],
      });

      if (clack.isCancel(action)) return undefined;

      rules.release = action === "remove";
    }
  }

  const result = preview(mode, rules);
  const changes = result.kind === "plan" ? result.changes : [];
  const overrides = Object.entries(rules.levels.groups).map(
    ([id, level]) => `AGENT_RULES_${id.toUpperCase().replaceAll("-", "_")}=${level}`,
  );

  const cleared = [...new Set(previous.map((line) => line.slice(0, line.indexOf("="))))].filter(
    (key) => !overrides.some((line) => line.startsWith(`${key}=`)),
  );

  const dropsOverride = previous.some(
    (line, index) => !overrides.includes(line) || previous.indexOf(line) !== index,
  );

  if (!changes.length && !dropsOverride) return { rules };

  const summaries = groupSummaries(changes).map(({ group, summary }) => {
    const label = groups.find(({ id }) => id === group)!.label;
    const weakening = changes.some(
      (change) => change.group === group && change.class === "weakening",
    );

    return `${label}: ${summary}${weakening ? " (weakening)" : ""}`;
  });

  const conf = [
    `AGENT_RULES=${rules.levels.global}`,
    ...overrides,
    ...cleared.map((key) => `${key} cleared`),
  ];

  clack.note(
    [...summaries, `${result.conf}: ${conf.join(", ")}`].join("\n"),
    result.kind === "plan" ? result.file.path : result.path,
  );

  const confirmed = await clack.confirm({ message: "Apply these changes?" });
  if (clack.isCancel(confirmed) || !confirmed) return undefined;

  return { rules, confirmed: result.kind === "plan" ? changes : undefined };
}

export async function promptChoices(
  root: string,
  config: DeliveryConfig,
  preview?: RulesPreview,
): Promise<Choices | undefined> {
  const clack = await prompts();
  const mode = await clack.select<DeliveryMode>({
    message: "Delivery mode",
    initialValue: config.mode,
    options: [
      { value: "hands-off", label: "hands-off" },
      { value: "prs", label: "prs" },
    ],
  });

  if (clack.isCancel(mode)) return undefined;

  const options = readdirSync(root)
    .filter((name) => {
      const requires = extensionVerdict(join(root, name, "SKILL.md"));
      return requires === "none" || (requires === "prs" && mode === "prs");
    })
    .sort();

  const selected = options.length
    ? await clack.multiselect<string>({
        message: "Optional skills and reviewers",
        options: options.map((name) => ({ value: name, label: name })),
        initialValues: config.names.filter((name) => options.includes(name)),
        required: false,
      })
    : [];

  if (clack.isCancel(selected)) return undefined;

  const rules = preview
    ? await promptRules(clack, readRuleGroups(root), config, mode, preview)
    : {};

  if (!rules) return undefined;

  return {
    ...rules,
    with: [...(mode === "prs" ? ["prs"] : []), ...selected],
    without: [
      ...(mode === "hands-off" ? ["prs"] : []),
      ...config.names.filter((name) => name !== "prs" && !selected.includes(name)),
    ],
  };
}
