import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  armFamilies,
  readArms,
  tierTokens,
  type Family,
  type Implementer,
  type Roster,
} from "../arms.ts";
import { readDelivery, type DeliveryMode } from "../delivery.ts";
import { readFastModes } from "../fast-mode.ts";
import type { Io } from "../io.ts";
import { indexPath, missingIndex, projectDir, readIndex } from "./index-tsv.ts";
import { surfaceValue } from "./lint.ts";

export const routes = {
  "bug-fix": { sized: true },
  feature: { sized: true },
  refactoring: { sized: true },
  "perf-issue": { sized: true },
  investigation: { sized: false },
  prototype: { sized: false },
} as const;

export type Route = keyof typeof routes;

export type Line = { kind: "value"; key: string; value: string } | { kind: "copy"; text: string };

export type Plan = {
  id: string;
  slug: string;
  project: string;
  effort: string;
  critical: boolean;
  surface: string;
  probe: string[];
};

export type Setup = {
  skills: string;
  agents: string;
  bin: string;
  delivery: { mode: DeliveryMode; active: readonly string[] };
  arms: { roster: Roster; implementation: Implementer; cli: ReadonlySet<Family> };
  fast: { codex: boolean; claude: boolean };
};

const COLUMNS = [
  "`how`",
  "`architect`",
  "design opinion",
  "implementation",
  "review arms",
  "comment sweep",
];
const DROPPED_CELLS = new Set(["skip", "none", "hooks only"]);
const HANDBACK_STEP = /^\d+\. Run `handing-back\.md`\.$/;

function value(key: string, text: string): Line {
  return { kind: "value", key, value: text };
}

function copy(text: string): Line {
  return { kind: "copy", text };
}

function fileLines(path: string): string[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function cells(line: string): string[] {
  return line
    .trim()
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function ticked(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z-]*)`/g)].map((match) => match[1]!);
}

type FastPath = {
  header: string;
  row: string;
  columns: string[];
  cells: string[];
  dropped: string[];
  tokens: Set<string>;
};

export function fastPath(skills: string, effort: string): FastPath {
  const path = join(skills, "playbook/playbooks/backlog-item.md");
  const lines = fileLines(path);
  const start = lines.findIndex((line) => cells(line)[0] === "effort");
  if (start < 0) throw new Error(`${path}: no fast path table`);

  const columns = cells(lines[start]!).slice(1);
  const missing = COLUMNS.filter(
    (name) => columns.filter((column) => column === name).length !== 1,
  );

  if (missing.length)
    throw new Error(`${path}: fast path table needs one ${missing.join(", ")} column`);

  const rows: string[] = [];
  for (let index = start + 2; lines[index]?.trim().startsWith("|"); index++)
    rows.push(lines[index]!);

  const row = rows.find((line) => cells(line)[0] === effort);
  if (!row) throw new Error(`${path}: no fast path row for effort ${effort}`);

  const own = cells(row).slice(1);
  if (own.length !== columns.length) throw new Error(`${path}: fast path row ${effort} is ragged`);

  const dropped = columns.filter((_, index) => DROPPED_CELLS.has(own[index]!));
  const named = new Set(own.flatMap(ticked));
  const headed = ticked(lines[start]!);
  const unnamed = rows
    .flatMap((line) => cells(line).slice(1).flatMap(ticked))
    .filter((token) => !named.has(token) && !headed.includes(token));

  const tokens = new Set([...dropped.flatMap(ticked), ...unnamed]);
  return { header: lines[start]!, row, columns, cells: own, dropped, tokens };
}

type Seat = { role: string; arm: string; family: string; transport: string };

function agentsIn(cell: string, setup: Setup): string[] {
  return ticked(cell).filter((name) => existsSync(join(setup.agents, `${name}.md`)));
}

function codexTransport(setup: Setup): string {
  return setup.arms.cli.has("codex") ? "harness delegation, else codex cli" : "harness delegation";
}

function codexTier(setup: Setup): string {
  return `service tier ${setup.fast.codex ? "priority" : "default"}`;
}

function lineage(model: string): string {
  const name = model.split("/").at(-1)!;
  if (name.startsWith("gpt-")) return "codex";
  if (name.startsWith("claude-")) return "claude";
  return name.split("-")[0]!;
}

function claudeSeat(role: string, arm: string, setup: Setup): Seat[] {
  if (!setup.arms.roster.families.includes("claude")) return [];

  const transport = setup.fast.claude
    ? "harness delegation if it lists fastMode, else task"
    : "task";

  return [{ role, arm, family: "claude", transport }];
}

function reviewArm(fallback: string, plan: Plan, setup: Setup): Seat[] {
  const { roster } = setup.arms;
  const tier = plan.critical ? "astra" : "sol";
  if (roster.families.includes("codex")) {
    const arm = `${tier} high, ${codexTier(setup)}`;
    if (setup.arms.cli.has("codex"))
      return [{ role: "review arm", arm, family: "codex", transport: codexTransport(setup) }];

    const withoutCodex = { families: roster.families.filter((family) => family !== "codex") };
    const [other] = reviewArm(fallback, plan, {
      ...setup,
      arms: { ...setup.arms, roster: { ...roster, ...withoutCodex } },
    });

    const transport = `harness delegation, else ${other!.arm}, family ${other!.family}, transport ${other!.transport}`;
    return [{ role: "review arm", arm, family: "codex", transport }];
  }

  const ran = (tier === "astra" ? (["astra", "sol"] as const) : (["sol", "astra"] as const)).find(
    (name) => roster.opencode[name],
  );

  const model = ran && roster.opencode[ran];
  if (roster.families.includes("opencode") && model) {
    const arm = `${ran} ${model.model}${model.variant ? `#${model.variant}` : ""}`;
    return [{ role: "review arm", arm, family: lineage(model.model), transport: "opencode" }];
  }

  const claude = claudeSeat("review arm", fallback, setup);
  return claude.length
    ? claude
    : [{ role: "review arm", arm: "the lead", family: "lead", transport: "none" }];
}

function seats(path: FastPath | undefined, plan: Plan, setup: Setup): Seat[] {
  const cell = (column: string) =>
    path?.cells[path.columns.findIndex((name) => name === column)] ?? "";

  const choice = (text: string) =>
    agentsIn(text, setup).join(text.includes(" or ") ? " or " : ", ");

  const opinion = choice(cell("design opinion"));
  const implementer = setup.arms.implementation;
  const review = path ? cell("review arms") : "the review arm";
  const named = agentsIn(review, setup);
  if (!review.includes("the review arm") && !named.length)
    throw new Error(`fast path review arms cell names no seat: ${review}`);

  return [
    ...(opinion ? claudeSeat("design opinion", opinion, setup) : []),
    implementer === "lead"
      ? { role: "implementation", arm: "the lead", family: "lead", transport: "none" }
      : {
          role: "implementation",
          arm:
            implementer === "codex"
              ? `the implementation delegate, ${codexTier(setup)}`
              : "the implementation delegate",
          family: implementer === "codex" ? "codex" : "the vendor of its tier's model",
          transport: implementer === "codex" ? codexTransport(setup) : "opencode",
        },
    ...(review.includes("the review arm")
      ? reviewArm(named.includes("opus-review") ? "fable-judgment" : "opus-review", plan, setup)
      : []),
    ...named.flatMap((agent) => claudeSeat("review arm", agent, setup)),
    ...agentsIn(cell("comment sweep"), setup).flatMap((agent) =>
      claudeSeat("comment sweep", agent, setup),
    ),
  ];
}

function steps(path: string): string[][] {
  const groups: string[][] = [[]];
  for (const line of fileLines(path)) {
    if (/^\d+\. /.test(line)) groups.push([]);
    groups.at(-1)!.push(line);
  }

  return groups;
}

function mentions(group: readonly string[], token: string): boolean {
  return group.some((line) => line.includes(`\`${token}\``) || line.includes(`**${token}**`));
}

