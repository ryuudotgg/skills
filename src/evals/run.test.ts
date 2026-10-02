import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Context } from "../registry.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { shellQuote } from "../shell.ts";

const source = resolve(import.meta.dir, "../..");
const bin = join(source, "skills/playbook/bin/skills");
const artifacts = ["transcript.jsonl", "digest.txt", "status.txt", "commits.txt", "diff.patch", "remote.txt", "baseline.txt"];
const fakeClaude = `#!/bin/bash
set -eu
if [[ "$*" == *"--model opus"* ]]; then
  cat > grader-input.txt
  printf 'plans=%s\ntoken=%s\nshell=%s\n' "$PLANS_DIR" "\${GH_TOKEN:-}" "$SHELL" > grader-env.txt
  case "\${EVAL_GRADE:-pass}" in
    fail) printf 'failed grade\n'; exit 7 ;;
    empty) exit 0 ;;
    long) printf 'Prompt is too long\n'; exit 0 ;;
    *) printf 'PASS test\n1 pass\n'; exit 0 ;;
  esac
fi
repo=$PWD
while [ "$repo" != / ] && [ ! -d "$repo/.claude" ]; do
  repo=$(dirname "$repo")
done
[ -d "$repo/.claude" ]
out=$(cd "$repo/../.." && pwd)
printf '%s\n' "$@" > "$out/argv.txt"
"$SHELL" -l -i -c '.claude/skills/playbook/bin/skills delivery 2>/dev/null | head -1; echo "startup=\${EVAL_STARTUP_DONE:-}"; ls .claude/skills' > "$out/stub-result.txt" 2> "$out/stub-stderr.txt"
{
  git remote get-url origin
  if [ "$(git rev-parse main)" = "$(git rev-parse origin/main)" ]; then
    echo origin=same
  else
    echo origin=differs
  fi
  printf 'dirty=%s\n' "$(git status --porcelain | wc -l | tr -d ' ')"
  command -v gh || true
  printf 'GH_TOKEN=%s\nGITHUB_TOKEN=%s\nGH_ENTERPRISE_TOKEN=%s\nGITHUB_ENTERPRISE_TOKEN=%s\n' "\${GH_TOKEN+set}" "\${GITHUB_TOKEN+set}" "\${GH_ENTERPRISE_TOKEN+set}" "\${GITHUB_ENTERPRISE_TOKEN+set}"
  printf 'plans=%s\n' "$PLANS_DIR"
} >> "$out/stub-result.txt"
if [ -n "\${GH_STUB_DIR:-}" ] && [ "\${EVAL_GH:-call}" != skip ]; then
  gh --version > /dev/null
fi
case "\${EVAL_TRANSCRIPT:-plain}" in
  empty) exit 0 ;;
  invalid) printf '\\377'; exit 0 ;;
  hidden)
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"probe","name":"Bash","input":{"command":"which eval-hidden-command"}}]}}' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"probe","content":"eval-hidden-command not found"}]}}'
    ;;
  leaked)
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"probe","name":"Bash","input":{"command":"which eval-hidden-command"}}]}}' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"probe","content":"/not-here/eval-hidden-command"}]}}'
    ;;
esac
printf '%s\n' '{"type":"result","result":"ok"}'
exit "\${EVAL_AGENT_EXIT:-0}"
`;

setDefaultTimeout(60_000);

