import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  extensionVerdict,
  lines,
  overrideKey,
  type DeliveryConfig,
  type DeliveryMode,
} from "../delivery.ts";
import { readRuleGroups, type RuleGroup } from "../deny-set.ts";
import {
  declinedLevel,
  driftCategory,
  groupSummaries,
  parseLevels,
  withOverrides,
  type DriftCategory,
  type planClaudeRules,
} from "./claude-rules.ts";
import { codexSummaries, type planCodexRules } from "./codex-rules.ts";
import type { Choices } from "./install.ts";
import type { Change, Level, Levels, RulesChoice } from "./rules.ts";
import type { HookChange } from "./hooks-file.ts";
import { hookSummary } from "./claude-hooks.ts";
import type { HookTarget } from "./hook-table.ts";
import { isDeepStrictEqual } from "node:util";

type RulesPreview = (
  mode: DeliveryMode,
  choice: RulesChoice,
) => {
  conf: string;
  claude?: ReturnType<typeof planClaudeRules>;
  codex?: ReturnType<typeof planCodexRules>;
};

function previewed(preview: ReturnType<RulesPreview>) {
  return {
    claude: preview.claude?.kind === "plan" ? preview.claude.changes : [],
    codex: preview.codex?.kind === "plan" ? preview.codex.changes : [],
  };
}

const repo = resolve(import.meta.dir, "../..");
const clackModule = join(repo, "node_modules/@clack/prompts");
export function promptsInstalled(): boolean {
  return existsSync(clackModule);
}

