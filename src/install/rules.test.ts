import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  canonical,
  expandEntry,
  readRuleGroups,
  type Placeholder,
  type RuleGroup,
} from "../deny-set.ts";
import type { DeliveryMode } from "../delivery.ts";
import { object, parseJson, stringifyJson, type Json, type JsonObject } from "./json.ts";
import {
  applyRuleChanges,
  placement,
  reconcileRules,
  type Levels,
  type RulesInput,
} from "./rules.ts";

const groups = readRuleGroups(resolve(import.meta.dir, "../../skills"));
const home = "/home/user";
const defaults: Record<Placeholder, string> = {
  claude: `${home}/.claude`,
  agents: `${home}/.agents/skills`,
  conf: `${home}/.agents/skills.conf`,
  checkout: "/repository",
  codex: `${home}/.codex`,
};

function document(text: string): JsonObject {
  const settings = object(parseJson(text));
  if (!settings) throw new Error("settings must be an object");
  return settings;
}

function input(settings: JsonObject, overrides: Partial<RulesInput> = {}): RulesInput {
  return {
    groups,
    mode: "prs",
    levels: { global: "deny", groups: {} },
    guard: false,
    settings,
    home,
    current: defaults,
    defaults,
    ...overrides,
  };
}

function plan(value: RulesInput) {
  const result = reconcileRules(value);
  if ("refused" in result) throw new Error(result.refused);
  return result;
}

function groupEntries(id: string): string[] {
  return groups
    .filter((group) => group.id === id)
    .flatMap((group) => group.entries.flatMap((entry) => expandEntry(entry, defaults, home)));
}

function pasted(mode: DeliveryMode): JsonObject {
  const deny = groups
    .filter(
      (group) =>
        group.kind !== "retired" &&
        (group.cells[mode] === "deny" || group.cells[mode] === "deny-until-guard"),
    )
    .flatMap((group) => group.entries.flatMap((entry) => expandEntry(entry, defaults, home)));

  const ask = groups
    .filter((group) => group.kind !== "retired" && group.cells[mode] === "ask")
    .flatMap((group) => group.entries.flatMap((entry) => expandEntry(entry, defaults, home)));

  return { permissions: { deny, ask } };
}

function denyOf(settings: JsonObject): Json[] {
  const rows = object(settings.permissions)?.deny;
  return Array.isArray(rows) ? rows : [];
}

function synthetic(
  id: string,
  entries: string[],
  cells: { "hands-off": "deny" | "allow"; prs: "deny" | "allow" | "absent" } = {
    "hands-off": "deny",
    prs: "deny",
  },
): RuleGroup {
  return { id, label: id, entries, cells, kind: cells["hands-off"] === "allow" ? "allow" : "deny" };
}

