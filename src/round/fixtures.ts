import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readDeclarations } from "../reviewers/declaration.ts";
import { dependencies } from "./round.ts";
import { limits } from "./presence.ts";
import legacy from "./legacy-fixtures.json";
import type { Dependencies, PullRequest, ReadResult, ReviewerInput, Snapshot } from "./types.ts";

export const repo = resolve(import.meta.dir, "../..");
export const bin = join(repo, "skills/playbook/bin/skills");
export const now = "2026-09-28T12:00:00Z";
export const success = (stdout = ""): ReadResult => ({ code: 0, stdout, stderr: "" });
export const failure = (stderr = ""): ReadResult => ({ code: 1, stdout: "", stderr });

function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  if (typeof record.repeat === "number")
    return Array.from({ length: record.repeat }, () => expand(record.node));

  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, expand(entry)]));
}

export const scoreCases = legacy.scores.map((entry, index) => ({
  ...entry,
  name: `score_case ${entry.name} ${index + 1}`,
  pr: expand({ ...legacy.scoreBase, ...entry.patch }) as PullRequest,
}));
export const acceptanceCases = legacy.acceptance.map((entry) => ({
  ...entry,
  pr: expand({ ...legacy.acceptanceBase, ...entry.patch }) as PullRequest,
}));
export const decisionCases = legacy.decisions as [string, string][];

const greptileDeclaration = readDeclarations(join(repo, "skills")).find(
  (entry) => entry.name === "greptile",
)!;

export function declarationText(name: string): string {
  if (name === "greptile")
    return "NAME=Greptile\nLOGINS=greptile-apps greptile-apps[bot]\nHANDLES=@greptile\nTRIGGER=@greptileai\nCHECK=Greptile Review\nOUTSIDE_DIFF=Comments Outside Diff\nSETTING_REREVIEWS=2 [0-9]\nSETTING_THRESHOLD=4 [1-5]\nSETTING_CRITICAL_THRESHOLD=5 [1-5]\n";

  return `NAME=${name === "testbot" ? "TestBot" : name === "thirdbot" ? "ThirdBot" : name}\nLOGINS=${name} ${name}[bot]\nHANDLES=@${name}\nTRIGGER=@${name} ${name === "thirdbot" ? "go" : "review"}\nCHECK=${name === "testbot" ? "TestBot" : name === "thirdbot" ? "ThirdBot" : name}\n${name === "thirdbot" ? "SETTING_BUDGET=1 [0-9]\n" : ""}`;
}

export function fixture(
  names: readonly string[] = ["greptile"],
  ported: readonly string[] = names,
) {
  const temporary = mkdtempSync(join(tmpdir(), "skills-round-"));
  const root = join(temporary, "skills");
  const conf = join(temporary, "skills.conf");

  for (const name of names) {
    const directory = join(root, name);
    mkdirSync(join(directory, "scripts"), { recursive: true });
    writeFileSync(join(directory, "reviewer.conf"), declarationText(name));
    writeFileSync(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Fixture reviewer.\noptional: true\nrequires: prs\n---\n`,
    );

    if (ported.includes(name))
      if (name === "greptile")
        symlinkSync(join(repo, "skills/greptile/reviewer.ts"), join(directory, "reviewer.ts"));
      else
        writeFileSync(
          join(directory, "reviewer.ts"),
          'export const facts = () => ({ fixesFrom: null });\nexport const decide = () => "done";\n',
        );
    else writeFileSync(join(directory, "scripts/verdict.sh"), "printf 'done\\n'\n");
  }

  const configure = (active: string) => writeFileSync(conf, `DELIVERY=prs\nWITH=${active}\n`);
  configure(names.join(" "));

  const deps: Dependencies = dependencies(root, temporary, { SKILLS_CONF: conf, REVIEW_NOW: now });
  const calls: { command: string; args: readonly string[]; deadline?: number }[] = [];
  const responses = new Map<string, ReadResult>();
  let clock = 10_000;
  deps.clock = () => clock;
  deps.sleep = async (seconds) => {
    clock += seconds;
  };

  deps.git = async (args, deadline) => {
    calls.push({ command: "git", args, deadline });
    return failure();
  };

  deps.gh = async (args, deadline) => {
    calls.push({ command: "gh", args, deadline });
    return success(
      JSON.stringify({
        data: {
          repository: { pullRequest: acceptanceCases.find((entry) => entry.name === "absent")!.pr },
        },
      }),
    );
  };

  deps.shell = async (args) => {
    calls.push({ command: "sh", args });
    return responses.get(args[1]!.split("/").at(-3)!) ?? success("done\n");
  };

  return {
    temporary,
    root,
    conf,
    deps,
    calls,
    responses,
    configure,
    advance: (seconds: number) => {
      clock += seconds;
    },
  };
}

export function reviewerInput(
  pr: PullRequest,
  changes: Partial<ReviewerInput> = {},
): ReviewerInput {
  const declaration = structuredClone(greptileDeclaration);
  return {
    phase: "gate",
    outcome: null,
    critical: false,
    snapshot: { pr, comments: pr.comments.nodes },
    presence: {
      check: "completed",
      seen: true,
      event: "push",
      elapsed: 90,
      age: 90,
      gate: "decide",
    },
    declaration,
    settings: { rereviews: "2", threshold: "4", "critical-threshold": "5" },
    limits,
    now: "2026-09-26T00:09:59Z",
    ...changes,
  };
}

export function response(snapshot: Snapshot | PullRequest): string {
  return JSON.stringify({
    data: { repository: { pullRequest: "pr" in snapshot ? snapshot.pr : snapshot } },
  });
}
