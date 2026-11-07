import { extractedText, type TranscriptEvent } from "../sessions/claude.ts";
import { note, object, parseTimestamp, type Notes, type RecordObject } from "../sessions/jsonl.ts";
import { round } from "./numbers.ts";
import { codexArm, toolName } from "./transcript.ts";

const plansStart = /(?:^|[\s;&|(])(?:\S*\/)?(?:skills|\$\{?\w+\}?)\s+plans\s+start\s/u;

type Command = (args: readonly string[]) => Promise<string | undefined>;
type Implementer = { kind: "lead" | "unknown" } | { kind: "model"; model: string };

type MergedPr = { number: number; title: string; mergedAt: number; oid: string };
type PrCommit = { headline: string; authoredDate: string };
type Provenance = { pr: MergedPr; introduced: Set<string>; blamed: Set<string> };
type OldRange = { path: string; start: number; count: number };

type Publish = { timestamp: number; implementer: Implementer };
type Pending = { arm: Implementer | null; reset: boolean; publish?: Publish };
export type FollowUpRow = {
  implementer: string;
  merged: number;
  followed_up: number;
  share: number;
};

type Input = {
  gh: Command;
  git: Command;
  cutoff: number;
  transcripts: readonly (readonly TranscriptEvent[])[];
  notes: Notes;
};

function implementationArm(block: RecordObject): Implementer | null {
  if (!object(block.input)) return null;

  const input = block.input;
  const name = toolName(block);
  if (
    name === "delegate_task" &&
    [input.title, input.clientRequestId].some(
      (value) => typeof value === "string" && value.endsWith("-impl"),
    )
  )
    return object(input.target) && typeof input.target.model === "string"
      ? { kind: "model", model: input.target.model }
      : { kind: "unknown" };

  if (name !== "Bash" || typeof input.command !== "string") return null;

  const command = input.command;
  const arm = codexArm.exec(command);
  if (arm === null || !arm[0].endsWith("exec") || !command.includes("workspace-write")) return null;

  const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/u, "$2");
  const tokens = (command.match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? []).map(unquote);

  let model: string | undefined;
  for (const [index, token] of tokens.entries()) {
    const value = tokens[index + 1];
    if ((token === "-m" || token === "--model") && value !== undefined) model = unquote(value);
    if (token === "-c" && value?.startsWith("model=")) model = unquote(value.slice(6));
  }

  return model === undefined ? { kind: "unknown" } : { kind: "model", model };
}

function publishingImplementers(transcripts: Input["transcripts"]): Map<number, Implementer> {
  const published = new Map<number, Publish>();
  for (const events of transcripts) {
    const pending = new Map<string, Pending>();

    let implementer: Implementer = { kind: "lead" };
    for (const event of [...events].sort((left, right) => left.timestamp - right.timestamp))
      for (const block of event.blocks) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          const command =
            toolName(block) === "Bash" && object(block.input) ? block.input.command : undefined;

          pending.set(block.id, {
            arm: implementationArm(block),
            reset: typeof command === "string" && plansStart.test(command),
            ...(typeof command === "string" && command.includes("skills publish")
              ? { publish: { timestamp: event.timestamp, implementer } }
              : {}),
          });
        }

        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;

        const action = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        if (action === undefined || block.is_error === true) continue;

        const text = extractedText(block.content);
        if (action.reset && /\tDOING\t/u.test(text)) implementer = { kind: "lead" };
        if (action.arm !== null) implementer = action.arm;
        if (action.publish === undefined) continue;

        for (const match of text.matchAll(/\/pull\/(\d+)\b/gu)) {
          const number = Number(match[1]);
          if ((published.get(number)?.timestamp ?? -Infinity) <= action.publish.timestamp)
            published.set(number, action.publish);
        }
      }
  }

  return new Map([...published].map(([number, publish]) => [number, publish.implementer]));
}