describe("real rule table", () => {
  test("release removes owned entries even when every group is off", () => {
    const allow = synthetic("cli", ["Bash(skills *)"], { "hands-off": "allow", prs: "allow" });
    const settings = pasted("hands-off");
    const permissions = object(settings.permissions)!;
    permissions.allow = ["Bash(skills *)", "Bash(personal *)"];
    permissions.ask = ["Read(~/private/**)"];
    const value = input(settings, {
      groups: [...groups, allow],
      levels: { global: "off", groups: { merge: "off", cli: "off" } },
      release: true,
    });

    const result = plan(value);

    for (const group of value.groups)
      expect(placement(group, value)).toMatchObject({ level: "deny", target: "absent" });

    expect(result.changes.every((change) => change.to === "absent")).toBe(true);
    expect(result.changes.find((change) => change.group === "merge")?.class).toBe("weakening");
    expect(result.changes.find((change) => change.group === "cli")?.class).toBe("strengthening");

    applyRuleChanges(settings, result.changes);

    expect(settings).toEqual({
      permissions: {
        deny: [],
        allow: ["Bash(personal *)"],
        ask: ["Read(~/private/**)"],
      },
    });

    expect(plan(value).changes).toEqual([]);
  });

  test.each([
    ["hands-off", "prs", "absent", "weakening"],
    ["prs", "hands-off", "deny", "strengthening"],
  ] as const)("%s to %s changes only publishing", (before, mode, to, classification) => {
    const settings = pasted(before);
    const value = input(settings, { mode });
    const snapshot = stringifyJson(settings);
    const result = plan(value);

    expect(result.changes).toEqual(
      groupEntries("publishing").map((text) => ({
        group: "publishing",
        text,
        from: before === "hands-off" ? ["deny"] : [],
        to,
        class: classification,
        spellings: [canonical(text)],
      })),
    );

    expect(result.notes).toEqual([]);
    expect(stringifyJson(settings)).toBe(snapshot);

    applyRuleChanges(settings, result.changes);

    const sorted = (value: JsonObject) => [...denyOf(value)].map(String).sort();

    expect(sorted(settings)).toEqual(sorted(pasted(mode)));
    expect(plan(value).changes).toEqual([]);
  });

  test("removes a retired entry as neutral", () => {
    const text = groupEntries("skills-conf-write")[0]!;
    const settings = pasted("prs");
    const deny = object(settings.permissions)!.deny;
    if (!Array.isArray(deny)) throw new Error("deny must be a list");

    deny.unshift(...groupEntries("skills-conf-write"));
    const result = plan(input(settings));

    expect(result.changes).toEqual([
      {
        group: "skills-conf-write",
        text,
        from: ["deny"],
        to: "absent",
        class: "neutral",
        spellings: [text],
      },
    ]);

    applyRuleChanges(settings, result.changes);

    expect(settings).toEqual(pasted("prs"));
  });

  test("publishing at off stays and names every blocking entry", () => {
    const settings = pasted("hands-off");
    const snapshot = stringifyJson(settings);
    const value = input(settings, { levels: { global: "deny", groups: { publishing: "off" } } });
    const result = plan(value);

    expect(result.changes).toEqual([]);
    expect(result.notes).toEqual(
      groupEntries("publishing").map((text) => ({
        kind: "blocks",
        list: "deny",
        text,
        needs: text,
        group: "publishing",
        off: "publishing",
      })),
    );

    applyRuleChanges(settings, result.changes);

    expect(stringifyJson(settings)).toBe(snapshot);
  });

  test.each(["Bash(git *)", "Bash(git:*)"])(
    "personal %s blocks publishing without changing",
    (text) => {
      const settings = pasted("prs");
      const permissions = object(settings.permissions)!;
      const deny = permissions.deny;
      if (!Array.isArray(deny)) throw new Error("deny must be a list");

      deny.push(text);
      permissions.allow = ["Bash(gh pr merge --auto *)"];
      const result = plan(input(settings));

      expect(result.changes).toEqual([]);
      expect(result.notes).toContainEqual({
        kind: "blocks",
        list: "deny",
        text,
        needs: "Bash(git commit:*)",
        group: "publishing",
      });

      expect(result.notes).toContainEqual({
        kind: "blocks",
        list: "deny",
        text,
        needs: "Bash(git push:*)",
        group: "publishing",
      });

      expect(result.notes).toContainEqual({
        kind: "dead-allow",
        text: "Bash(gh pr merge --auto *)",
        guardrail: "Bash(gh pr merge:*)",
        group: "merge",
      });
    },
  );

  test("hand typed merge moves to ask keeping its spelling", () => {
    const settings = pasted("prs");
    const permissions = object(settings.permissions)!;
    const deny = permissions.deny;
    if (!Array.isArray(deny)) throw new Error("deny must be a list");

    deny[deny.indexOf("Bash(gh pr merge:*)")] = "Bash(gh pr merge *)";
    const result = plan(input(settings, { levels: { global: "ask", groups: {} } }));
    const change = result.changes.find((change) => change.text === "Bash(gh pr merge *)")!;

    expect(change).toEqual({
      group: "merge",
      text: "Bash(gh pr merge *)",
      from: ["deny"],
      to: "ask",
      class: "weakening",
      spellings: ["Bash(gh pr merge *)"],
    });

    applyRuleChanges(settings, result.changes);

    expect(object(settings.permissions)?.ask).toContain("Bash(gh pr merge *)");
    expect(object(settings.permissions)?.deny).not.toContain("Bash(gh pr merge *)");
  });

  test.each([
    ['{"deny":["Bash(gh pr merge:*)","Bash(gh pr merge:*)"]}', "deny", "neutral", ["deny"]],
    [
      '{"deny":["Bash(gh pr merge:*)"],"ask":["Bash(gh pr merge *)"]}',
      "deny",
      "neutral",
      ["deny", "ask"],
    ],
    ['{"deny":["Bash(gh pr merge:*)","Bash(gh pr merge:*)"]}', "ask", "weakening", ["deny"]],
  ] as const)("deduplicates %s into %s", (json, target, classification, from) => {
    const settings = document(`{"permissions":${json}}`);
    const value = input(settings, { levels: { global: target, groups: {} } });
    const result = plan(value);
    const change = result.changes.find((change) => change.text === "Bash(gh pr merge:*)")!;

    expect(change.from).toEqual([...from]);
    expect(change.class).toBe(classification);

    applyRuleChanges(settings, result.changes);

    expect(object(settings.permissions)?.[target]).toEqual(
      expect.arrayContaining(["Bash(gh pr merge:*)"]),
    );

    const permissions = object(settings.permissions)!;
    const occurrences = [permissions.deny, permissions.ask]
      .flatMap((rows) => (Array.isArray(rows) ? rows : []))
      .filter((text) => typeof text === "string" && canonical(text) === "Bash(gh pr merge *)");

    expect(occurrences).toEqual(["Bash(gh pr merge:*)"]);
    expect(plan(value).changes).toEqual([]);
  });

  test.each([
    ["prs", true, "deny", "absent"],
    ["prs", false, "deny", "deny"],
    ["prs", false, "ask", "ask"],
    ["hands-off", true, "deny", "deny"],
    ["hands-off", false, "deny", "deny"],
    ["hands-off", true, "ask", "ask"],
    ["hands-off", false, "ask", "ask"],
  ] as const)("pr-comment in %s with guard %s at %s targets %s", (mode, guard, level, target) => {
    const settings = pasted("hands-off");
    const value = input(settings, { mode, guard, levels: { global: level, groups: {} } });
    const result = plan(value);
    const changes = result.changes.filter((change) => change.group === "pr-comment");

    expect(changes).toEqual(
      target === "deny"
        ? []
        : groupEntries("pr-comment").map((text) => ({
            group: "pr-comment",
            text,
            from: ["deny"],
            to: target,
            class: "weakening",
            spellings: [canonical(text)],
          })),
    );

    applyRuleChanges(settings, result.changes);

    expect(plan(value).changes).toEqual([]);

    if (target !== "absent")
      expect(object(settings.permissions)?.[target]).toContain(groupEntries("pr-comment")[0]);
  });

  test.each([
    ["prs", "Bash(git push:*)", undefined],
    ["hands-off", "Bash(gh pr merge:*)", "merge"],
  ] as const)("%s leaves the personal allow %s", (mode, text, guardrailGroup) => {
    const settings = pasted(mode);
    object(settings.permissions)!.allow = [text];
    const result = plan(input(settings, { mode }));

    expect(result.changes).toEqual([]);
    expect(result.notes).toEqual(
      guardrailGroup ? [{ kind: "dead-allow", text, guardrail: text, group: guardrailGroup }] : [],
    );

    applyRuleChanges(settings, result.changes);

    expect(object(settings.permissions)?.allow).toEqual([text]);
  });

  test("off wins over retired", () => {
    const settings = pasted("prs");
    object(settings.permissions)!.ask = [
      ...groupEntries("claude-settings"),
      ...groupEntries("skills-conf-write"),
    ];

    const snapshot = stringifyJson(settings);
    const result = plan(
      input(settings, { levels: { global: "deny", groups: { "skills-conf-write": "off" } } }),
    );

    expect(result.changes).toEqual([]);

    applyRuleChanges(settings, result.changes);

    expect(stringifyJson(settings)).toBe(snapshot);
  });
});

