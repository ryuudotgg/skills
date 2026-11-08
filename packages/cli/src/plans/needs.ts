import { join } from "node:path";
import { lacking, meets, planNeeds, type IndexRow } from "skills-core";
import { recordWorkingCopies } from "./commit.ts";
import { plansDir } from "./index-tsv.ts";
import { newestFacts, otherMachineFacts } from "./machine.ts";
import { readStore } from "./projection.ts";
import { latestRevisionText } from "./store.ts";

export type Unmet = { lacking: string[]; runOn: string[]; noFacts: boolean };

export type NeedsEntry = { needs: string[]; met: boolean; unmet?: Unmet };

export type Needs = ReadonlyMap<string, NeedsEntry>;

function unmetText(unmet: Unmet, own: boolean): string {
  const missing = unmet.lacking.join(",");
  const tail =
    unmet.runOn.length > 0 ? `run on ${unmet.runOn.join(", ")}` : "no known machine has it";

  if (unmet.noFacts)
    return `needs ${missing}, this machine has no facts yet, run skills machine refresh; ${tail}`;

  return own ? `needs ${missing}, this machine lacks it; ${tail}` : `needs ${missing}, ${tail}`;
}

export function refusalLine(id: string, unmet: Unmet): string {
  return `${id} ${unmetText(unmet, true)}`;
}

export function heldLine(id: string, unmet: Unmet): string {
  return `held ${id}: ${unmetText(unmet, false)}`;
}

export function leftNeedsLine(id: string, unmet: Unmet): string {
  return `left ${id} ${unmetText(unmet, false)}`;
}

export async function readNeeds(
  project: string,
  rows: readonly IndexRow[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Needs | { refusal: string }> {
  const root = plansDir(env);
  const paths = rows.map((row) => join(project, `${row.id}-${row.slug}.md`));

  let copies: Map<string, Uint8Array>;
  try {
    copies = await recordWorkingCopies(
      root,
      paths.map((path) => join(root, path)),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { refusal: `cannot record the plan files: ${reason}` };
  }

  const read = await readStore(root, (store) => ({
    own: newestFacts(store),
    others: otherMachineFacts(store),
    texts: paths.map((path) => copies.get(join(root, path)) ?? latestRevisionText(store, path)),
  }));

  if (read.kind === "failed") return { refusal: read.reason };

  const { own, others, texts } =
    read.kind === "read" ? read.value : { own: undefined, others: [], texts: [] };

  const needs = new Map<string, NeedsEntry>();
  for (const [index, row] of rows.entries()) {
    const text = texts[index];
    const words = text && planNeeds(Buffer.from(text).toString("utf8"));
    if (!words) continue;

    const missing = lacking(words, own);
    if (missing.length === 0) {
      needs.set(row.id, { needs: words, met: true });
      continue;
    }

    const labels = others.filter((facts) => meets(words, facts, project)).map(({ label }) => label);
    const unmet = { lacking: missing, runOn: [...new Set(labels)].sort(), noFacts: !own };
    needs.set(row.id, { needs: words, met: false, unmet });
  }

  return needs;
}
