import {
  bookkeepingEvents,
  COLUMNS,
  flatten,
  foreignRefusal,
  formatRow,
  type IndexRow,
  type LeaseHeld,
} from "skills-core";
import { withLock } from "../lock.ts";
import { updateIndex } from "./commit.ts";
import { scratchLock, today } from "./index-tsv.ts";
import { recordHeld } from "./leases.ts";
import { logDetail } from "./trail.ts";

export async function markStarted(
  index: string,
  project: string,
  branch: string,
  expected: readonly IndexRow[],
  env: NodeJS.ProcessEnv = process.env,
  leases: ReadonlyMap<string, LeaseHeld> = new Map(),
): Promise<IndexRow[] | { refusal: string } | undefined> {
  return withLock(scratchLock(env), "scratch", () =>
    claim(index, project, branch, expected, leases),
  );
}

async function claim(
  index: string,
  project: string,
  branch: string,
  expected: readonly IndexRow[],
  leases: ReadonlyMap<string, LeaseHeld>,
): Promise<IndexRow[] | { refusal: string } | undefined> {
  return updateIndex(index, (rows, trail, _record, world, tx) => {
    const claimed: IndexRow[] = [];
    for (const wanted of expected) {
      const row = rows.find((entry) => entry.id === wanted.id);
      if (!row) return undefined;

      if (formatRow(row) !== formatRow(wanted)) {
        const changes = COLUMNS.filter((column) => flatten(row[column]) !== flatten(wanted[column]))
          .map((column) => `${column} ${wanted[column]} -> ${row[column]}`)
          .join(", ");

        return { refusal: expected.length > 1 ? `row ${row.id} ${changes}` : changes };
      }

      const foreign = foreignRefusal(row, rows, world());
      if (foreign) return { refusal: expected.length > 1 ? `row ${row.id} ${foreign}` : foreign };

      claimed.push(row);
    }

    for (const row of claimed) {
      row.status = "DOING";
      row.branch = branch;
      row.updated = today();

      const previous = trail.last(project, row.id, bookkeepingEvents);
      if (previous?.event !== "start" || previous.detail !== logDetail(branch))
        trail.log(project, row.id, "start", branch);

      const held = leases.get(row.id);
      if (held !== undefined) recordHeld(tx.store, tx.at, project, row.id, held);
    }

    return claimed;
  });
}