describe("idempotence", () => {
  const levels: Levels[] = [
    { global: "deny", groups: {} },
    { global: "ask", groups: {} },
    { global: "off", groups: {} },
    { global: "ask", groups: { merge: "deny", publishing: "off" } },
    { global: "deny", groups: { merge: "ask", "pr-comment": "off" } },
  ];

  for (const mode of ["hands-off", "prs"] as const)
    for (const guard of [false, true])
      test.each(levels)(`${mode}, guard ${guard}, levels %j`, (levels) => {
        const settings = pasted(mode === "prs" ? "hands-off" : "prs");
        const permissions = object(settings.permissions)!;
        const deny = permissions.deny;
        if (!Array.isArray(deny)) throw new Error("deny must be a list");

        deny.push(
          ...groupEntries("merge"),
          ...groupEntries("skills-conf-write"),
          "Bash(personal *)",
        );

        permissions.allow = [...groupEntries("merge"), false, null, { personal: true }];
        const value = input(settings, { mode, guard, levels });
        const result = plan(value);
        const partialSettings = document(stringifyJson(settings));

        applyRuleChanges(
          partialSettings,
          result.changes.filter((change) => change.class !== "weakening"),
        );

        expect(plan({ ...value, settings: partialSettings }).changes).toEqual(
          result.changes.filter((change) => change.class === "weakening"),
        );

        applyRuleChanges(settings, result.changes);

        expect(plan(value).changes).toEqual([]);
        expect(object(settings.permissions)?.allow).toEqual([
          ...groupEntries("merge"),
          false,
          null,
          { personal: true },
        ]);

        expect(object(settings.permissions)?.deny).toContain("Bash(personal *)");
      });
});

