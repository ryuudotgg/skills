import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghFixture } from "./gh-fake.ts";
import { removeTemporary, runCommand } from "../test/process.ts";

let temporary: string;

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "skills-gh-fake-"));
  writeFileSync(join(temporary, "pr_list.prefix"), "prefix\n");
  writeFileSync(join(temporary, "pr_list.prefix.exit"), "7\n");
  writeFileSync(join(temporary, "pr_list_--head_main"), "exact\n");
});

afterEach(async () => {
  await removeTemporary(temporary);
});

test("test-gh.sh: exact fixture wins over a prefix", () => {
  expect(ghFixture(temporary, ["pr", "list", "--head", "main"])).toEqual({ stdout: Buffer.from("exact\n"), stderr: "", code: 0 });
});

test("test-gh.sh: prefix output matches and exits 7", () => {
  expect(ghFixture(temporary, ["pr", "list", "--head", "feature"])).toEqual({ stdout: Buffer.from("prefix\n"), stderr: "", code: 7 });
});

test("test-gh.sh: no match exits 1 with the fixture diagnostic", () => {
  expect(ghFixture(temporary, ["pr", "view"])).toEqual({ stdout: Buffer.alloc(0), stderr: "gh stub: no fixture pr_view for: pr view\n", code: 1 });
});

test("gh fake replaces each multibyte code point with one underscore", () => {
  writeFileSync(join(temporary, "__a"), "unicode\n");
  expect(ghFixture(temporary, ["é😀a"]).stdout).toEqual(Buffer.from("unicode\n"));
});

test("gh fake preserves fixture bytes, ignores dotfiles and picks the first prefix", () => {
  writeFileSync(join(temporary, ".prefix"), "dotfile\n");
  writeFileSync(join(temporary, "pr_.prefix"), Buffer.from([0, 255, 13, 10]));
  writeFileSync(join(temporary, "pr_view.prefix"), "later\n");

  expect(ghFixture(temporary, ["pr", "view"]).stdout).toEqual(Buffer.from([0, 255, 13, 10]));
});

test("gh entry appends calls to GH_STUB_LOG before serving fixtures", async () => {
  const log = join(temporary, "gh.log");
  const env = { ...process.env, GH_STUB_DIR: temporary, GH_STUB_LOG: log };
  const argv = [join(import.meta.dir, "../../scripts/stubs/gh")];
  const exact = await runCommand([...argv, "pr", "list", "--head", "main"], { cwd: temporary, env });
  const miss = await runCommand([...argv, "pr", "view"], { cwd: temporary, env });

  expect(exact.code).toBe(0);
  expect(exact.stdout).toBe("exact\n");
  expect(exact.stderr).toBe("");

  const prefix = await runCommand([...argv, "pr", "list", "--head", "feature"], { cwd: temporary, env });
  expect(prefix).toMatchObject({ code: 7, stdout: "prefix\n", stderr: "" });

  expect(miss.code).toBe(1);
  expect(miss.stderr).toBe("gh stub: no fixture pr_view for: pr view\n");
  expect(readFileSync(log, "utf8")).toBe("pr list --head main\npr view\npr list --head feature\n");
});

test("gh stub resolves its source from the real location through a symlink", async () => {
  const executable = join(temporary, "gh");
  symlinkSync(join(import.meta.dir, "../../scripts/stubs/gh"), executable);

  const result = await runCommand([executable, "pr", "list", "--head", "main"], { cwd: temporary, env: { ...process.env, GH_STUB_DIR: temporary } });
  expect(result).toMatchObject({ code: 0, stdout: "exact\n", stderr: "" });
});

test("gh entry requires a nonempty GH_STUB_DIR", async () => {
  for (const value of [undefined, ""]) {
    const env = { ...process.env, GH_STUB_DIR: value };
    const result = await runCommand([process.execPath, "--no-env-file", join(import.meta.dir, "gh.ts")], { cwd: temporary, env });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("gh stub: GH_STUB_DIR required\n");
  }
});

test("a non numeric exit file exits 2 after the fixture output", () => {
  writeFileSync(join(temporary, "pr_view"), "out\n");
  writeFileSync(join(temporary, "pr_view.exit"), "abc\n");

  const result = ghFixture(temporary, ["pr", "view"]);
  expect(result.code).toBe(2);
  expect(result.stdout.toString()).toBe("out\n");
});
