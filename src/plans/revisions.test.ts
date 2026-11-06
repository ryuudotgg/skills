import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../io.ts";
import { recordWorkingCopies } from "./commit.ts";
import { importStore } from "./import.ts";
import { COLUMNS } from "./index-tsv.ts";
import { readPlan } from "./brief.ts";
import { checkoutVerb, historyVerb, parseTime, showVerb } from "./revisions.ts";
import { sha256 } from "./store.ts";
import { closePlan, type Stamp } from "./verbs.ts";
import { LOG_HEADER } from "./trail.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function plans(): { root: string; env: NodeJS.ProcessEnv; plan: string } {
  const root = mkdtempSync(join(tmpdir(), "skills-revisions-"));
  temporary.push(root);

  mkdirSync(join(root, "Skills", "done"), { recursive: true });
  const row = ["007", "seven", "TODO", "P1", "S", "-", "-", "-", "2026-10-31", "-"].join("\t");
  writeFileSync(join(root, "Skills", "index.tsv"), `${COLUMNS.join("\t")}\n${row}\n`);
  writeFileSync(join(root, "log.tsv"), LOG_HEADER);

  const plan = join(root, "Skills", "007-seven.md");
  writeFileSync(plan, "# 007 seven\n");
  writeFileSync(join(root, "Skills", "ctx-batch.md"), "# ctx-batch\n");

  return { root, env: { PLANS_DIR: root }, plan };
}

function capture(env: NodeJS.ProcessEnv): Io & { stdout: string; stderr: string } {
  const io = {
    cwd: "/",
    env,
    capture: true,
    stdout: "",
    stderr: "",
    out(text: string) {
      io.stdout += text;
    },
    err(text: string) {
      io.stderr += text;
    },
  };

  return io;
}

async function history(env: NodeJS.ProcessEnv, key = "007"): Promise<string[][]> {
  const io = capture(env);
  expect(await historyVerb(["Skills", key], "usage", io)).toBe(0);
  return io.stdout
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
}

test("parseTime reads instants and whole UTC days", () => {
  expect(parseTime("2026-10-31T15:25:31Z")).toBe(Date.parse("2026-10-31T15:25:31Z"));
  expect(parseTime("2026-10-31T15:25:31.250Z")).toBe(Date.parse("2026-10-31T15:25:31.250Z"));
  expect(parseTime("2026-10-31")).toBe(Date.parse("2026-10-31T23:59:59.999Z"));

  expect(parseTime("2026-02-30")).toBeUndefined();
  expect(parseTime("2026-02-30T00:00:00Z")).toBeUndefined();
  expect(parseTime("2026-10-31T24:00:00Z")).toBeUndefined();
  expect(parseTime("2026-10-31T15:25:31+01:00")).toBeUndefined();
  expect(parseTime("yesterday")).toBeUndefined();
});

test("a recorded edit adds one history line whose sha matches the file", async () => {
  const { root, env, plan } = plans();
  await importStore(env);

  const [first] = await history(env);
  expect(first?.[1]).toBe(sha256("# 007 seven\n"));
  expect(first?.[3]).toBe(String("# 007 seven\n".length));

  writeFileSync(plan, "# 007 seven, edited\n");
  await recordWorkingCopies(root, [plan]);
  await recordWorkingCopies(root, [plan]);

  const lines = await history(env);
  expect(lines).toHaveLength(2);
  expect(lines.at(-1)?.[1]).toBe(sha256(readFileSync(plan)));
});