describe("placeholders and claims", () => {
  test.each(["Edit({agents}/**)", "Bash(example {agents} *)"])(
    "replaces default renderings of %s",
    (entry) => {
      const group = synthetic("paths", [entry]);
      const current = { ...defaults, agents: `${home}/new-skills` };
      const old = expandEntry(entry, defaults, home);
      const settings: JsonObject = { permissions: { deny: old } };

      const value = input(settings, { groups: [group], current });
      const result = plan(value);

      expect(result.changes.map((change) => change.class)).toEqual(
        expandEntry(entry, current, home).map(() => "weakening"),
      );

      applyRuleChanges(settings, result.changes);

      expect(object(settings.permissions)?.deny).toEqual(expandEntry(entry, current, home));
      expect(plan(value).changes).toEqual([]);
    },
  );

  test("maps two default Bash renderings onto one current rendering", () => {
    const entry = "Bash(example {agents} *)";
    const current = { ...defaults, agents: "/outside/skills" };
    const settings: JsonObject = { permissions: { deny: expandEntry(entry, defaults, home) } };
    const value = input(settings, { groups: [synthetic("paths", [entry])], current });
    const result = plan(value);

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.spellings).toEqual([
      "Bash(example /outside/skills *)",
      ...expandEntry(entry, defaults, home),
    ]);

    applyRuleChanges(settings, result.changes);

    expect(object(settings.permissions)?.deny).toEqual(["Bash(example /outside/skills *)"]);
    expect(plan(value).changes).toEqual([]);
  });

  test.each([false, true])("current claims beat earlier defaults with off %s", (off) => {
    const customGroups = [
      synthetic("paths", ["Edit({agents})"]),
      synthetic("literal", ["Edit(~/.agents/skills)"]),
    ];

    const settings: JsonObject = { permissions: { deny: ["Edit(~/.agents/skills)"] } };
    const value = input(settings, {
      groups: customGroups,
      current: { ...defaults, agents: "/outside/skills" },
      levels: { global: "deny", groups: { literal: off ? "off" : "deny" } },
    });

    const result = plan(value);

    expect(result.changes).toEqual([
      {
        group: "paths",
        text: "Edit(//outside/skills)",
        from: [],
        to: "deny",
        class: "strengthening",
        spellings: ["Edit(//outside/skills)"],
      },
    ]);

    applyRuleChanges(settings, result.changes);

    expect(object(settings.permissions)?.deny).toEqual([
      "Edit(~/.agents/skills)",
      "Edit(//outside/skills)",
    ]);

    expect(plan(value).changes).toEqual([]);
  });

  test("the first default claims a default two groups share", () => {
    const value = input(
      { permissions: { deny: ["Edit(~/.agents/skills)"] } },
      {
        groups: [synthetic("first", ["Edit({agents})"]), synthetic("second", ["Edit({codex})"])],
        current: { ...defaults, agents: "/first", codex: "/second" },
        defaults: { ...defaults, codex: defaults.agents },
      },
    );

    const result = plan(value);

    expect(
      result.changes.map(({ group, text, from, class: kind }) => [group, text, from, kind]),
    ).toEqual([
      ["first", "Edit(//first)", ["deny"], "weakening"],
      ["second", "Edit(//second)", [], "strengthening"],
    ]);
  });

  test.each(["deny", "off"] as const)(
    "refuses canonical current collisions even at %s",
    (level) => {
      const value = input(
        {},
        {
          groups: [
            synthetic("first", ["Bash(example:*)"]),
            synthetic("second", ["Bash(example *)"]),
          ],
          levels: { global: level, groups: {} },
        },
      );

      expect(reconcileRules(value)).toEqual({ refused: "two rules render as Bash(example *)" });
    },
  );

  test("two entries of one group rendering alike place one rule", () => {
    const current = { ...defaults, agents: `${defaults.checkout}/skills` };
    const settings = document("{}");
    const result = plan(input(settings, { current }));

    applyRuleChanges(settings, result.changes);

    const deny = object(settings.permissions)!.deny as string[];
    const rule = `Bash(${defaults.checkout}/skills/playbook/bin/skills install *)`;
    expect(deny.filter((entry) => entry === rule)).toEqual([rule]);
    expect(reconcileRules(input(settings, { current }))).toEqual({ changes: [], notes: [] });
  });

  test("inherited group levels do not override global", () => {
    const overrides: Record<string, "off"> = {};
    Object.setPrototypeOf(overrides, { merge: "off" });
    const result = plan(
      input(
        {},
        {
          groups: groups.filter((group) => group.id === "merge"),
          levels: { global: "ask", groups: overrides },
        },
      ),
    );

    expect(result.changes.map((change) => change.to)).toEqual(["ask", "ask"]);
  });
});