function routed(setup: Setup, route: Route, plan: Plan, path: FastPath | undefined): Line[] {
  const result: Line[] = [];
  for (const group of steps(join(setup.skills, `playbook/playbooks/${route}.md`))) {
    const body = HANDBACK_STEP.test(group[0] ?? "") ? group.slice(1) : group;
    const drops = path ? [...path.tokens].filter((token) => mentions(body, token)) : [];
    if (drops.length)
      result.push(
        value(
          "fast path",
          `effort ${plan.effort} (${drops.map((token) => `\`${token}\``).join(", ")})`,
        ),
      );

    result.push(...body.map(copy));
  }

  return result;
}

function handback(skills: string, mode: DeliveryMode): Line[] {
  const path = join(skills, "playbook/playbooks/handing-back.md");
  const result: Line[] = [];

  let skipping = false;
  let kept = 0;
  for (const line of fileLines(path)) {
    const label = /^ {3}- \*\*([^*]+)\*\*/.exec(line)?.[1];
    if (label !== undefined) {
      skipping = label !== mode;
      if (!skipping) kept++;
    } else if (!line.startsWith("     ")) skipping = false;

    if (!skipping) result.push(copy(line));
  }

  if (kept !== 1) throw new Error(`${path}: ${kept} **${mode}** bullets, expected one`);

  return result;
}

function transport(skills: string): Line[] {
  const path = join(skills, "playbook/references/codex-arms.md");
  const lines = fileLines(path);
  const start = lines.indexOf("## Transport");
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const first = lines.findIndex(
    (line, index) => index > start && (next < 0 || index < next) && line.startsWith("1. "),
  );

  if (start < 0 || first < 0) throw new Error(`${path}: no numbered ## Transport section`);

  let end = first;
  while (/^\d+\. /.test(lines[end] ?? "")) end++;

  return lines.slice(start, end).map(copy);
}

