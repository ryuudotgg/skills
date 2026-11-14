import { afterEach, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { appendFileSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_EVENT } from "skills-core";
import { appendEvent, write } from "../plans/store.ts";
import type { Io } from "../io.ts";
import {
  blobText,
  sessionsMachine,
  setPolicy,
  transcripts,
  type SessionsMachine,
} from "../test/sessions-fixture.ts";
import { chunkTranscripts } from "./chunks.ts";
import { digestText, foldDigest, freshDigest } from "./digest.ts";
import { sessionLines } from "./ledger.ts";
import { localLinks } from "./policy.ts";
import { BLOB_MISSING, missingDigests, planDigests } from "./show.ts";
import { sessionDigest } from "./show.ts";
import { lines, parsed } from "./transcripts.ts";
import { showVerb } from "./verbs.ts";

const usage = "skills sessions show <session> [--digest]";
const machines: SessionsMachine[] = [];

afterEach(() => {
  for (const m of machines.splice(0)) m.close();
});

async function machine(): Promise<SessionsMachine> {
  const m = await sessionsMachine();
  machines.push(m);
  return m;
}

async function show(m: SessionsMachine, args: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: m.root,
    env: { ...m.env, PLANS_DIR: m.plans },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    capture: true,
  };

  const code = await showVerb(args, usage, io);
  return { code, out: out.join(""), err: err.join("") };
}

function digestOf(m: SessionsMachine): string {
  const found = sessionDigest(m.store.db, m.plans, m.env, "claude-fixture");
  if (found.kind !== "shown") throw new Error(`digest ${found.kind}`);
  return found.text;
}

function fullFold(path: string, secrets: readonly string[] = []): string {
  const digest = freshDigest("claude");
  for (const [raw] of lines(path, 0, statSync(path).size)) {
    const record = parsed(raw);
    if (record !== null) foldDigest(digest, record, secrets);
  }

  return digestText(digest, secrets);
}

