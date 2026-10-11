import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { areas } from "./cli.ts";
import { readRuleGroups } from "./deny-set.ts";

test("CLI allow rules match registry declarations at both paths", () => {
  const verbs = areas.flatMap((area) => area.verbs);
  const groups = readRuleGroups(resolve(import.meta.dir, "../skills"));
  const covered = new Set<string>();
  for (const entry of groups
    .filter((group) => group.kind === "allow")
    .flatMap((group) => group.entries)) {
    const match =
      /^Bash\((\{claude\}\/skills|\{agents\})\/playbook\/bin\/skills ([a-z-]+(?: [a-z-]+)*) \*\)$/.exec(
        entry,
      );

    expect(match, `Allow entry is not one CLI verb: ${entry}`).not.toBeNull();

    const verb = verbs.find((verb) => verb.name.join(" ") === match![2]);
    expect(verb, `Unknown CLI verb in allow entry: ${entry}`).toBeDefined();
    expect(verb!.allow, `CLI verb disallows allow entry: ${entry}`).toBe(true);
    covered.add(`${match![1]} ${match![2]}`);
  }

  for (const verb of verbs.filter((verb) => verb.allow))
    for (const prefix of ["{claude}/skills", "{agents}"])
      expect(
        covered.has(`${prefix} ${verb.name.join(" ")}`),
        `Missing ${prefix} allow for ${verb.name.join(" ")}`,
      ).toBe(true);
});
