import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  armFamilies,
  defaultRoster,
  readOpencodeCatalog,
  rosterChange,
  rosterFrom,
  type Family,
  type OpencodeCatalog,
  type Roster,
} from "../arms.ts";
import {
  extensionVerdict,
  lines,
  overrideKey,
  type DeliveryConfig,
  type DeliveryMode,
} from "../delivery.ts";
import { readRuleGroups, type RuleGroup } from "../deny-set.ts";
import { tilde } from "../terminal.ts";
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
import {
  openCodeSummaries,
  type OpenCodeChange,
  type planOpenCodeRules,
} from "./opencode-rules.ts";
import type { Choices } from "./install.ts";
import type { Change, Level, Levels, RulesChoice } from "./rules.ts";
import type { HookChange } from "./hooks-file.ts";
import { hookSummary } from "./claude-hooks.ts";
import type { HookTarget } from "./hook-table.ts";
import { autoUpdateChange, readAutoUpdate, type AutoUpdate } from "../update/auto-update.ts";
import { isDeepStrictEqual, styleText } from "node:util";

type RulesPreview = (
  mode: DeliveryMode,
  choice: RulesChoice,
) => {
  conf: string;
  claude?: ReturnType<typeof planClaudeRules>;
  codex?: ReturnType<typeof planCodexRules>;
  opencode?: ReturnType<typeof planOpenCodeRules>;
};

function previewed(preview: ReturnType<RulesPreview>) {
  return {
    claude: preview.claude?.kind === "plan" ? preview.claude.changes : [],
    codex: preview.codex?.kind === "plan" ? preview.codex.changes : [],
    opencode: preview.opencode?.kind === "plan" ? preview.opencode.changes : [],
  };
}

const repo = resolve(import.meta.dir, "../..");
const clackModules = ["prompts", "core"].map((name) => join(repo, "node_modules/@clack", name));
export function promptsInstalled(): boolean {
  return clackModules.every((path) => existsSync(path));
}

type Clack = typeof import("@clack/prompts") &
  Pick<typeof import("@clack/core"), "GroupMultiSelectPrompt" | "wrapTextWithPrefix">;