async function prompts(): Promise<typeof import("@clack/prompts")> {
  if (promptsInstalled()) {
    try {
      return await import(Bun.resolveSync(clackModule, repo));
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

type RulesPlan = ReturnType<typeof planClaudeRules>;
export type DriftAnswer = {
  confirmed: Change[];
  overrides: Record<string, Level>;
  hooksDeclined: HookTarget[];
  hooksConfirmed: HookChange[];
};

type ReplanRules = (answer: DriftAnswer) => RulesPlan | undefined;

async function promptDrift(
  clack: typeof import("@clack/prompts"),
  plan: RulesPlan,
  changes: readonly Change[],
  cancels: boolean,
  replan: ReplanRules,
  hooks: readonly HookChange[] = plan.hooks.changes,
): Promise<DriftAnswer | undefined> {
  const byGroup = Map.groupBy(changes, (change) => change.group);
  const options: Record<DriftCategory, { value: string; label: string }[]> = {
    add: [],
    update: [],
    remove: [],
  };

  for (const { group, summary } of groupSummaries(changes)) {
    const label = plan.rules.groups.find(({ id }) => id === group)!.label;
    const weakening = byGroup.get(group)!.some((change) => change.class === "weakening");
    options[driftCategory(byGroup.get(group)!)].push({
      value: group,
      label: `${label}: ${summary}${weakening ? " (weakening)" : ""}`,
    });
  }

  const byHook = Map.groupBy(hooks, (change) => change.target);
  for (const [target, changes] of byHook)
    options[changes.every((change) => change.kind === "add") ? "add" : "update"].push({
      value: `hook:${target}`,
      label: changes.map(hookSummary).join(", "),
    });

  const headings = { add: "Add", update: "Update", remove: "Remove" } as const;
  const groups = [...byGroup.keys()];
  const ticked = await clack.groupMultiselect<string>({
    message: `${cancels ? `Changes to ${plan.path}` : `${plan.path} changed during the install`}. Untick a group${hooks.length ? " or hook" : ""} to keep it as it is${plan.rules.release && !hooks.length ? "" : `, saved to ${plan.conf}`}${cancels ? " (Esc cancels the whole install)" : ""}`,
    options: Object.fromEntries(
      (["add", "update", "remove"] as const)
        .filter((category) => options[category].length)
        .map((category) => [headings[category], options[category]]),
    ),
    initialValues: [...groups, ...[...byHook.keys()].map((target) => `hook:${target}`)],
    required: false,
    selectableGroups: false,
  });

  if (clack.isCancel(ticked)) return undefined;

  const answer: DriftAnswer = {
    hooksDeclined: [...byHook.keys()].filter((target) => !ticked.includes(`hook:${target}`)),
    hooksConfirmed: hooks.filter((change) => ticked.includes(`hook:${change.target}`)),
    confirmed: changes.filter((change) => ticked.includes(change.group)),
    overrides: Object.fromEntries(
      groups
        .filter((group) => !ticked.includes(group))
        .map((group) => [group, declinedLevel(plan.rules, group, byGroup.get(group)!)]),
    ),
  };

  if (answer.hooksDeclined.length) {
    const replanned = replan(answer);
    const rules = replanned?.kind === "plan" ? replanned.changes : [];
    if (!isDeepStrictEqual(rules, plan.changes))
      clack.note(
        groupSummaries(rules)
          .map(
            ({ group, summary }) =>
              `${plan.rules.groups.find(({ id }) => id === group)!.label}: ${summary}`,
          )
          .join("\n"),
        "Rules after hook declines",
      );
  }

  return answer;
}

export async function confirmDrift(
  plan: RulesPlan,
  changes: readonly Change[],
  cancels: boolean,
  replan: ReplanRules,
  hooks: readonly HookChange[] = plan.hooks.changes,
): Promise<DriftAnswer | undefined> {
  return promptDrift(await prompts(), plan, changes, cancels, replan, hooks);
}

async function promptRules(
  clack: typeof import("@clack/prompts"),
  groups: RuleGroup[],
  config: DeliveryConfig,
  mode: DeliveryMode,
  preview: RulesPreview,
): Promise<Pick<Choices, "rules" | "confirmed" | "codexConfirmed" | "hooksConfirmed"> | undefined> {
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
      { value: "off", label: "Don't manage", hint: "leave agent rules to you" },
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
    const removal = previewed(preview(mode, { ...rules, release: true }));
    removal.codex = removal.codex.filter((change) => change.from !== "absent");
    if (removal.claude.length || removal.codex.length) {
      const files = [
        ...(removal.claude.length ? ["settings.json"] : []),
        ...(removal.codex.length ? ["skills.rules"] : []),
      ];

      const action = await clack.select({
        message: `Owned rules in ${files.join(" and ")}`,
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
  const changes = previewed(result);
  const overrides = Object.entries(rules.levels.groups).map(
    ([id, level]) => `${overrideKey(id)}=${level}`,
  );

  const cleared = [...new Set(previous.map((line) => line.slice(0, line.indexOf("="))))].filter(
    (key) => !overrides.some((line) => line.startsWith(`${key}=`)),
  );

  const dropsOverride = previous.some(
    (line, index) => !overrides.includes(line) || previous.indexOf(line) !== index,
  );

  const conf = [
    `AGENT_RULES=${rules.levels.global}`,
    ...overrides,
    ...cleared.map((key) => `${key} cleared`),
  ];

  const claude = result.claude;
  const promptable = claude
    ? changes.claude.filter(
        (change) => claude.rules.groups.find(({ id }) => id === change.group)?.kind !== "retired",
      )
    : changes.claude;

  if (
    !promptable.length &&
    !claude?.hooks.changes.length &&
    !changes.codex.length &&
    !dropsOverride
  )
    return { rules };

  const label = (group: string) => groups.find(({ id }) => id === group)?.label ?? group;
  const codexLines = codexSummaries(changes.codex).map(({ change, summary }) => {
    const weakening = change.class === "weakening" ? " (weakening)" : "";
    return `Codex ${label(change.group)}: ${summary}${weakening}`;
  });

  const confLine = `${result.conf}: ${conf.join(", ")}`;
  const paths = [result.claude, result.codex].flatMap((plan) => plan?.path ?? []);
  const codexConfirmed = (declined: Readonly<Record<string, Level>> = {}) =>
    result.codex?.kind === "plan"
      ? changes.codex.filter((change) => !Object.hasOwn(declined, change.group))
      : undefined;

  if (claude && (promptable.length || claude.hooks.changes.length) && !rules.release) {
    const saved = lines(config.content).filter((line) => /^AGENT_RULES(?:_.*)?=/.test(line));
    if (codexLines.length || dropsOverride || saved.join("\n") !== conf.join("\n"))
      clack.note([...codexLines, confLine].join("\n"), paths.join(", "));

    const answer = await promptDrift(
      clack,
      claude,
      promptable,
      true,
      (answer) =>
        preview(mode, {
          ...rules,
          levels: withOverrides(rules.levels, answer.overrides),
          hooksDeclined: answer.hooksDeclined,
        }).claude,
    );

    if (!answer) return undefined;

    rules.levels = withOverrides(rules.levels, answer.overrides);
    rules.hooksDeclined = answer.hooksDeclined;
    return {
      rules,
      hooksConfirmed: answer.hooksConfirmed,
      confirmed: answer.confirmed,
      codexConfirmed: codexConfirmed(answer.overrides),
    };
  }

  const summaries = groupSummaries(promptable).map(({ group, summary }) => {
    const weakening = promptable.some(
      (change) => change.group === group && change.class === "weakening",
    );

    return `${label(group)}: ${summary}${weakening ? " (weakening)" : ""}`;
  });

  clack.note(
    [...summaries, ...(claude?.hooks.changes.map(hookSummary) ?? []), ...codexLines, confLine].join(
      "\n",
    ),
    paths.join(", "),
  );

  const confirmed = await clack.confirm({ message: "Apply these changes?" });
  if (clack.isCancel(confirmed) || !confirmed) return undefined;

  return {
    rules,
    hooksConfirmed: claude?.hooks.changes,
    confirmed: claude ? changes.claude : undefined,
    codexConfirmed: codexConfirmed(),
  };
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
