import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghFixture, hasFixtures } from "./gh-fake.ts";
import { removeTemporary, runCommand, startCommand } from "../test/process.ts";

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
  expect(ghFixture(temporary, ["pr", "list", "--head", "main"])).toEqual({
    stdout: Buffer.from("exact\n"),
    stderr: "",
    code: 0,
  });
});

test("test-gh.sh: prefix output matches and exits 7", () => {
  expect(ghFixture(temporary, ["pr", "list", "--head", "feature"])).toEqual({
    stdout: Buffer.from("prefix\n"),
    stderr: "",
    code: 7,
  });
});

test("test-gh.sh: no match exits 1 with the fixture diagnostic", () => {
  expect(ghFixture(temporary, ["pr", "view"])).toEqual({
    stdout: Buffer.alloc(0),
    stderr: "gh stub: no fixture pr_view for: pr view\n",
    code: 1,
  });
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
  const exact = await runCommand([...argv, "pr", "list", "--head", "main"], {
    cwd: temporary,
    env,
  });

  const miss = await runCommand([...argv, "pr", "view"], { cwd: temporary, env });

  expect(exact.code).toBe(0);
  expect(exact.stdout).toBe("exact\n");
  expect(exact.stderr).toBe("");

  const prefix = await runCommand([...argv, "pr", "list", "--head", "feature"], {
    cwd: temporary,
    env,
  });

  expect(prefix).toMatchObject({ code: 7, stdout: "prefix\n", stderr: "" });

  expect(miss.code).toBe(1);
  expect(miss.stderr).toBe("gh stub: no fixture pr_view for: pr view\n");
  expect(readFileSync(log, "utf8")).toBe("pr list --head main\npr view\npr list --head feature\n");
});

test("gh stub resolves its source from the real location through a symlink", async () => {
  const executable = join(temporary, "gh");
  symlinkSync(join(import.meta.dir, "../../scripts/stubs/gh"), executable);

  const result = await runCommand([executable, "pr", "list", "--head", "main"], {
    cwd: temporary,
    env: { ...process.env, GH_STUB_DIR: temporary },
  });

  expect(result).toMatchObject({ code: 0, stdout: "exact\n", stderr: "" });
});

