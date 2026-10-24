import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultRoster } from "../arms.ts";
import { writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import {
  compileBrief,
  probeCommands,
  renderBrief,
  type Line,
  type Plan,
  type Route,
  type Setup,
} from "./brief.ts";

const repo = resolve(import.meta.dir, "../..");
const skills = join(repo, "skills");
const bin = join(skills, "playbook/bin/skills");
function setup(mode: "prs" | "hands-off" = "hands-off", active: string[] = []): Setup {
  return {
    skills,
    agents: join(repo, "agents"),
    bin,
    delivery: { mode, active },
    arms: {
      roster: structuredClone(defaultRoster),
      implementation: "lead",
      cli: new Set(["codex"]),
    },
    fast: { codex: false, claude: false },
  };
}

function plan(effort: string): Plan {
  return {
    id: "003",
    slug: "skip-muted-members",
    project: "Widgets",
    effort,
    critical: false,
    surface: "the room broadcast path, server side only",
    probe: ['rg -n "broadcastToRoom|muted" src/chat test/'],
  };
}

function values(lines: readonly Line[], key: string): string[] {
  return lines.flatMap((line) => (line.kind === "value" && line.key === key ? [line.value] : []));
}

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const skillTexts = files(skills).map((path) => readFileSync(path, "utf8"));

function compile(effort: string, route: Route, mode?: "prs" | "hands-off") {
  return compileBrief(plan(effort), route, setup(mode));
}

describe("brief", () => {
  test("an XS bug fix marks every dropped step and names one review arm", () => {
    const lines = compile("XS", "bug-fix");
    const text = renderBrief(lines);

    for (const step of ["how", "architect", "design opinion", "comment sweep"])
      expect(values(lines, step)).toEqual(["fast path: effort XS"]);

    expect(text).toContain("fast path: effort XS (`how`)\n3. Binary-search the cause.");
    expect(text).toContain("fast path: effort XS (`architect`)\n4. Plan the fix.");
    expect(values(lines, "seat").filter((seat) => seat.startsWith("review arm"))).toEqual([
      "review arm, sol high, service tier default, family codex, transport harness delegation, else codex cli",
    ]);

    expect(values(lines, "seat").some((seat) => seat.startsWith("design opinion"))).toBe(false);
  });

  test("an M feature runs how, one design opinion and the sweep, architect with its skip rule", () => {
    const lines = compile("M", "feature");
    const text = renderBrief(lines);

    expect(text).toMatch(
      /\n {3}\| M +\| run +\| run unless the shape is settled +\| `opus-review` on the design /,
    );

    for (const step of ["how", "architect", "design opinion", "comment sweep"])
      expect(values(lines, step)).toEqual([]);

    expect(text).toContain("\n1. `how` over the affected subsystem.");
    expect(text).toContain("\n2. `architect` for parallel design exploration.");
    expect(text).toContain("fast path: effort M (`interrogate`)\n7. If the design is contested");
    expect(values(lines, "seat")).toEqual([
      "design opinion, opus-review, family claude, transport task",
      "implementation, the lead, family lead, transport none",
      "review arm, sol high, service tier default, family codex, transport harness delegation, else codex cli",
      "review arm, opus-review, family claude, transport task",
      "comment sweep, comment-sicko, family claude, transport task",
    ]);
  });

  test("an XS feature marks its dropped how and architect steps in place", () => {
    const text = renderBrief(compile("XS", "feature"));

    expect(text).toContain("fast path: effort XS (`how`)\n1. `how` over the affected subsystem.");
    expect(text).toContain("fast path: effort XS (`architect`)\n2. `architect` for parallel");
    expect(text).toContain("fast path: effort XS (`architect`)\n4. Write the code yourself.");
    expect(text).not.toContain("8. Run `handing-back.md`.");
  });

  test("an L feature offers one design opinion of two and keeps interrogate", () => {
    const lines = compile("L", "feature");

    expect(values(lines, "seat")[0]).toBe(
      "design opinion, opus-review or fable-judgment, family claude, transport task",
    );

    expect(values(lines, "fast path")).toEqual([]);
  });

  test("an investigation runs as written, with no fast path row", () => {
    const lines = compile("XS", "investigation");

    expect(values(lines, "how")).toEqual([]);
    expect(values(lines, "fast path")).toEqual([]);
    expect(values(lines, "seat")).toContain(
      "review arm, sol high, service tier default, family codex, transport harness delegation, else codex cli",
    );
  });

  test.each(["hands-off", "prs"] as const)("the %s handback keeps only its own bullet", (mode) => {
    const text = renderBrief(compile("S", "feature", mode));
    const other = mode === "prs" ? "   - **hands-off**" : "   - **prs**, you own the task";

    expect(text).toContain(`   - **${mode}**`);
    expect(text).not.toContain(other);
    expect(text).not.toContain("**prs, under a babysit");
    expect(text).toContain("   In both modes: do not comment on a PR");
  });

  test.each([
    ["XS", "bug-fix"],
    ["M", "feature"],
    ["L", "refactoring"],
    ["S", "perf-issue"],
    ["M", "investigation"],
    ["M", "prototype"],
  ] as const)(
    "every copied line of an %s %s brief is in exactly one skill file",
    (effort, route) => {
      for (const line of compile(effort, route, "prs")) {
        if (line.kind !== "copy" || !line.text.trim()) continue;
        const holders = skillTexts.filter((text) => text.includes(line.text));
        expect(holders.length, line.text).toBe(1);
      }
    },
  );

  test.each([
    "bug-fix",
    "feature",
    "refactoring",
    "perf-issue",
    "investigation",
    "prototype",
  ] as const)("an L %s brief in prs mode stays under 12 KB", (route) => {
    expect(renderBrief(compile("L", route, "prs")).length).toBeLessThan(12 * 1024);
  });

  test("an OpenCode review arm counts as its model's vendor and names the tier it ran at", () => {
    const opencode: Setup = {
      ...setup(),
      arms: {
        roster: { families: ["opencode"], opencode: { sol: { model: "opencode/gemini-3.1-pro" } } },
        implementation: "lead",
        cli: new Set(),
      },
    };

    expect(
      values(compileBrief({ ...plan("XS"), critical: true }, "bug-fix", opencode), "seat"),
    ).toContain("review arm, sol opencode/gemini-3.1-pro, family gemini, transport opencode");
  });

  test("probe commands skip fences and stop at the outcome list", () => {
    expect(probeCommands(["## Probe", "", "```", "rg -n foo src", "```", "", "a. done"])).toEqual([
      "rg -n foo src",
    ]);

    expect(probeCommands(["## Probe", "", "rg -n foo src", "a. done", "b. go"])).toEqual([
      "rg -n foo src",
    ]);
  });

  test("critical work seats the review arm at astra", () => {
    const lines = compileBrief({ ...plan("M"), critical: true }, "feature", setup());

    expect(values(lines, "seat")).toContain(
      "review arm, astra high, service tier default, family codex, transport harness delegation, else codex cli",
    );
  });

  test("a roster without Codex seats the review arm on its Claude fallback", () => {
    const claudeOnly: Setup = {
      ...setup(),
      arms: {
        roster: { families: ["claude"], opencode: {} },
        implementation: "lead",
        cli: new Set(),
      },
    };

    expect(values(compileBrief(plan("XS"), "bug-fix", claudeOnly), "seat")).toContain(
      "review arm, opus-review, family claude, transport task",
    );

    expect(values(compileBrief(plan("M"), "feature", claudeOnly), "seat")).toContain(
      "review arm, fable-judgment, family claude, transport task",
    );
  });
});

describe("brief verb", () => {
  test("reads the plan and its probe, and needs a route from the plans directory", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "brief-"));
    try {
      const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote";
      const row =
        "003\tskip-muted-members\tDOING\tP1\tXS\t-\t-\tfeat/skip-muted-members\t2026-10-24\t-";

      await writeFixture(temporary, "plans/Widgets/index.tsv", `${header}\n${row}\n`);
      await writeFixture(
        temporary,
        "plans/Widgets/003-skip-muted-members.md",
        [
          "---",
          "id: 003",
          "slug: skip-muted-members",
          "effort: XS",
          "blocked_by: -",
          "critical: true",
          "surface: the room broadcast path, server side only",
          "---",
          "",
          "## Probe",
          "",
          '    rg -n "broadcastToRoom|muted" src/chat test/',
          "",
          "a. Already skipped: close as DROPPED.",
          "",
        ].join("\n"),
      );

      const env = {
        ...suiteEnvironment(),
        PLANS_DIR: join(temporary, "plans"),
        SKILLS_CONF: join(temporary, "skills.conf"),
      };

      const bare = await runCommand([bin, "brief", "Widgets", "003"], { cwd: temporary, env });
      expect(bare.code).toBe(2);
      expect(bare.stderr).toBe("usage: skills brief <Project> <id> <route>\n");

      const routed = await runCommand([bin, "brief", "Widgets", "003", "bug-fix"], {
        cwd: temporary,
        env,
      });

      expect(routed.stderr).toBe("");
      expect(routed.stdout).toContain("route: bug-fix\n");
      expect(routed.stdout).toContain('probe: rg -n "broadcastToRoom|muted" src/chat test/\n');
      expect(routed.stdout).toContain("### Bug fix\n");

      expect(routed.stdout).toContain("critical: true\n");
      expect(routed.stdout).toContain("surface: the room broadcast path, server side only\n");

      const named = await runCommand([bin, "brief", "Widgets", "003", "feature"], {
        cwd: temporary,
        env,
      });

      expect(named.stdout).toContain("### Feature\n");

      const unknown = await runCommand([bin, "brief", "Widgets", "003", "chore"], {
        cwd: temporary,
        env,
      });

      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toStartWith("unknown route chore: name one of bug-fix, feature");
    } finally {
      await removeTemporary(temporary);
    }
  });
});