let temporary: string;
let root: string;
let env: NodeJS.ProcessEnv;
let names: string[];

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "skills-eval-run-"));
  root = join(temporary, "root");
  names = [];
  for (const directory of ["root/skills", "root/agents", "bin", "home/.agents"]) mkdirSync(join(temporary, directory), { recursive: true });

  for (const name of readdirSync(join(source, "skills"))) symlinkSync(join(source, "skills", name), join(root, "skills", name));
  for (const name of readdirSync(join(source, "agents"))) symlinkSync(join(source, "agents", name), join(root, "agents", name));

  mkdirSync(join(root, "skills/fixture-optional"));
  writeFileSync(join(root, "skills/fixture-optional/SKILL.md"), "---\nname: fixture-optional\ndescription: eval fixture extension\noptional: true\n---\n");
  const conf = join(temporary, "home/.agents/skills.conf");
  writeFileSync(conf, "DELIVERY=prs\nWITH=greptile\n");

  for (const file of [".zprofile", ".zshrc", ".bash_profile"])
    writeFileSync(join(temporary, "home", file), `export SKILLS_CONF=${shellQuote(conf)}\n${file === ".zshrc" ? "export EVAL_STARTUP_DONE=1\n" : ""}`);

  writeFileSync(join(temporary, "bin/claude"), fakeClaude, { mode: 0o755 });
  writeFileSync(join(temporary, "bin/eval-hidden-command"), "#!/bin/sh\nprintf 'hidden command\\n'\n", { mode: 0o755 });
  env = { ...suiteEnvironment(), PATH: `${join(temporary, "bin")}:${process.env.PATH}`, HOME: join(temporary, "home"), SHELL: "/bin/bash", GH_TOKEN: "leak", GITHUB_TOKEN: "leak", GH_ENTERPRISE_TOKEN: "leak", GITHUB_ENTERPRISE_TOKEN: "leak" };
});

afterEach(async () => {
  await removeTemporary(temporary);
  for (const name of names) await removeTemporary(join("/tmp/evals", name));
});

function makeCase(label: string): string {
  const name = `run-test-${label}-${process.pid}-${crypto.randomUUID()}`;
  const directory = join(temporary, name);
  names.push(name);
  mkdirSync(directory);

  writeFileSync(join(directory, "project"), "app\n");
  writeFileSync(join(directory, "prompt.md"), "test\n");
  writeFileSync(join(directory, "expectations.md"), "test\n");
  return directory;
}

function output(directory: string): string {
  return readlinkSync(join("/tmp/evals", basename(directory), "latest"));
}

function resultLines(directory: string): string[] {
  return readFileSync(join(output(directory), "stub-result.txt"), "utf8").split("\n");
}

async function run(directory: string, args: readonly string[] = [], additions: NodeJS.ProcessEnv = {}) {
  const result = await runCommand([bin, "--root", join(root, "skills"), "eval", directory, ...args], { cwd: temporary, env: { ...env, ...additions } });
  expect(result.timedOut).toBe(false);
  return result;
}

function ghCase(label: string): string {
  const directory = makeCase(label);
  mkdirSync(join(directory, "gh"));
  writeFileSync(join(directory, "gh/--version"), "gh stub\n");
  return directory;
}

function hideCase(label: string): string {
  const directory = makeCase(label);
  writeFileSync(join(directory, "hide"), "eval-hidden-command\n");
  return directory;
}

test("test-run.sh: plain is clean, pins hands-off, keeps startup and links playbook only", async () => {
  const directory = makeCase("plain");
  const result = await run(directory);
  const lines = resultLines(directory);
  const out = output(directory);

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(lines).toContain("dirty=0");
  expect(lines).toContain("hands-off");
  expect(lines).toContain("startup=1");

  expect(lines).toContain("playbook");
  expect(lines).not.toContain("fixture-optional");
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) expect(lines).toContain(`${name}=`);
  for (const artifact of artifacts) expect(statSync(join(out, artifact)).isFile()).toBe(true);

  expect(result.stdout).toBe(`transcript: ${out}/transcript.jsonl\nstatus:     ${out}/status.txt\ndiff:       ${out}/diff.patch\nremote:     ${out}/remote.txt\n\nexpectations:\ntest\n`);
});

test("test-run.sh: with pins hands-off and links fixture-optional", async () => {
  const directory = makeCase("with");
  writeFileSync(join(directory, "with"), " \tfixture-optional\n\n");

  expect((await run(directory)).code).toBe(0);
  expect(resultLines(directory)).toContain("hands-off");
  expect(resultLines(directory)).toContain("fixture-optional");
});