describe("notes matcher", () => {
  test.each([
    ["Bash", "Bash(example *)", true],
    ["Edit", "Bash(example *)", false],
    ["Bash(example:*)", "Bash(example)", true],
    ["Bash(example *)", "Bash(example *)", true],
    ["Bash(example *)", "Bash(example --flag *)", true],
    ["Bash(example --flag *)", "Bash(example *)", false],
    ["Bash(example *)", "Bash(examples *)", false],
    ["Bash(example [a].+ *)", "Bash(example [a].+ *)", true],
    ["Bash(example [a].+ *)", "Bash(example aZZ *)", false],
    ["Edit(~/skills/**)", "Edit(~/skills/nested/file)", true],
    ["Edit(~/skills/*)", "Edit(~/skills/nested/file)", false],
    ["Edit(~/skills/*)", "Edit(~/skills/file)", true],
    ["Edit(~/skills/file)", "Edit(~/skills/**)", false],
    ["Edit(~/skills/*)", "Edit(~/skills/**)", false],
    ["Edit(~/skills/*)", "Edit(~/skills/*)", true],
    ["Bash(example * *)", "Bash(example:*)", false],
    ["Bash(git:*)", "Bash(git push:*)", true],
    ["not a rule(", "Bash(example *)", false],
  ] as const)("%s subsumes literal %s: %s", (pattern, need, expected) => {
    const group = synthetic("need", [need], { "hands-off": "deny", prs: "absent" });
    const result = plan(
      input(
        { permissions: { deny: [pattern] } },
        { groups: [group], levels: { global: "off", groups: {} } },
      ),
    );

    expect(result.notes).toHaveLength(expected ? 1 : 0);
    expect(result.changes).toEqual([]);
  });

  test("allow groups own only allow and leave matching deny and ask personal", () => {
    const group = synthetic("cli", ["Bash(skills *)"], { "hands-off": "allow", prs: "allow" });
    const settings = document(
      '{"permissions":{"deny":["Bash(skills:*)"],"ask":["Bash(skills *)"],"allow":["Bash(skills:*)","Bash(skills *)"]}}',
    );

    const value = input(settings, { groups: [group] });
    const result = plan(value);

    expect(result.changes[0]?.from).toEqual(["allow"]);
    expect(result.changes[0]?.class).toBe("neutral");
    expect(result.notes).toEqual([
      {
        kind: "blocks",
        list: "deny",
        text: "Bash(skills:*)",
        needs: "Bash(skills *)",
        group: "cli",
      },
      {
        kind: "blocks",
        list: "ask",
        text: "Bash(skills *)",
        needs: "Bash(skills *)",
        group: "cli",
      },
    ]);

    applyRuleChanges(settings, result.changes);

    expect(settings).toEqual(
      document(
        '{"permissions":{"deny":["Bash(skills:*)"],"ask":["Bash(skills *)"],"allow":["Bash(skills:*)"]}}',
      ),
    );

    expect(plan(value).changes).toEqual([]);
  });

  test.each([
    ["allow", [], "weakening"],
    ["absent", ["Bash(skills *)"], "strengthening"],
  ] as const)("allow group targeting %s is %s", (target, existing, classification) => {
    const group = synthetic("cli", ["Bash(skills *)"], { "hands-off": "allow", prs: target });
    const value = input(
      { permissions: { allow: [...existing] } },
      { groups: [group], levels: { global: "ask", groups: {} } },
    );

    const result = plan(value);

    expect(result.changes[0]?.to).toBe(target);
    expect(result.changes[0]?.class).toBe(classification);
  });
});