test("gh entry requires a nonempty GH_STUB_DIR", async () => {
  for (const value of [undefined, ""]) {
    const env = { ...process.env, GH_STUB_DIR: value };
    const result = await runCommand(
      [process.execPath, "--no-env-file", join(import.meta.dir, "gh.ts")],
      { cwd: temporary, env },
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("gh stub: GH_STUB_DIR required\n");
  }
});

test("the shared entry serves opencode fixtures without reading stdin", async () => {
  const log = join(temporary, "opencode.log");
  writeFileSync(join(temporary, "run.prefix"), "opencode output\n");

  const child = Bun.spawn(
    [process.execPath, "--no-env-file", join(import.meta.dir, "gh.ts"), "run", "--model", "test"],
    {
      cwd: temporary,
      env: { ...process.env, GH_STUB_DIR: temporary, GH_STUB_LOG: log },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  try {
    const code = await Promise.race([child.exited, Bun.sleep(5_000).then(() => "stdin blocked")]);

    expect(code).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("opencode output\n");
    expect(await new Response(child.stderr).text()).toBe("");
    expect(readFileSync(log, "utf8")).toBe("run --model test\n");
  } finally {
    child.stdin.end();
    child.kill();
    await child.exited;
  }
});

test("a non numeric exit file exits 2 after the fixture output", () => {
  writeFileSync(join(temporary, "pr_view"), "out\n");
  writeFileSync(join(temporary, "pr_view.exit"), "abc\n");

  const result = ghFixture(temporary, ["pr", "view"]);
  expect(result.code).toBe(2);
  expect(result.stdout.toString()).toBe("out\n");
});

test("an executable fixture inherits argv, stdin, cwd and env and ignores its exit file", async () => {
  writeFileSync(
    join(temporary, "run_.prefix"),
    `#!/bin/sh
set -eu
test -f cwd-marker
printf '%s\n' "$@"
printf '%s\n' "$FIXTURE_TOKEN"
cat
printf 'fixture error\n' >&2
exit 9
`,
    { mode: 0o744 },
  );

  writeFileSync(join(temporary, "run_.prefix.exit"), "5\n");
  writeFileSync(join(temporary, "cwd-marker"), "");

  const { child, result } = startCommand(
    [process.execPath, "--no-env-file", join(import.meta.dir, "gh.ts"), "run", "two words"],
    {
      cwd: temporary,
      env: { ...process.env, GH_STUB_DIR: temporary, FIXTURE_TOKEN: "inherited" },
      input: true,
    },
  );

  child.stdin!.end("prompt from stdin\n");

  expect(await result).toMatchObject({
    code: 9,
    stdout: "run\ntwo words\ninherited\nprompt from stdin\n",
    stderr: "fixture error\n",
    timedOut: false,
  });
});

test("dotfiles do not turn a forbidden command into a fixture directory", () => {
  const directory = join(temporary, "empty");
  mkdirSync(directory);
  writeFileSync(join(directory, ".keep"), "");

  expect(hasFixtures(directory)).toBe(false);
  expect(ghFixture(directory, ["--version"])).toEqual({
    stdout: Buffer.alloc(0),
    stderr: "stub: this case forbids this command\n",
    code: 1,
  });
});

function runOpencodeFixture(input: string, config: string, cwd: string) {
  const { child, result } = startCommand(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "gh.ts"),
      "run",
      "--standalone",
      "--auto",
      "--format",
      "json",
      "-m",
      "vendor/sol-model#high",
    ],
    {
      cwd,
      env: {
        ...process.env,
        GH_STUB_DIR: join(import.meta.dir, "../../evals/cases/opencode-single-seats/opencode"),
        OPENCODE_CONFIG_CONTENT: config,
      },
      input: true,
    },
  );

  child.stdin!.end(input);
  return result;
}

const playbook = join(import.meta.dir, "../../skills/playbook");

function referenceSet(index: number): string {
  const blocks = readFileSync(join(playbook, "references/codex-arms.md"), "utf8").split(
    "```json\n",
  );

  return blocks[index]!.split("\n```")[0]!;
}

const readOnlySet = referenceSet(1);
const writeSet = referenceSet(2);
const weakenedReadOnlySet = JSON.stringify({
  permissions: JSON.parse(readOnlySet).permissions.filter(
    (rule: { resource: string }) => rule.resource !== "*>*",
  ),
});

function withPlaybook(directory: string): string {
  mkdirSync(join(directory, ".claude/skills"), { recursive: true });
  symlinkSync(playbook, join(directory, ".claude/skills/playbook"));
  return directory;
}

test("the single seats case rejects a review without the read only permission set", async () => {
  const repo = withPlaybook(join(temporary, "review-only"));
  for (const config of ["", '{"permissions":[]}', writeSet, weakenedReadOnlySet]) {
    const result = await runOpencodeFixture("review", config, repo);

    expect(result).toMatchObject({
      code: 3,
      stdout: "",
      stderr: "opencode stub: this arm needs the read only permission set\n",
      timedOut: false,
    });
  }
});

test("the single seats case rejects an implementation without the write permission set", async () => {
  const result = await runOpencodeFixture(
    "The branch is already the right one",
    readOnlySet,
    withPlaybook(join(temporary, "write-only")),
  );

  expect(result).toMatchObject({
    code: 3,
    stdout: "",
    stderr: "opencode stub: this arm needs the write permission set\n",
    timedOut: false,
  });
});

test("the single seats case implements muted members and leaves its review read only", async () => {
  const repo = join(temporary, "project");
  cpSync(join(import.meta.dir, "../../evals/cases/opencode-single-seats/fixture"), repo, {
    recursive: true,
  });

  withPlaybook(repo);

  const testPath = join(repo, "test/broadcast.test.js");
  const original = readFileSync(testPath, "utf8");
  const implementation = await runOpencodeFixture(
    "The branch is already the right one",
    writeSet,
    repo,
  );

  expect(implementation.code).toBe(0);
  expect(JSON.parse(implementation.stdout)).toEqual({
    type: "text",
    part: {
      messageID: "m1",
      text: "broadcastToRoom skips muted members and the new test covers it.",
    },
  });

  const broadcast = readFileSync(join(repo, "src/chat/broadcast.js"), "utf8");
  const extended = readFileSync(testPath, "utf8");
  expect(broadcast).toContain("if (member.muted) continue;");
  expect(extended).toStartWith(original);
  expect(extended).toContain('test("muted members are skipped"');
  expect((await runCommand(["node", "--test", "test/broadcast.test.js"], { cwd: repo })).code).toBe(
    0,
  );

  const review = await runOpencodeFixture("Review the diff read only", readOnlySet, repo);

  expect(review.code).toBe(0);
  expect(JSON.parse(review.stdout)).toEqual({
    type: "text",
    part: {
      messageID: "m1",
      text: "No findings. broadcastToRoom skips muted members and the new test covers it.",
    },
  });

  expect(readFileSync(join(repo, "src/chat/broadcast.js"), "utf8")).toBe(broadcast);
  expect(readFileSync(testPath, "utf8")).toBe(extended);
});

test("an executable fixture killed by a signal fails the stubbed command", () => {
  const directory = join(temporary, "signalled");
  mkdirSync(directory);
  writeFileSync(join(directory, "run.prefix"), "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 });

  expect(ghFixture(directory, ["run"]).code).toBe(1);
});