test("test-run.sh: bad extension exits 2", async () => {
  const directory = makeCase("bad");
  writeFileSync(join(directory, "with"), "nonexistent-thing\n");

  const result = await run(directory);
  expect(result.code).toBe(2);
  expect(result.stderr).toBe("invalid extension: nonexistent-thing\n");
  expect(existsSync(join("/tmp/evals", basename(directory)))).toBe(false);
});

test("test-run.sh: prs is clean, pins prs, seeds origin/main and resolves gh to the stub", async () => {
  const directory = ghCase("prs");
  writeFileSync(join(directory, "delivery"), "prs\n");

  const result = await run(directory);
  const lines = resultLines(directory);
  const out = output(directory);

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  for (const line of ["prs", "dirty=0", "origin=same", `${out}/remote.git`, `${out}/bin/gh`]) expect(lines).toContain(line);

  expect(readFileSync(join(out, "gh.log"), "utf8")).toBe("--version\n");
  expect(result.stdout).toContain(`gh:         ${out}/gh.log\n`);
  expect(readFileSync(join(out, "bin/gh"), "utf8")).toContain(`${shellQuote(process.execPath)} --no-env-file ${shellQuote(join(import.meta.dir, "gh.ts"))}`);
});

test("test-run.sh: bad delivery exits 2 with its diagnostic and no directory", async () => {
  const directory = makeCase("bad-delivery");
  writeFileSync(join(directory, "delivery"), "yolo\n");

  const result = await run(directory);
  expect(result.code).toBe(2);
  expect(result.stderr).toBe("invalid delivery: yolo\n");
  expect(existsSync(join("/tmp/evals", basename(directory)))).toBe(false);
});

test("two processes with one pinned stamp claim the stamp and stamp-2", async () => {
  const directory = makeCase("concurrent");
  const ctx: Context = { root: join(root, "skills"), repo: root, bin, verbs: [], suites: [], ports: [] };
  const script = join(temporary, "pinned-eval.ts");
  writeFileSync(script, `import { runEval } from ${JSON.stringify(join(import.meta.dir, "run.ts"))};\nprocess.exit(await runEval([process.argv[2]!], ${JSON.stringify(ctx)}, () => new Date("2026-01-02T03:04:05Z")));\n`);

  const results = await Promise.all([1, 2].map(() => runCommand([process.execPath, script, directory], { cwd: temporary, env })));
  expect(results.map((result) => result.code)).toEqual([0, 0]);

  const parent = join("/tmp/evals", basename(directory));
  const runs = readdirSync(parent).filter((name) => name !== "latest").sort();
  expect(runs).toEqual(["20260102T030405Z", "20260102T030405Z-2"]);
  expect(runs.map((name) => join(parent, name))).toContain(output(directory));

  for (const name of runs)
    for (const artifact of artifacts) expect(existsSync(join(parent, name, artifact))).toBe(true);
}, 30_000);

test("empty transcript exits 1 with eval failed: transcript is empty", async () => {
  const result = await run(makeCase("empty"), [], { EVAL_TRANSCRIPT: "empty" });

  expect(result.code).toBe(1);
  expect(result.stderr).toStartWith("eval failed: transcript is empty (");
  expect(result.stdout).toBe("");
});

test("hide reach exits 1 with eval failed: hidden command was reachable", async () => {
  const result = await run(hideCase("leaked"), [], { EVAL_TRANSCRIPT: "leaked" });

  expect(result.code).toBe(1);
  expect(result.stderr).toStartWith("eval failed: hidden command was reachable (");
  expect(result.stdout).toStartWith("LEAKED eval-hidden-command\n");
});