export function compileBrief(plan: Plan, route: Route, setup: Setup): Line[] {
  const path = routes[route].sized ? fastPath(setup.skills, plan.effort) : undefined;
  const { roster, implementation, cli } = setup.arms;
  const families = armFamilies.filter((family) => roster.families.includes(family));
  return [
    value("id", plan.id),
    value("slug", plan.slug),
    value("project", plan.project),
    value("effort", plan.effort),
    value("critical", String(plan.critical)),
    value("route", route),
    value("playbooks", join(dirname(dirname(setup.bin)), "playbooks")),
    value("delivery", setup.delivery.mode),
    value("reviewers", setup.delivery.active.join(" ") || "none"),
    ...families.map((family) =>
      value(
        "arms",
        [
          family,
          `cli=${cli.has(family) ? "yes" : "no"}`,
          ...(family === "opencode" ? tierTokens(roster) : []),
        ].join(" "),
      ),
    ),
    value("arms", `implementation=${implementation}`),
    value("lint", `${setup.bin} plans lint ${plan.project} ${plan.id}`),
    value("surface", plan.surface),
    ...plan.probe.map((command) => value("probe", command)),
    ...(path ? [copy(""), copy(path.header), copy(path.row)] : []),
    ...(path?.dropped ?? []).map((column) =>
      value(column.replace(/`/g, ""), `fast path: effort ${plan.effort}`),
    ),
    ...seats(path, plan, setup).map((seat) =>
      value(
        "seat",
        `${seat.role}, ${seat.arm}, family ${seat.family}, transport ${seat.transport}`,
      ),
    ),
    copy(""),
    ...transport(setup.skills),
    copy(""),
    ...routed(setup, route, plan, path),
    copy(""),
    ...handback(setup.skills, setup.delivery.mode),
  ];
}

export function renderBrief(lines: readonly Line[]): string {
  return `${lines.map((line) => (line.kind === "value" ? `${line.key}: ${line.value}` : line.text)).join("\n")}\n`;
}

function section(lines: readonly string[], heading: string): string[] {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return [];

  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

export function probeCommands(lines: readonly string[]): string[] {
  const body = section(lines, "## Probe").filter((line) => !/^\s*(```|~~~)/.test(line));
  const indented = body.filter((line) => /^( {4}|\t)\S/.test(line)).map((line) => line.trim());
  if (indented.length) return indented;

  const first = body.findIndex((line) => line.trim());
  if (first < 0) return [];

  const end = body.findIndex(
    (line, index) => index > first && (!line.trim() || /^[a-z]\. /.test(line)),
  );

  return body.slice(first, end < 0 ? undefined : end).map((line) => line.trim());
}

export function readPlan(project: string, id: string, env: NodeJS.ProcessEnv): Plan {
  const index = indexPath(project, env);
  if (!existsSync(index)) throw new Error(missingIndex(project));

  const row = readIndex(index).find((entry) => entry.id === id);
  if (!row) throw new Error(`no row ${id} in ${project}`);

  const file = join(projectDir(project, env), `${row.id}-${row.slug}.md`);
  if (!existsSync(file)) throw new Error(`no open plan file ${row.id}-${row.slug}.md`);

  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const closing = lines.indexOf("---", 1);
  const front = lines[0] === "---" && closing > 0 ? lines.slice(1, closing) : [];
  const field = (key: string) => front.find((line) => line.startsWith(`${key}:`)) ?? `${key}:`;
  return {
    id: row.id,
    slug: row.slug,
    project,
    effort: row.effort,
    critical: /^critical:[ \t]*true[ \t]*$/.test(field("critical")),
    surface: surfaceValue(field("surface")),
    probe: probeCommands(lines),
  };
}

export function readSetup(root: string, repo: string, bin: string, env: NodeJS.ProcessEnv): Setup {
  const delivery = readDelivery(realpathSync(root), env);
  const { roster, implementation } = readArms(env);
  const cli = new Set(armFamilies.filter((family) => Bun.which(family, { PATH: env.PATH ?? "" })));
  return {
    skills: root,
    agents: join(repo, "agents"),
    bin,
    delivery: { mode: delivery.mode, active: delivery.active },
    arms: { roster, implementation, cli },
    fast: readFastModes(env).modes,
  };
}

function isRoute(name: string): name is Route {
  return Object.hasOwn(routes, name);
}

export function briefVerb(
  args: readonly string[],
  usage: string,
  setup: () => Setup,
  io: Io,
): number {
  const [project, id, route] = args;
  if (!project || !id || !route || args.length > 3) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  if (!isRoute(route)) {
    io.err(`unknown route ${route}: name one of ${Object.keys(routes).join(", ")}\n`);
    return 2;
  }

  io.out(renderBrief(compileBrief(readPlan(project, id, io.env), route, setup())));
  return 0;
}