describe("apply and refusals", () => {
  test("dedupe keeps target position and spelling, unrelated data and non strings", () => {
    const settings = document(
      '{"permissions":{"deny":[null,"Bash(example *)",false,"Bash(example:*)",{"keep":true}],"ask":["Bash(example:*)"],"allow":["Bash(example:*)"],"extra":"kept"},"other":12345678901234567890}',
    );

    const value = input(settings, { groups: [synthetic("example", ["Bash(example:*)"])] });
    const result = plan(value);

    expect(result.changes[0]?.text).toBe("Bash(example *)");

    applyRuleChanges(settings, result.changes);

    expect(settings).toEqual(
      document(
        '{"permissions":{"deny":[null,"Bash(example *)",false,{"keep":true}],"ask":[],"allow":["Bash(example:*)"],"extra":"kept"},"other":12345678901234567890}',
      ),
    );

    expect(plan(value).changes).toEqual([]);
  });

  test.each(["{}", '{"permissions":{"extra":true}}'])(
    "no insertions create no lists in %s",
    (json) => {
      const settings = document(json);
      const value = input(settings, { levels: { global: "off", groups: {} } });
      const snapshot = stringifyJson(settings);

      applyRuleChanges(settings, plan(value).changes);

      expect(stringifyJson(settings)).toBe(snapshot);
    },
  );

  test("insertion creates only its target list", () => {
    const settings: JsonObject = {};
    const value = input(settings, { groups: [synthetic("example", ["Bash(example *)"])] });

    applyRuleChanges(settings, plan(value).changes);

    expect(settings).toEqual({ permissions: { deny: ["Bash(example *)"] } });
  });

  test.each(["null", "true", "1", '"text"', "[]"])(
    "refuses permissions %s without mutation",
    (json) => {
      const settings = document(`{"permissions":${json}}`);
      const snapshot = stringifyJson(settings);

      expect(reconcileRules(input(settings))).toEqual({ refused: "permissions is not an object" });
      expect(stringifyJson(settings)).toBe(snapshot);
    },
  );

  for (const list of ["deny", "ask", "allow"])
    test.each(["null", "true", "1", '"text"', "{}"])(`refuses ${list} %s`, (json) => {
      const settings = document(`{"permissions":{"${list}":${json}}}`);
      expect(reconcileRules(input(settings))).toEqual({ refused: `${list} is not a list` });
    });
});