export function decodeGitPath(path: string): string {
  if (!path.startsWith('"')) return path;

  const escapes: Readonly<Record<string, string>> = {
    a: "\x07",
    b: "\b",
    t: "\t",
    n: "\n",
    v: "\v",
    f: "\f",
    r: "\r",
    '"': '"',
    "\\": "\\",
  };

  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const match of path.slice(1).matchAll(/\\([0-7]{1,3}|.)|([^"\\]+)|"/gsu)) {
    if (match[0] === '"') break;

    const escaped = match[1];
    if (escaped !== undefined && /^[0-7]/u.test(escaped)) bytes.push(parseInt(escaped, 8));
    else
      bytes.push(
        ...encoder.encode(escaped === undefined ? match[2] : (escapes[escaped] ?? escaped)),
      );
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

function oldRanges(patch: string): OldRange[] {
  const ranges: OldRange[] = [];

  let path: string | undefined;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      path = undefined;
      inHunk = false;
    } else if (!inHunk && line.startsWith("--- ")) {
      const raw = line.slice(4).replace(/\t$/u, "");
      const decoded = decodeGitPath(raw);
      path = decoded.startsWith("a/") ? decoded.slice(2) : undefined;
    }

    const hunk = /^@@ -(\d+)(?:,(\d+))? \+/u.exec(line);
    if (hunk === null) continue;

    inHunk = true;
    const count = Number(hunk[2] ?? 1);
    if (path !== undefined && count > 0) ranges.push({ path, start: Number(hunk[1]), count });
  }

  return ranges;
}

function blamedCommits(output: string): Set<string> {
  const commits = new Set<string>();

  let oid: string | undefined;
  for (const line of output.split("\n")) {
    const header = /^([a-f0-9]{40,64}) \d+ \d+(?: \d+)?$/u.exec(line);
    if (header !== null) oid = header[1];
    if (line.startsWith("\t") && line.slice(1).trim() && oid !== undefined) commits.add(oid);
  }

  return commits;
}

async function readMergedPrs(gh: Command, cutoff: number, notes: Notes): Promise<MergedPr[]> {
  const output = await gh([
    "pr",
    "list",
    "--state",
    "merged",
    "--search",
    `merged:>=${new Date(cutoff / 1000).toISOString().slice(0, 10)}`,
    "--limit",
    "1000",
    "--json",
    "number,title,mergedAt,mergeCommit",
  ]);

  let records: unknown;
  try {
    records = output === undefined ? null : JSON.parse(output);
  } catch {
    records = null;
  }

  if (!Array.isArray(records)) {
    note(notes, "gh pr list failed");
    return [];
  }

  if (records.length === 1000)
    note(notes, "gh pr list returned its 1000 limit, older PRs are missing");

  const prs: MergedPr[] = [];
  for (const record of records) {
    if (!object(record) || typeof record.number !== "number" || typeof record.title !== "string")
      continue;

    const mergedAt = parseTimestamp(record.mergedAt);
    if (mergedAt !== null && mergedAt >= cutoff)
      prs.push({
        number: record.number,
        title: record.title,
        mergedAt,
        oid:
          object(record.mergeCommit) && typeof record.mergeCommit.oid === "string"
            ? record.mergeCommit.oid
            : "unknown",
      });
  }

  return prs;
}

async function commitDetails(pr: MergedPr, gh: Command, notes: Notes): Promise<PrCommit[]> {
  try {
    const output = await gh([
      "pr",
      "view",
      String(pr.number),
      "--json",
      "commits",
      "--jq",
      "[.commits[] | {headline: .messageHeadline, authoredDate: .authoredDate}]",
    ]);

    const commits: unknown = output === undefined ? null : JSON.parse(output);
    if (
      Array.isArray(commits) &&
      commits.every(
        (commit): commit is PrCommit =>
          object(commit) &&
          typeof commit.headline === "string" &&
          typeof commit.authoredDate === "string" &&
          Number.isFinite(Date.parse(commit.authoredDate)),
      )
    )
      return commits;
  } catch {}

  note(notes, `gh pr view ${pr.number} failed`);
  return [];
}

async function provenance(
  pr: MergedPr,
  git: Command,
  gh: Command,
  notes: Notes,
): Promise<Provenance> {
  const empty = { pr, introduced: new Set<string>(), blamed: new Set<string>() };

  let operation = "cat-file";
  try {
    if ((await git(["cat-file", "-e", `${pr.oid}^{commit}`])) === undefined) {
      note(
        notes,
        `merge commit of #${pr.number} (${pr.oid}) is not in the local clone, run git fetch`,
      );

      return empty;
    }

    operation = "rev-list";
    const parents = await git(["rev-list", "--parents", "-n", "1", pr.oid]);
    if (parents === undefined) throw new Error(operation);

    let base = `${pr.oid}^1`;
    let introduced = pr.oid;
    const parentCount = parents.trim().split(/\s+/u).length - 1;
    if (parentCount === 1) {
      const commits = await commitDetails(pr, gh, notes);
      if (commits.length > 1) {
        operation = "log";
        const history = await git([
          "log",
          "--first-parent",
          "--format=%aI%x09%s",
          "-n",
          String(commits.length),
          pr.oid,
        ]);

        if (history === undefined) throw new Error(operation);

        const oldestFirst = history.trimEnd().split("\n").reverse();
        if (
          oldestFirst.length === commits.length &&
          oldestFirst.every((line, index) => {
            const entry = /^([^\t]+)\t(.*)$/u.exec(line);
            const commit = commits[index]!;
            return (
              entry !== null &&
              entry[2] === commit.headline &&
              Date.parse(entry[1]!) === Date.parse(commit.authoredDate)
            );
          })
        )
          base = `${pr.oid}~${commits.length}`;
      }
    }

    if (parentCount >= 2 || base !== `${pr.oid}^1`) {
      operation = "rev-list";
      const commits = await git(["rev-list", `${base}..${pr.oid}`]);
      if (commits === undefined) throw new Error(operation);

      introduced = commits;
    }

    const blamed = new Set<string>();
    if (/^(fix|revert)(\([^)]*\))?!?:/u.test(pr.title)) {
      operation = "diff";
      const patch = await git([
        "-c",
        "core.quotepath=off",
        "diff",
        "--unified=0",
        "--no-color",
        "--no-renames",
        base,
        pr.oid,
      ]);

      if (patch === undefined) throw new Error(operation);

      for (const range of oldRanges(patch)) {
        operation = "blame";
        const output = await git([
          "blame",
          "--porcelain",
          "-L",
          `${range.start},+${range.count}`,
          base,
          "--",
          range.path,
        ]);

        if (output === undefined) throw new Error(operation);

        for (const oid of blamedCommits(output)) blamed.add(oid);
      }
    }

    return { pr, introduced: new Set(introduced.split("\n").filter(Boolean)), blamed };
  } catch {
    note(notes, `git ${operation} failed for #${pr.number} merge commit ${pr.oid}`);
    return empty;
  }
}