test("show prints the newest revision at or before a time", async () => {
  const { root, env, plan } = plans();
  await importStore(env);
  await Bun.sleep(5);

  const between = new Date().toISOString();
  await Bun.sleep(5);
  writeFileSync(plan, "# 007 seven, edited\n");
  await recordWorkingCopies(root, [plan]);

  const now = capture(env);
  expect(await showVerb(["Skills", "007"], "usage", now)).toBe(0);
  expect(now.stdout).toBe("# 007 seven, edited\n");

  const then = capture(env);
  expect(await showVerb(["Skills", "007", "--at", between], "usage", then)).toBe(0);
  expect(then.stdout).toBe("# 007 seven\n");

  const today = capture(env);
  expect(await showVerb(["Skills", "007", "--at", between.slice(0, 10)], "usage", today)).toBe(0);
  expect(today.stdout).toBe("# 007 seven, edited\n");

  const before = capture(env);
  expect(await showVerb(["Skills", "007", "--at", "2000-01-01"], "usage", before)).toBe(1);
  expect(before.stderr).toContain("no revision of 007 at or before 2000-01-01");

  const ctx = capture(env);
  expect(await showVerb(["Skills", "ctx-batch"], "usage", ctx)).toBe(0);
  expect(ctx.stdout).toBe("# ctx-batch\n");
});

test("checkout writes a missing copy, reports a current one and refuses a changed one", async () => {
  const { env, plan } = plans();
  await importStore(env);
  rmSync(plan);

  const written = capture(env);
  expect(await checkoutVerb(["Skills", "007"], "usage", written)).toBe(0);
  expect(written.stdout).toBe(`${plan} written\n`);
  expect(readFileSync(plan, "utf8")).toBe("# 007 seven\n");

  const current = capture(env);
  expect(await checkoutVerb(["Skills", "007"], "usage", current)).toBe(0);
  expect(current.stdout).toBe(`${plan} current\n`);

  writeFileSync(plan, "# 007 seven, unrecorded\n");
  const changed = capture(env);
  expect(await checkoutVerb(["Skills", "007"], "usage", changed)).toBe(1);
  expect(changed.stderr).toContain(plan);
  expect(readFileSync(plan, "utf8")).toBe("# 007 seven, unrecorded\n");
});

test("the verbs refuse an unknown key and bad arguments", async () => {
  const { env } = plans();
  await importStore(env);

  const missing = capture(env);
  expect(await historyVerb(["Skills", "042"], "usage", missing)).toBe(1);
  expect(missing.stderr).toBe("history: no revisions of 042 in Skills\n");

  expect(await historyVerb(["Skills", "seven"], "usage", capture(env))).toBe(2);
  expect(await showVerb(["Skills", "007", "--at"], "usage", capture(env))).toBe(2);
  expect(await checkoutVerb(["Skills"], "usage", capture(env))).toBe(2);
});

test("a closed plan's history runs across its move into done", async () => {
  const { root, env, plan } = plans();
  await importStore(env);

  const moved = join(root, "Skills", "done", "007-seven.md");
  rmSync(plan);
  writeFileSync(moved, "# 007 seven, closed\n");
  await recordWorkingCopies(root, [moved]);

  const lines = await history(env);
  expect(lines).toHaveLength(2);
  expect(existsSync(plan)).toBe(false);

  const io = capture(env);
  expect(await checkoutVerb(["Skills", "007"], "usage", io)).toBe(0);
  expect(io.stdout).toBe(`${moved} current\n`);
});

function close(root: string, env: NodeJS.ProcessEnv, stamp: Stamp) {
  return closePlan({
    index: join(root, "Skills", "index.tsv"),
    project: "Skills",
    id: "007",
    status: "DONE",
    note: "shipped",
    stamp,
    dryRun: false,
    env,
  });
}

test("close records the edit it reads and the stamped copy in done", async () => {
  const { root, env, plan } = plans();
  await importStore(env);

  const draft = "# 007 seven\n\n## Landed\n\nBranch feat/seven, not merged yet.\nShipped.\n";
  writeFileSync(plan, draft);

  const merged = "Merged as abc1234 (PR 1, branch feat/seven).";
  const result = await close(root, env, async () => merged);
  expect(result.kind).toBe("closed");

  const lines = await history(env);
  expect(lines.map((line) => line[1])).toEqual([
    sha256("# 007 seven\n"),
    sha256(draft),
    sha256(draft.replace("Branch feat/seven, not merged yet.", merged)),
  ]);

  const io = capture(env);
  expect(await checkoutVerb(["Skills", "007"], "usage", io)).toBe(0);
  expect(io.stdout).toBe(`${join(root, "Skills", "done", "007-seven.md")} current\n`);
});