describe("removals, apply and notes", () => {
  test("a removal names the spelling found in the file", () => {
    const group = synthetic("tool", ["Bash(tool {agents} *)"], {
      "hands-off": "deny",
      prs: "absent",
    });

    const old = expandEntry("Bash(tool {agents} *)", defaults, home)[0]!;
    const result = plan(
      input(
        { permissions: { deny: [old] } },
        { groups: [group], current: { ...defaults, agents: "/moved" } },
      ),
    );

    expect(result.changes.map(({ text, to, class: kind }) => [text, to, kind])).toEqual([
      [old, "absent", "weakening"],
    ]);
  });

  test("moving a default spelling from ask to deny is weakening", () => {
    const group = synthetic("paths", ["Edit({agents})"]);
    const result = plan(
      input(
        { permissions: { ask: ["Edit(~/.agents/skills)"] } },
        { groups: [group], current: { ...defaults, agents: "/moved" } },
      ),
    );

    expect(result.changes.map(({ text, from, to, class: kind }) => [text, from, to, kind])).toEqual(
      [["Edit(//moved)", ["ask"], "deny", "weakening"]],
    );
  });

  test("applying an addition twice leaves one entry", () => {
    const settings: JsonObject = {};
    const result = plan(input(settings, { groups: groups.filter(({ id }) => id === "merge") }));

    applyRuleChanges(settings, result.changes);
    applyRuleChanges(settings, result.changes);

    expect(denyOf(settings)).toEqual(groupEntries("merge"));
  });

  test.each([
    [{ permissions: [] }, "permissions is not an object"],
    [{ permissions: { deny: "x" } }, "deny is not a list"],
  ])("apply refuses %j", (settings, message) => {
    const result = plan(input({}, { groups: groups.filter(({ id }) => id === "merge") }));
    expect(() => applyRuleChanges(settings as JsonObject, result.changes)).toThrow(message);
  });

  test("a guardrail at ask makes a personal allow dead", () => {
    const result = plan(
      input(
        { permissions: { ask: groupEntries("merge"), allow: ["Bash(gh pr merge --auto *)"] } },
        {
          groups: groups.filter(({ id }) => id === "merge"),
          levels: { global: "ask", groups: {} },
        },
      ),
    );

    expect(result.notes).toEqual([
      {
        kind: "dead-allow",
        text: "Bash(gh pr merge --auto *)",
        guardrail: "Bash(gh pr merge:*)",
        group: "merge",
      },
    ]);
  });

  test("a personal rule listed twice gives one note", () => {
    const result = plan(
      input({ permissions: { ask: ["Bash(git *)", "Bash(git *)"] } }, { mode: "prs" }),
    );

    const notes = result.notes.filter(({ text }) => text === "Bash(git *)");

    expect(notes).toHaveLength(new Set(notes.map((note) => JSON.stringify(note))).size);
    expect(notes.map((note) => (note.kind === "blocks" ? note.list : ""))).toEqual(
      notes.map(() => "ask"),
    );

    expect(notes.length).toBeGreaterThan(0);
  });
});