test("hide without evidence exits 1 with eval failed: no evidence the hidden command was unreachable", async () => {
  const result = await run(hideCase("unchecked"));

  expect(result.code).toBe(1);
  expect(result.stderr).toStartWith("eval failed: no evidence the hidden command was unreachable (");
  expect(result.stdout).toStartWith("UNCHECKED eval-hidden-command\n");
});

test("hide missing command passes and keeps its canary outside the pinned PATH", async () => {
  const directory = hideCase("hidden");
  const result = await run(directory, [], { EVAL_TRANSCRIPT: "hidden" });
  const out = output(directory);

  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith("HIDDEN eval-hidden-command\n");
  expect(readFileSync(join(out, "canary.txt"), "utf8")).toContain("/bin/eval-hidden-command\n");
  expect(existsSync(join(out, "bin/eval-hidden-command"))).toBe(false);
});

test("hide check throw exits 1 before artifact lines print", async () => {
  const result = await run(hideCase("hide-reader-note"), [], { EVAL_TRANSCRIPT: "invalid" });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("transcript.jsonl is unavailable\n");
  expect(result.stdout).toBe("");
});

test("gh without calls exits 1 with eval failed: the stub gh was never called", async () => {
  const result = await run(ghCase("uncalled"), [], { EVAL_GH: "skip" });
  expect(result.code).toBe(1);
  expect(result.stderr).toStartWith("eval failed: the stub gh was never called (");
});

for (const [mode, diagnostic] of [["fail", "exit status 7"], ["empty", "grade.md is empty"], ["long", "Prompt is too long"]])
  test(`--grade ${mode} exits 1 with grading failed: ${diagnostic}`, async () => {
    const result = await run(makeCase(`grade-${mode}`), ["--grade"], { EVAL_GRADE: mode });

    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith(`grading failed: ${diagnostic} (`);
    expect(result.stdout).toEndWith("expectations:\ntest\n");
  });

test("passing --grade prints grade.md after expectations and retains grader tokens", async () => {
  const directory = makeCase("grade-pass");
  mkdirSync(join(directory, "plans/Widgets"), { recursive: true });
  writeFileSync(join(directory, "plans/log.tsv"), "log\n");
  writeFileSync(join(directory, "plans/Widgets/index.tsv"), "index\n");

  const result = await run(directory, ["--grade"]);
  const out = output(directory);

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toEndWith("expectations:\ntest\n\nPASS test\n1 pass\n");
  expect(readFileSync(join(out, "grade.md"), "utf8")).toBe("PASS test\n1 pass\n");

  expect(readFileSync(join(out, "grader-env.txt"), "utf8")).toBe(`plans=${out}/work/plans\ntoken=leak\nshell=/bin/bash\n`);
  expect(readFileSync(join(out, "plans-after/Widgets/index.tsv"), "utf8")).toBe("index\n");
  expect(readFileSync(join(out, "grader-input.txt"), "utf8")).toContain(`\n## plans index and log after\n${out}/plans-after/log.tsv\nlog\n${out}/plans-after/Widgets/index.tsv\nindex\n\n## transcript digest\nFull transcript: `);
});

test("agent argv strips prompt newlines and splits flags without glob expansion", async () => {
  const directory = makeCase("argv");
  writeFileSync(join(directory, "prompt.md"), "test\n\n");
  writeFileSync(join(directory, "flags"), "--model\tsonnet\n*  --extra\n");
  writeFileSync(join(directory, "allow"), "\n  Bash(extra:*) \n");

  const result = await run(directory);
  const out = output(directory);
  const argv = readFileSync(join(out, "argv.txt"), "utf8").split("\n").slice(0, -1);
  expect(result.code).toBe(0);
  expect(argv.slice(0, 4)).toEqual(["-p", "test", "--permission-mode", "acceptEdits"]);

  expect(argv.slice(-4)).toEqual(["--model", "sonnet", "*", "--extra"]);
  expect(argv[argv.indexOf("--allowedTools") + 1]).toEndWith(",Bash(extra:*)");
});