async function prompts(): Promise<Clack> {
  if (promptsInstalled()) {
    try {
      const [clack, core] = await Promise.all(
        clackModules.map((path) => import(Bun.resolveSync(path, repo))),
      );

      return {
        ...clack,
        GroupMultiSelectPrompt: core.GroupMultiSelectPrompt,
        wrapTextWithPrefix: core.wrapTextWithPrefix,
      };
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

function short(path: string): string {
  return tilde(process.env.HOME ?? "")(path);
}

function byFile(files: readonly (readonly [string | undefined, readonly string[]])[]): string {
  return files
    .flatMap(([path, lines]) =>
      path && lines.length ? [short(path), ...lines.map((line) => `  ${line}`)] : [],
    )
    .join("\n");
}

type Choice = { value: string; label: string };

// clack's groupMultiselect echoes every ticked label on submit and has no option to change that.
async function checklist(clack: Clack, message: string, options: Record<string, Choice[]>) {
  const values = Object.values(options).flatMap((choices) => choices.map(({ value }) => value));
  const count = (ticked: number) =>
    `${ticked < values.length ? `${ticked} of ` : ""}${values.length} change${values.length === 1 ? "" : "s"}`;

  const answer = await new clack.GroupMultiSelectPrompt<Choice>({
    options,
    initialValues: values,
    required: false,
    selectableGroups: false,
    render() {
      const head = `${styleText("gray", clack.S_BAR)}\n${clack.wrapTextWithPrefix(
        process.stdout,
        message,
        `${clack.symbolBar(this.state)}  `,
        `${clack.symbol(this.state)}  `,
      )}\n`;

      const value = this.value ?? [];
      const done = `${styleText("gray", clack.S_BAR)}  `;
      if (this.state === "submit") return `${head}${done}${styleText("dim", count(value.length))}`;
      if (this.state === "cancel")
        return `${head}${done}${styleText(["strikethrough", "dim"], count(value.length))}\n${styleText("gray", clack.S_BAR)}`;

      const bar = `${styleText("cyan", clack.S_BAR)}  `;
      const footer = clack.formatInstructionFooter(clack.MULTISELECT_INSTRUCTIONS, true);
      const rows = clack.limitOptions({
        options: this.options,
        cursor: this.cursor,
        columnPadding: 3,
        rowPadding: head.split("\n").length + footer.length + 1,
        style: (option, active) => {
          if (option.group === true) return ` ${styleText("dim", option.label)}`;

          const box = value.includes(option.value)
            ? styleText("green", clack.S_CHECKBOX_SELECTED)
            : active
              ? styleText("cyan", clack.S_CHECKBOX_ACTIVE)
              : styleText("dim", clack.S_CHECKBOX_INACTIVE);

          return `  ${box} ${active ? option.label : styleText("dim", option.label)}`;
        },
      });

      return `${head}${bar}${rows.join(`\n${bar}`)}\n${footer.join("\n")}\n`;
    },
  }).prompt();

  return answer ?? [];
}

async function promptDrift(
  clack: Clack,
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
  const ticked = await checklist(
    clack,
    cancels
      ? `Changes to ${short(plan.path)} (Esc cancels the whole install)`
      : `${short(plan.path)} changed during the install`,
    Object.fromEntries(
      (["add", "update", "remove"] as const)
        .filter((category) => options[category].length)
        .map((category) => [headings[category], options[category]]),
    ),
  );

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

export async function confirmOpenCodeDrift(
  plan: Extract<ReturnType<typeof planOpenCodeRules>, { kind: "plan" }>,
  changes: OpenCodeChange[],
): Promise<OpenCodeChange[] | undefined> {
  const clack = await prompts();
  clack.note(
    byFile([
      [
        plan.path,
        openCodeSummaries(changes).map(
          ({ change, summary }) =>
            `${plan.slots.find((slot) => slot.group.id === change.group)!.group.label}: ${summary} (weakening)`,
        ),
      ],
    ]),
    "Changes",
  );

  const answer = await clack.confirm({ message: "Apply these OpenCode changes?" });
  if (clack.isCancel(answer)) return undefined;

  return answer ? changes : [];
}

async function promptRules(
  clack: Clack,
  groups: RuleGroup[],
  config: DeliveryConfig,
  mode: DeliveryMode,
  preview: RulesPreview,
  arms: Roster,
  autoUpdate: AutoUpdate,
): Promise<
  | Pick<Choices, "rules" | "confirmed" | "codexConfirmed" | "opencodeConfirmed" | "hooksConfirmed">
  | undefined
> {
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
    removal.opencode = removal.opencode.filter((change) => change.from !== "absent");
    if (removal.claude.length || removal.codex.length || removal.opencode.length) {
      const files = [
        ...(removal.claude.length ? ["settings.json"] : []),
        ...(removal.codex.length ? ["skills.rules"] : []),
        ...(removal.opencode.length ? ["OpenCode global config"] : []),
      ];

      const action = await clack.select({
        message: `Owned rules in ${files.length > 1 ? `${files.slice(0, -1).join(", ")} and ${files.at(-1)}` : files[0]}`,
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

  const armsRows = rosterChange(config.content, arms) ?? [];
  const armsChanged = armsRows.length > 0;
  const autoUpdateRows = autoUpdateChange(config.content, autoUpdate) ?? [];

  const conf = [
    `AGENT_RULES=${rules.levels.global}`,
    ...overrides,
    ...cleared.map((key) => `${key} cleared`),
    ...(armsChanged ? armsRows : []),
    ...autoUpdateRows,
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
    !changes.opencode.length &&
    !dropsOverride &&
    !armsChanged
  )
    return { rules };

  const label = (group: string) => groups.find(({ id }) => id === group)?.label ?? group;
  const codexLines = codexSummaries(changes.codex).map(({ change, summary }) => {
    const weakening = change.class === "weakening" ? " (weakening)" : "";
    return `${label(change.group)}: ${summary}${weakening}`;
  });

  const opencodeLines = openCodeSummaries(changes.opencode).map(({ change, summary }) => {
    const weakening = change.class === "weakening" ? " (weakening)" : "";
    return `${label(change.group)}: ${summary}${weakening}`;
  });

  const hostLines = [...codexLines, ...opencodeLines];
  const others = [
    [result.codex?.path, codexLines],
    [result.opencode?.path, opencodeLines],
    [result.conf, conf],
  ] as const;

  const codexConfirmed = (declined: Readonly<Record<string, Level>> = {}) =>
    result.codex?.kind === "plan"
      ? changes.codex.filter((change) => !Object.hasOwn(declined, change.group))
      : undefined;

  const opencodeConfirmed = (declined: Readonly<Record<string, Level>> = {}) =>
    result.opencode?.kind === "plan"
      ? changes.opencode.filter((change) => !Object.hasOwn(declined, change.group))
      : undefined;

  if (claude && (promptable.length || claude.hooks.changes.length) && !rules.release) {
    const saved = lines(config.content).filter((line) => /^AGENT_RULES(?:_.*)?=/.test(line));
    if (
      hostLines.length ||
      dropsOverride ||
      armsChanged ||
      autoUpdateRows.length ||
      saved.join("\n") !== conf.join("\n")
    )
      clack.note(byFile(others), "Changes");

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
      opencodeConfirmed: opencodeConfirmed(answer.overrides),
    };
  }

  const summaries = groupSummaries(promptable).map(({ group, summary }) => {
    const weakening = promptable.some(
      (change) => change.group === group && change.class === "weakening",
    );

    return `${label(group)}: ${summary}${weakening ? " (weakening)" : ""}`;
  });

  clack.note(
    byFile([
      [claude?.path, [...summaries, ...(claude?.hooks.changes.map(hookSummary) ?? [])]],
      ...others,
    ]),
    "Changes",
  );

  const confirmed = await clack.confirm({ message: "Apply these changes?" });
  if (clack.isCancel(confirmed) || !confirmed) return undefined;

  return {
    rules,
    hooksConfirmed: claude?.hooks.changes,
    confirmed: claude ? changes.claude : undefined,
    codexConfirmed: codexConfirmed(),
    opencodeConfirmed: opencodeConfirmed(),
  };
}

async function promptArms(clack: Clack, config: DeliveryConfig): Promise<Roster | undefined> {
  const saved = rosterFrom(config);
  for (const note of saved.notes) clack.log.warn(note);

  const available = Boolean(Bun.which("opencode", { PATH: process.env.PATH ?? "" }));
  const families = await clack.multiselect<Family>({
    message: "Arms for delegated work",
    options: armFamilies.map((family) => ({
      value: family,
      label: { claude: "Claude", codex: "Codex", opencode: "OpenCode" }[family],
      ...(family === "opencode" && !available
        ? { disabled: true, hint: "opencode is not on PATH" }
        : {}),
    })),
    initialValues: saved.roster.families.length ? saved.roster.families : defaultRoster.families,
    required: true,
  });

  if (clack.isCancel(families)) return undefined;

  const roster: Roster = { families, opencode: {} };
  if (!available) {
    if (saved.roster.families.includes("opencode")) {
      clack.log.info("opencode is not on PATH, keeping the saved OpenCode roster");
      if (!roster.families.includes("opencode")) roster.families.push("opencode");
      roster.opencode = saved.roster.opencode;
    }

    return roster;
  }

  if (!families.includes("opencode")) return roster;

  let catalog: OpencodeCatalog;
  try {
    catalog = await readOpencodeCatalog(process.env);
  } catch (error) {
    clack.log.warn(
      `${(error as Error).message}, ${saved.roster.families.includes("opencode") ? "keeping the saved OpenCode roster" : "OpenCode not added"}`,
    );

    if (saved.roster.families.includes("opencode")) roster.opencode = saved.roster.opencode;
    else roster.families = families.filter((family) => family !== "opencode");

    return roster.families.length ? roster : saved.roster;
  }

  for (const tier of ["sol", "terra", "luna", "astra"] as const) {
    const previous = saved.roster.opencode[tier];
    const options = [
      ...(tier === "sol"
        ? []
        : [
            {
              value: "",
              label:
                tier === "astra"
                  ? "none"
                  : `none, ${tier === "luna" && roster.opencode.terra ? "terra" : "sol"} serves it`,
            },
          ]),
      ...catalog.map(({ model }) => ({ value: model, label: model })),
    ];

    if (previous && !catalog.some(({ model }) => model === previous.model))
      clack.log.warn(`OpenCode ${tier} model ${previous.model} is no longer in the catalog`);

    const model = await clack.select({
      message: `OpenCode ${tier} model`,
      options,
      initialValue: options.some(({ value }) => value === previous?.model)
        ? previous!.model
        : options[0]!.value,
    });

    if (clack.isCancel(model)) return undefined;
    if (!model) continue;

    const variants = catalog.find((entry) => entry.model === model)!.variants;
    const variant = variants.length
      ? await clack.select({
          message: `OpenCode ${tier} variant`,
          options: [
            ...variants.map((value) => ({ value, label: value })),
            { value: "", label: "model default" },
          ],
          initialValue:
            previous?.model !== model
              ? variants[0]
              : previous.variant === undefined
                ? ""
                : variants.includes(previous.variant)
                  ? previous.variant
                  : variants[0],
        })
      : undefined;

    if (clack.isCancel(variant)) return undefined;

    roster.opencode[tier] = { model, ...(variant ? { variant } : {}) };
  }

  return roster;
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

  const saved = readAutoUpdate(config.content);
  const autoUpdate = await clack.select<AutoUpdate>({
    message: "Auto update",
    initialValue: saved.kind === "set" ? saved.value : "notify",
    options: [
      { value: "off", label: "Off: never check for releases" },
      { value: "notify", label: "Notify: check daily and say when a release is out" },
      {
        value: "on",
        label: "On: install each release, whose code then runs in every hook without asking",
      },
    ],
  });

  if (clack.isCancel(autoUpdate)) return undefined;

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

  const arms = await promptArms(clack, config);
  if (!arms) return undefined;

  const rules = preview
    ? await promptRules(clack, readRuleGroups(root), config, mode, preview, arms, autoUpdate)
    : {};

  if (!rules) return undefined;

  return {
    ...rules,
    arms,
    autoUpdate,
    with: [...(mode === "prs" ? ["prs"] : []), ...selected],
    without: [
      ...(mode === "hands-off" ? ["prs"] : []),
      ...config.names.filter((name) => name !== "prs" && !selected.includes(name)),
    ],
  };
}