function prompt(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

function overwrite(path: string, from: string, to: string): void {
  expect(to.length).toBe(from.length);

  const text = readFileSync(path, "utf8");
  expect(text).toContain(from);
  writeFileSync(path, text.replace(from, to));
}

test("a session whose local transcript is gone still prints its fields", async () => {
  const m = await machine();
  rmSync(m.claude);

  const shown = await show(m, ["claude-fixture", "--digest"]);
  const lines = shown.out.split("\n");
  expect(shown.code).toBe(0);

  expect(lines[0]).toStartWith("claude\tclaude-fixture\tAlpha\t001\tfeat/one\t");
  expect(lines.slice(1, 4)).toEqual(["host claude", "project Alpha", "plans 001"]);
  expect(lines).toContain("tool Bash 8");
  expect(shown.out).toEndWith("\ndigest: transcript missing\n");
  expect(shown.out).not.toContain("Prompt:");
});

test("a digest follows the field lines and the usage is refused on stray arguments", async () => {
  const m = await machine();

  const shown = await show(m, ["claude-fixture", "--digest"]);
  const lines = shown.out.split("\n");

  expect(shown.code).toBe(0);
  expect(lines.indexOf("end 2026-11-07T10:03:16Z")).toBeLessThan(
    lines.findIndex((line) => line.startsWith("Prompt: ")),
  );

  expect(shown.out).toMatch(/\nReply: Summary of the long run\. .* \[dropped \d+ characters\]\n/);
  expect((await show(m, ["claude-fixture", "extra"])).code).toBe(2);
  expect((await show(m, ["--digest", "--digest", "claude-fixture"])).code).toBe(2);
});

test("plans adopt prints the newest digest blob of each session linked to the plan", async () => {
  const m = await machine();
  chunkTranscripts(m.store, m.plans, m.env, { deadline: Date.now() + 60_000, bytes: Infinity });

  const newest = transcripts(m.store).at(-1)!;
  const lines = sessionLines(m.store, localLinks(m.plans));
  const printed = planDigests(m.store, lines, "Alpha", "001");

  expect(printed).toBe(`Session claude claude-fixture\n${blobText(m.store, newest.digest)}`);
  expect(printed).toContain("\nReply: Summary of the long run. ");
  expect(planDigests(m.store, lines, "Alpha", "002")).toBe("");
});

test("a session the scan has not read yet still finds its transcript", async () => {
  const m = await machine();
  rmSync(join(m.plans, "sessions-scan.db"));

  const shown = await show(m, ["claude-fixture", "--digest"]);
  expect(shown.code).toBe(0);
  expect(shown.out).toContain("\nPrompt: ");
  expect(shown.out).not.toContain("digest: transcript missing");
});

test("a secret in a branch name is redacted on the list line and the branch line", async () => {
  const m = await machine();
  const token = "ghp_" + "Ab3dE5gH7jK9mN1pQ3sT5vX7zB9dF1hJ3lN5";
  write(m.store, () =>
    appendEvent(m.store, {
      kind: "stored",
      type: SESSION_EVENT,
      at: Date.now(),
      project: "Alpha",
      plan: "001",
      payload: {
        host: "claude",
        session: "claude-fixture",
        branch: `feat/${token}`,
        plans: ["001"],
        source: "resume",
        started: "2026-11-07T10:05:00Z",
      },
    }),
  );

  const shown = await show(m, ["claude-fixture"]);
  expect(shown.out).not.toContain(token);
  expect(shown.out.split("\n")[0]).toContain("feat/[redacted:github-pat]");
  expect(shown.out).toContain("\nbranch feat/[redacted:github-pat]\n");
});

test("adopt names a session whose newest digest blob is missing instead of an older one", async () => {
  const m = await machine();
  chunkTranscripts(m.store, m.plans, m.env, { deadline: Date.now() + 60_000, bytes: Infinity });

  const newest = transcripts(m.store).at(-1)!;
  m.store.db.run("DELETE FROM blobs WHERE sha256 = ?", [newest.digest]);

  const printed = planDigests(m.store, sessionLines(m.store, localLinks(m.plans)), "Alpha", "001");
  expect(printed).toBe(`Session claude claude-fixture\n${BLOB_MISSING}\n`);
});

test("sync wants the newest digest even for a session this machine also recorded", async () => {
  const m = await machine();
  chunkTranscripts(m.store, m.plans, m.env, { deadline: Date.now() + 60_000, bytes: Infinity });

  const newest = transcripts(m.store).at(-1)!;
  expect(missingDigests(m.store, m.plans)).toEqual([]);

  m.store.db.run("DELETE FROM blobs WHERE sha256 = ?", [newest.digest]);
  expect(missingDigests(m.store, m.plans).map((fetch) => fetch.sha256)).toEqual([newest.digest]);
});

test("a digest recorded under full is still wanted once the project drops to redacted", async () => {
  const m = await machine();
  setPolicy(m, "full");
  chunkTranscripts(m.store, m.plans, m.env, { deadline: Date.now() + 60_000, bytes: Infinity });

  const newest = transcripts(m.store).at(-1)!;
  expect(newest.policy).toBe("full");

  m.store.db.run("DELETE FROM blobs WHERE sha256 = ?", [newest.digest]);
  setPolicy(m, "redacted");
  expect(missingDigests(m.store, m.plans).map((fetch) => fetch.sha256)).toEqual([newest.digest]);

  setPolicy(m, "stats");
  expect(missingDigests(m.store, m.plans)).toEqual([]);
});

test("adopt names a linked session whose transcript has not synced at all", async () => {
  const m = await machine();
  const printed = planDigests(m.store, sessionLines(m.store, localLinks(m.plans)), "Alpha", "001");
  expect(printed).toBe(`Session claude claude-fixture\n${BLOB_MISSING}\n`);
});

test("a transcript that moved since the scan is found where it is now", async () => {
  const m = await machine();
  const moved = join(m.root, "home/.claude/projects/-elsewhere");
  mkdirSync(moved, { recursive: true });
  renameSync(m.claude, join(moved, "claude-fixture.jsonl"));

  const shown = await show(m, ["claude-fixture", "--digest"]);
  expect(shown.code).toBe(0);
  expect(shown.out).toContain("\nPrompt: ");
});

test("an injected task notification is not printed as a prompt", async () => {
  const m = await machine();

  const shown = await show(m, ["claude-fixture", "--digest"]);
  const lines = shown.out.split("\n");

  expect(shown.code).toBe(0);
  expect(lines.filter((line) => line.startsWith("Prompt: "))).toHaveLength(1);
  expect(lines.filter((line) => line.includes("task-notification"))).toEqual([]);
});

test("digest resumes from the bytes it already read", async () => {
  const m = await machine();
  appendFileSync(m.claude, prompt("Later prompt reads alpha"));
  expect(digestOf(m)).toContain("\nPrompt: Later prompt reads alpha\n");

  overwrite(m.claude, "reads alpha", "reads omega");
  appendFileSync(m.claude, prompt("Appended prompt one"));

  const second = digestOf(m);
  expect(second).toContain("\nPrompt: Appended prompt one\n");
  expect(second).toContain("\nPrompt: Later prompt reads alpha\n");
  expect(second).not.toContain("reads omega");

  overwrite(m.claude, "reads omega", "reads alpha");
  appendFileSync(m.claude, prompt("Appended prompt two"));
  expect(digestOf(m)).toBe(fullFold(m.claude));
});

test("digest rereads a replaced transcript or changed secrets", async () => {
  const replaced = await machine();
  digestOf(replaced);

  overwrite(replaced.claude, "deploy fails?", "deploy works?");
  overwrite(replaced.claude, '"summary":"Fixture session"', '"summary":"Another session"');

  const reread = digestOf(replaced);
  expect(reread).toContain("deploy works?");
  expect(reread).toBe(fullFold(replaced.claude));

  const truncated = await machine();
  digestOf(truncated);
  const kept = readFileSync(truncated.claude, "utf8").split("\n").slice(0, 3).join("\n");
  truncateSync(truncated.claude, Buffer.byteLength(`${kept}\n`));
  expect(digestOf(truncated)).toBe(fullFold(truncated.claude));

  const secret = "Zq7-local-9x2";
  const env = await machine();
  const checkout = join(env.root, "checkout");
  mkdirSync(checkout);
  const moved = readFileSync(env.claude, "utf8").replaceAll(
    "/tmp/sessions-fixture/checkout/Alpha",
    checkout,
  );

  writeFileSync(env.claude, `${moved}${prompt(`Deploy with key ${secret}`)}`);
  rmSync(join(env.plans, "sessions-scan.db"));
  expect(digestOf(env)).toContain(`Deploy with key ${secret}`);

  writeFileSync(join(checkout, ".env"), `DEPLOY_KEY=${secret}\n`);
  const after = digestOf(env);
  expect(after).toContain("\nPrompt: Deploy with key [redacted:env]\n");
  expect(after).toBe(fullFold(env.claude, [secret]));
});

test("cached digest refused once the project drops to stats", async () => {
  const m = await machine();
  setPolicy(m, "redacted");
  expect(sessionDigest(m.store.db, m.plans, m.env, "claude-fixture").kind).toBe("shown");

  setPolicy(m, "stats");
  expect(sessionDigest(m.store.db, m.plans, m.env, "claude-fixture")).toEqual({
    kind: "refused",
    policy: "stats",
  });
});
