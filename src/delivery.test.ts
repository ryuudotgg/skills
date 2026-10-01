import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDelivery } from "./delivery.ts";
import { writeFixture } from "./test/fixtures.ts";
import { removeTemporary } from "./test/process.ts";

let temporary: string;
let root: string;
let home: string;
let conf: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "skills-delivery-"));
  root = join(temporary, "skills");
  home = join(temporary, "home");
  conf = join(temporary, "skills.conf");
  await mkdir(home);

  for (const [name, frontmatter] of Object.entries({
    greptile: "optional: true\nrequires: prs",
    quoted: 'optional: true\nrequires: "prs"',
    plain: "name: plain",
    spaced: "optional: true\nrequires : prs",
    nested: "optional: true\nmetadata:\n  requires: prs",
    loose: "optional: true",
  }))
    await writeFixture(root, `${name}/SKILL.md`, `---\n${frontmatter}\n---\n`);
});

afterEach(async () => {
  await removeTemporary(temporary);
});

async function delivery(content: string) {
  await writeFile(conf, content);
  return readDelivery(root, { HOME: home, SKILLS_CONF: conf });
}

describe("delivery-mode case ledger", () => {
  test("no config and missing SKILLS_CONF are quiet hands-off", () => {
    for (const env of [{ HOME: home }, { SKILLS_CONF: conf }, { HOME: "", SKILLS_CONF: "" }, {}])
      expect(readDelivery(root, env)).toEqual({ mode: "hands-off", active: [], notes: [] });
  });

  test("empty SKILLS_CONF uses HOME and empty HOME has no fallback", async () => {
    await writeFixture(home, ".agents/skills.conf", "DELIVERY=prs\n");
    expect(readDelivery(root, { HOME: home, SKILLS_CONF: "" }).mode).toBe("prs");
    expect(readDelivery(root, { HOME: "", SKILLS_CONF: "" }).mode).toBe("hands-off");
  });

  test("relative SKILLS_CONF is noted without reading it", () => {
    expect(readDelivery(root, { SKILLS_CONF: "skills.conf" })).toEqual({
      mode: "hands-off",
      active: [],
      notes: ["config path is not absolute: skills.conf"],
    });
  });

  test("directory config and dangling symlink are not readable regular files", async () => {
    await mkdir(conf);
    const dangling = join(temporary, "dangling");
    await symlink(join(temporary, "missing"), dangling);

    for (const path of [conf, dangling])
      expect(readDelivery(root, { SKILLS_CONF: path }).notes).toEqual([
        `${path}: not a readable regular file`,
      ]);
  });

  test.skipIf(process.getuid?.() === 0)("unreadable config", async () => {
    await writeFile(conf, "DELIVERY=prs\n");
    await chmod(conf, 0);

    expect(readDelivery(root, { SKILLS_CONF: conf }).notes).toEqual([
      `${conf}: not a readable regular file`,
    ]);
  });

  const malformed = [
    ["quoted value", 'DELIVERY="prs"\n', 1],
    ["export prefix", "export DELIVERY=prs\n", 1],
    ["command injection", "DELIVERY=prs; touch marker\n", 1],
    ["unknown key", "DELIVER=prs\n", 1],
    ["leading space", " DELIVERY=prs\n", 1],
    ["duplicate key", "DELIVERY=prs\nDELIVERY=prs\n", 2],
    ["duplicate WITH", "WITH=greptile\nWITH=\n", 2],
    ["bad last line without newline", "DELIVERY=prs\nWITH=greptile\nbad line", 3],
    ["glob in WITH", "DELIVERY=prs\nWITH=*\n", 2],
    ["path escape in WITH", "DELIVERY=prs\nWITH=../playbook\n", 2],
    ["two trailing CR characters", "DELIVERY=prs\r\r\n", 1],
    ["blank line with spaces", "DELIVERY=prs\n \n", 2],
    ["malformed WITH spacing", "DELIVERY=prs\nWITH=greptile  loose\n", 2],
  ] as const;

  for (const [name, content, line] of malformed)
    test(name, async () => {
      expect(await delivery(content)).toEqual({
        mode: "hands-off",
        active: [],
        notes: [`${conf}: line ${line}: malformed, ignoring the file`],
      });
    });

  for (const [name, suffix] of [
    ["prs with greptile", ""],
    ["reviewer setting", "GREPTILE_REREVIEWS=3\n"],
    ["reviewer named with a leading digit", "4BOT_ROLE=required\n"],
    ["invalid reviewer setting", "GREPTILE_REREVIEWS=lots\n"],
  ])
    test(name!, async () => {
      expect(await delivery(`DELIVERY=prs\nWITH=greptile\n${suffix}`)).toEqual({
        mode: "prs",
        active: ["greptile"],
        notes: [],
      });
    });

  test("CRLF config and comments and blank lines", async () => {
    expect(
      await delivery("# delivery\r\n\r\nDELIVERY=prs\r\n# extensions\r\nWITH=greptile\r\n"),
    ).toEqual({ mode: "prs", active: ["greptile"], notes: [] });
  });

  test("hands-off with greptile", async () => {
    expect(await delivery("DELIVERY=hands-off\nWITH=greptile\n")).toEqual({
      mode: "hands-off",
      active: [],
      notes: ["greptile dropped: requires DELIVERY=prs"],
    });
  });

  test("mixed extensions dedupe in order with ordered notes", async () => {
    expect(
      await delivery(
        "DELIVERY=prs\nWITH=greptile missing plain quoted prs greptile loose loose missing\n",
      ),
    ).toEqual({
      mode: "prs",
      active: ["greptile", "loose"],
      notes: [
        "missing dropped: not installed",
        "plain dropped: not an extension",
        "quoted dropped: unknown requires",
        "prs dropped: prs is a mode, set DELIVERY=prs",
      ],
    });
  });

  test("hands-off with loose requires keys", async () => {
    expect((await delivery("DELIVERY=hands-off\nWITH=spaced nested\n")).notes).toEqual([
      "spaced dropped: unknown requires",
      "nested dropped: unknown requires",
    ]);
  });

  test("no DELIVERY defaults to hands-off and optional without requires stays active", async () => {
    expect(await delivery("WITH=loose\n")).toEqual({
      mode: "hands-off",
      active: ["loose"],
      notes: [],
    });
  });

  test("WITH before DELIVERY and final line without newline", async () => {
    expect(await delivery("WITH=greptile\nDELIVERY=prs")).toEqual({
      mode: "prs",
      active: ["greptile"],
      notes: [],
    });
  });

  test("symlinked playbook resolves the real skills root", async () => {
    const linked = join(temporary, "linked");
    await symlink(root, linked);
    await writeFile(conf, "DELIVERY=prs\nWITH=greptile\n");

    expect(readDelivery(linked, { SKILLS_CONF: conf })).toEqual({
      mode: "prs",
      active: ["greptile"],
      notes: [],
    });
  });

  const verdicts = [
    ["first line must be ---", "\n---\noptional: true\n---\n", "not an extension"],
    ["unclosed frontmatter", "---\noptional: true\n", "not an extension"],
    ["exact optional line", "---\noptional: true \n---\n", "not an extension"],
    ["optional outside frontmatter", "---\nname: plain\n---\noptional: true\n", "not an extension"],
    [
      "requires merely contained",
      "---\noptional: true\ndescription: requires care\n---\n",
      "unknown requires",
    ],
    [
      "unknown requires stays unknown",
      "---\noptional: true\nrequires: other\nrequires: prs\n---\n",
      "unknown requires",
    ],
  ] as const;

  for (const [name, content, note] of verdicts)
    test(name, async () => {
      await writeFixture(root, "custom/SKILL.md", content);

      expect((await delivery("DELIVERY=prs\nWITH=custom\n")).notes).toEqual([
        `custom dropped: ${note}`,
      ]);
    });

  test("SKILL.md must be a file", async () => {
    await mkdir(join(root, "directory/SKILL.md"), { recursive: true });

    expect((await delivery("WITH=directory\n")).notes).toEqual([
      "directory dropped: not installed",
    ]);
  });
});