test("close refuses a plan edited while it waited, keeping the edit", async () => {
  const { root, env, plan } = plans();
  await importStore(env);
  writeFileSync(plan, "# 007 seven\n\n## Landed\n\nBranch feat/seven, not merged yet.\n");

  const late = "# 007 seven\n\n## Landed\n\nBranch feat/seven, not merged yet.\nLate.\n";
  const result = await close(root, env, async () => {
    writeFileSync(plan, late);
    return "Merged as abc1234 (PR 1, branch feat/seven).";
  });

  expect(result).toEqual({
    kind: "refused",
    reason: `${plan} changed during close, retry`,
    draftless: undefined,
  });

  expect(readFileSync(plan, "utf8")).toBe(late);
  expect((await history(env)).at(-1)?.[1]).toBe(sha256(late));
});

test("close refuses an edit another verb recorded while it waited", async () => {
  const { root, env, plan } = plans();
  await importStore(env);
  writeFileSync(plan, "# 007 seven\n\n## Landed\n\nBranch feat/seven, not merged yet.\n");

  const late = "# 007 seven\n\n## Landed\n\nBranch feat/seven, not merged yet.\nLinted.\n";
  const result = await close(root, env, async () => {
    writeFileSync(plan, late);
    await recordWorkingCopies(root, [plan]);
    return "Merged as abc1234 (PR 1, branch feat/seven).";
  });

  expect(result.kind).toBe("refused");
  expect(readFileSync(plan, "utf8")).toBe(late);
});

test("checkout refuses when another path holds the plan", async () => {
  const { root, env, plan } = plans();
  await importStore(env);

  const moved = join(root, "Skills", "done", "007-seven.md");
  writeFileSync(moved, readFileSync(plan));
  rmSync(plan);

  const io = capture(env);
  expect(await checkoutVerb(["Skills", "007"], "usage", io)).toBe(1);
  expect(io.stderr).toBe(`checkout: ${moved} holds 007, not ${plan}\n`);
  expect(existsSync(plan)).toBe(false);
});

test("brief records the plan it reads", async () => {
  const { env, plan } = plans();
  await importStore(env);
  writeFileSync(plan, "---\nsurface: cli\n---\n# 007 seven, briefed\n");

  await readPlan("Skills", "007", env);

  expect((await history(env)).at(-1)?.[1]).toBe(sha256(readFileSync(plan)));
});

test("checkout refuses a filesystem error instead of throwing", async () => {
  const { env, plan } = plans();
  await importStore(env);
  rmSync(plan);
  mkdirSync(plan);

  const io = capture(env);
  expect(await checkoutVerb(["Skills", "007"], "usage", io)).toBe(1);
  expect(io.stderr).toBe(`checkout: ${plan}: EISDIR\n`);
});

test("recording skips an unreadable plan and returns the bytes it recorded", async () => {
  const { root, env, plan } = plans();
  await importStore(env);

  const unreadable = join(root, "Skills", "008-eight.md");
  mkdirSync(unreadable);
  writeFileSync(plan, "# 007 seven, read once\n");

  const copies = await recordWorkingCopies(root, [plan, unreadable]);

  expect([...copies.keys()]).toEqual([plan]);
  expect(Buffer.from(copies.get(plan)!).toString("utf8")).toBe("# 007 seven, read once\n");
  expect((await history(env)).at(-1)?.[1]).toBe(sha256("# 007 seven, read once\n"));
});

test("checkout refuses when the done folder cannot be read", async () => {
  const { root, env, plan } = plans();
  await importStore(env);
  rmSync(plan);
  rmSync(join(root, "Skills", "done"), { recursive: true });
  writeFileSync(join(root, "Skills", "done"), "not a folder\n");

  const io = capture(env);
  expect(await checkoutVerb(["Skills", "007"], "usage", io)).toBe(1);
  expect(io.stderr).toBe(`checkout: ${plan}: ENOTDIR\n`);
  expect(existsSync(plan)).toBe(false);
});