test("an agent that exits nonzero fails the eval and keeps every artifact", async () => {
  const directory = makeCase("agent-exit");
  const result = await run(directory, [], { EVAL_AGENT_EXIT: "9" });
  const out = output(directory);

  expect(result.code).toBe(1);
  expect(result.stderr).toBe(`eval failed: the agent exited with status 9 (${out}); stderr: ${out}/stderr.log\n`);
  expect(readFileSync(join(out, "transcript.jsonl"), "utf8")).toContain('"type":"result"');

  for (const artifact of [...artifacts, "stderr.log"]) expect(existsSync(join(out, artifact))).toBe(true);
});

for (const args of [["ignored", "--grade"], ["--grade", "ignored"], ["--bogus"]])
  test(`eval <case> ${args.join(" ")} exits 2 with usage and no run directory`, async () => {
    const directory = makeCase("strict-args");
    const result = await run(directory, args);

    expect(result.code).toBe(2);
    expect(result.stderr).toBe("usage: skills eval <case> [--grade]\n");
    expect(existsSync(join("/tmp/evals", basename(directory)))).toBe(false);
  });

test("missing case exits 2 with usage on stderr", async () => {
  const result = await runCommand([bin, "--root", join(root, "skills"), "eval"], { cwd: temporary, env });

  expect(result.code).toBe(2);
  expect(result.stderr).toBe("usage: skills eval <case> [--grade]\n");
  expect(result.stdout).toBe("");
});

test("case names resolve below ctx.repo while path arguments remain supported", async () => {
  const directory = makeCase("name");
  mkdirSync(join(root, "evals/cases"), { recursive: true });
  symlinkSync(directory, join(root, "evals/cases", basename(directory)));

  const result = await run(basename(directory));
  expect(result.code).toBe(0);
});

test("an unknown case name exits 2 with no such case", async () => {
  const result = await run("run-test-no-such-case");

  expect(result.code).toBe(2);
  expect(result.stderr).toBe("no such case: run-test-no-such-case\n");
  expect(existsSync("/tmp/evals/run-test-no-such-case")).toBe(false);
});

test("a PATH without claude exits 2 before any run directory exists", async () => {
  const directory = makeCase("no-claude");
  const cli = join(source, "src/cli.ts");
  const result = await runCommand([process.execPath, cli, "--root", join(root, "skills"), "eval", directory], { cwd: temporary, env: { ...env, PATH: "/usr/bin:/bin" } });

  expect(result.code).toBe(2);
  expect(result.stderr).toBe("claude CLI not on PATH\n");
  expect(existsSync(join("/tmp/evals", basename(directory)))).toBe(false);
});

test("a project that is not one path segment exits 2 before any run directory exists", async () => {
  const directory = makeCase("project");
  writeFileSync(join(directory, "project"), "../escape\n");

  const result = await run(directory);
  expect(result.code).toBe(2);
  expect(result.stderr).toBe("invalid project: ../escape\n");
  expect(existsSync(join("/tmp/evals", basename(directory)))).toBe(false);
});

test("a relative PATH entry links its commands by absolute path", async () => {
  const directory = hideCase("relative-path");
  mkdirSync(join(temporary, "relative-bin"));
  writeFileSync(join(temporary, "relative-bin/eval-relative-command"), "#!/bin/sh\n", { mode: 0o755 });

  const result = await run(directory, [], { PATH: `relative-bin:${env.PATH}`, EVAL_TRANSCRIPT: "hidden" });
  expect(result.code).toBe(0);
  expect(readlinkSync(join(output(directory), "bin/eval-relative-command"))).toBe(join(realpathSync(temporary), "relative-bin/eval-relative-command"));
});

test("a bare dot case name is not a case", async () => {
  mkdirSync(join(root, "evals/cases"), { recursive: true });

  for (const name of [".", ".."]) {
    const result = await run(name);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(`no such case: ${name}\n`);
  }
});