export async function followUps(input: Input): Promise<{ rows: FollowUpRow[]; notes: Notes }> {
  const prs = await readMergedPrs(input.gh, input.cutoff, input.notes);
  const sources: Provenance[] = [];

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, prs.length) }, async () => {
      while (next < prs.length) {
        const index = next++;
        sources[index] = await provenance(prs[index]!, input.git, input.gh, input.notes);
      }
    }),
  );

  const implementers = publishingImplementers(input.transcripts);
  const groups = new Map<string, FollowUpRow>();
  for (const source of sources) {
    const author = implementers.get(source.pr.number) ?? { kind: "unknown" };
    const implementer = author.kind === "model" ? author.model : author.kind;
    const row = groups.get(implementer) ?? { implementer, merged: 0, followed_up: 0, share: 0 };
    if (
      sources.some(
        (fix) =>
          fix.pr.mergedAt > source.pr.mergedAt &&
          fix.pr.mergedAt - source.pr.mergedAt <= 14 * 86400e6 &&
          [...source.introduced].some((oid) => fix.blamed.has(oid)),
      )
    )
      row.followed_up++;

    row.merged++;
    row.share = round(row.followed_up / row.merged);
    groups.set(implementer, row);
  }

  const rank = (implementer: string) =>
    implementer === "lead" ? 0 : implementer === "unknown" ? 2 : 1;

  const rows = [...groups.values()].sort(
    (left, right) =>
      rank(left.implementer) - rank(right.implementer) ||
      (left.implementer < right.implementer ? -1 : left.implementer > right.implementer ? 1 : 0),
  );

  return { rows, notes: input.notes };
}
