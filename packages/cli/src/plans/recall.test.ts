import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMNS, LOG_HEADER } from "skills-core";
import { recordPlanEdits } from "../hooks/plan-edits.ts";
import { appendLog, recordWorkingCopies, updateIndex } from "./commit.ts";
import { importStore } from "./import.ts";
import { closeIssue, fileIssue } from "./issues.ts";
import {
  markRecallBlob,
  markRecallEvents,
  rebuildRecall,
  recallStatus,
  sections,
} from "./recall.ts";
import {
  appendEvent,
  insertRevision,
  openStore,
  projectedRows,
  sha256,
  spoolRevision,
  storeBlob,
  storedIssues,
  write,
  type Store,
} from "./store.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const PLAN = `---
id: 007
slug: seven
note: |
  \`\`\`
## Metadata
---

# 007 seven

## Outcome

Revision history of plans, revision text kept.

\`\`\`
## Not a heading
\`\`\`

## Notes

First note.

## Notes

Second note.
`;

function plans(): { root: string; env: NodeJS.ProcessEnv; plan: string } {
  const root = mkdtempSync(join(tmpdir(), "skills-recall-"));
  temporary.push(root);

  mkdirSync(join(root, "Skills", "done"), { recursive: true });
  const rows = [
    ["007", "seven", "TODO", "P1", "S", "-", "-", "-", "2026-11-09", "-"],
    ["008", "eight", "TODO", "P1", "S", "-", "-", "-", "2026-11-09", "-"],
  ];

  writeFileSync(
    join(root, "Skills", "index.tsv"),
    `${COLUMNS.join("\t")}\n${rows.map((row) => row.join("\t")).join("\n")}\n`,
  );

  writeFileSync(join(root, "log.tsv"), LOG_HEADER);

  const plan = join(root, "Skills", "007-seven.md");
  writeFileSync(plan, PLAN);
  writeFileSync(
    join(root, "Skills", "008-eight.md"),
    "# 008 eight\n\n## Outcome\n\nMachine facts and labels.\n",
  );

  writeFileSync(
    join(root, "Skills", "ctx-batch.md"),
    "# ctx-batch\n\n## Invariant\n\nLabels stay local.\n",
  );

  return { root, env: { PLANS_DIR: root }, plan };
}

function opened(root: string): Store {
  return openStore(join(root, "plans.db"));
}

function inStore<T>(root: string, read: (store: Store) => T): T {
  const store = opened(root);
  try {
    return read(store);
  } finally {
    store.db.close();
  }
}

type Hit = {
  project: string;
  ref: string;
  slug: string;
  section: string;
  path: string;
  body: string;
};

function match(store: Store, word: string, table = "recall"): Hit[] {
  return store.db
    .query(
      `SELECT project, ref, slug, section, path, body FROM ${table} WHERE ${table} MATCH ?
       ORDER BY project, ref, section, path`,
    )
    .all(`"${word}"`) as Hit[];
}

function dump(store: Store): unknown[] {
  return ["recall", "recall_trigram"].flatMap((table) =>
    store.db
      .query(
        `SELECT '${table}' AS t, slug, section, body, project, ref, path, recorded FROM ${table}
         ORDER BY project, ref, path, section, body, recorded`,
      )
      .all(),
  );
}

test("a plan splits into one document per heading outside a fence", () => {
  expect(sections(PLAN)).toEqual([
    {
      section: "Outcome",
      body: "Revision history of plans, revision text kept.\n\n```\n## Not a heading\n```",
    },
    { section: "Notes", body: "First note." },
    { section: "Notes", body: "Second note." },
  ]);
});

test("the migration indexes an existing store's files and trail", async () => {
  const { root, env } = plans();
  await importStore(env);
  await appendLog("Skills", "007", "thread", "labels-thread", env);

  const before = inStore(root, (store) => {
    const built = dump(store);

    for (const table of ["recall", "recall_trigram", "recall_docs", "recall_state"])
      store.db.run(`DROP TABLE ${table}`);

    store.db.run("PRAGMA user_version = 3");
    return built;
  });

  inStore(root, (store) => {
    expect(dump(store)).toEqual(before);
    expect(match(store, "revisions").map((hit) => [hit.ref, hit.section])).toEqual([
      ["007", "Outcome"],
    ]);

    expect(match(store, "labels").map((hit) => [hit.ref, hit.section, hit.path])).toEqual([
      ["007", "trail", "log.tsv"],
      ["008", "Outcome", "Skills/008-eight.md"],
      ["ctx-batch", "Invariant", "Skills/ctx-batch.md"],
    ]);

    expect(match(store, "set-row", "recall_trigram")).toEqual([]);
  });
});

test("a recorded edit replaces the plan's documents and the move into done supersedes them", async () => {
  const { root, env, plan } = plans();
  await importStore(env);

  writeFileSync(plan, "# 007 seven\n\n## Outcome\n\nCalls recordRevision after plans.db opens.\n");
  await recordWorkingCopies(root, [plan]);

  inStore(root, (store) => {
    expect(match(store, "history")).toEqual([]);
    expect(match(store, "recordRev", "recall_trigram").map((hit) => hit.path)).toEqual([
      "Skills/007-seven.md",
    ]);
  });

  const moved = join(root, "Skills", "done", "007-seven.md");
  renameSync(plan, moved);
  await recordWorkingCopies(root, [moved]);

  inStore(root, (store) => {
    const paths = store.db.query("SELECT path FROM recall WHERE ref = '007'").all();
    expect(paths).toEqual([{ path: "Skills/done/007-seven.md" }]);
  });
});

test("the edit hook's record and the spool drain both index the edit", async () => {
  const { root, env, plan } = plans();
  await importStore(env);

  writeFileSync(plan, "# 007 seven\n\n## Outcome\n\nHooked text.\n");
  recordPlanEdits({ tool_name: "Write", tool_input: { file_path: plan } }, env);
  inStore(root, (store) => expect(match(store, "hooked").map((hit) => hit.ref)).toEqual(["007"]));

  spoolRevision(
    root,
    "Skills/007-seven.md",
    Buffer.from("## Outcome\n\nSpooled text.\n"),
    new Date().toISOString(),
  );

  inStore(root, (store) => {
    expect(match(store, "hooked")).toEqual([]);
    expect(match(store, "spooled").map((hit) => hit.ref)).toEqual(["007"]);
  });
});

test("set-row changes the joined status and leaves the index alone", async () => {
  const { root, env } = plans();
  await importStore(env);
  await appendLog("Skills", "007", "start", "feat/seven", env);
  await appendLog("Skills", "-", "start", "chore/adhoc", env);

  const status = (store: Store, word: string) => {
    const world = { rows: projectedRows(store), issues: storedIssues(store) };
    return match(store, word).map((hit) => recallStatus(hit, world));
  };

  const before = inStore(root, (store) => {
    expect(status(store, "revisions")).toEqual(["TODO"]);
    expect(status(store, "seven")).toEqual(["TODO", "TODO", "TODO", "TODO"]);
    expect(status(store, "adhoc")).toEqual(["-"]);
    expect(status(store, "local")).toEqual(["ctx"]);
    return dump(store);
  });

  await updateIndex(join(root, "Skills", "index.tsv"), (rows) => {
    const row = rows.find((each) => each.id === "007")!;
    row.status = "DOING";
  });

  inStore(root, (store) => {
    expect(status(store, "revisions")).toEqual(["DOING"]);
    expect(dump(store)).toEqual(before);
  });
});

test("an issue indexes its title and body and joins open or closed", async () => {
  const { root, env } = plans();
  await importStore(env);

  inStore(root, (store) => {
    const at = Date.now();
    write(store, () =>
      fileIssue(
        store,
        "Skills",
        { title: "Recall misses", body: "Fragments of paths.", from: null },
        at,
      ),
    );

    const world = () => ({ rows: projectedRows(store), issues: storedIssues(store) });
    const [hit] = match(store, "fragments");
    expect(hit).toMatchObject({ project: "Skills", ref: "#1", section: "issue", path: "-" });
    expect(recallStatus(hit!, world())).toBe("open");

    write(store, () =>
      closeIssue(
        store,
        { project: "Skills", n: 1, text: "Skills#1" },
        { reason: "fixed", resolvedBy: [] },
        at + 1,
      ),
    );

    expect(match(store, "fragments")).toHaveLength(1);
    expect(recallStatus(hit!, world())).toBe("closed");
  });
});

test("a synced revision waits for its blob and a quarantined event leaves the index", async () => {
  const { root, env } = plans();
  await importStore(env);

  inStore(root, (store) => {
    const text = Buffer.from("## Outcome\n\nRemote words.\n");
    const digest = sha256(text);
    const captured = new Date(Date.now() + 1000).toISOString();
    const path = "Skills/007-seven.md";

    write(store, () => {
      const payload = {
        path,
        sha256: digest,
        captured,
        size: text.byteLength,
        blob: "a".repeat(32),
      };

      const event = appendEvent(store, {
        kind: "stored",
        type: "revision",
        at: Date.parse(captured),
        project: "Skills",
        plan: "007",
        payload,
      });

      insertRevision(store, {
        event,
        project: "Skills",
        path,
        sha256: digest,
        captured,
        machine: "m",
        size: text.byteLength,
        locator: "a".repeat(32),
      });
    });

    expect(match(store, "revisions")).toEqual([]);
    expect(match(store, "remote")).toEqual([]);

    write(store, () => {
      storeBlob(store, digest, text, "a".repeat(32));
      markRecallBlob(store.db, digest);
    });

    expect(match(store, "remote").map((hit) => hit.ref)).toEqual(["007"]);

    write(store, () => {
      const id = store.db.query("SELECT event FROM revisions WHERE sha256 = ?").get(digest) as {
        event: string;
      };

      store.db.run("UPDATE events SET quarantined = 'revoked' WHERE id = ?", [id.event]);
      markRecallEvents(store.db, [id.event]);
    });

    expect(match(store, "remote")).toEqual([]);
    expect(match(store, "revisions").map((hit) => hit.ref)).toEqual(["007"]);
  });
});

test("dropping and rebuilding the index gives the same documents", async () => {
  const { root, env, plan } = plans();
  await importStore(env);

  writeFileSync(plan, "# 007 seven\n\n## Outcome\n\nEdited.\n");
  await recordWorkingCopies(root, [plan]);
  await appendLog("Skills", "008", "thread", "eight-thread", env);
  inStore(root, (store) =>
    write(store, () =>
      fileIssue(store, "Skills", { title: "One", body: null, from: null }, Date.now()),
    ),
  );

  inStore(root, (store) => {
    const incremental = dump(store);
    write(store, () => rebuildRecall(store.db));
    expect(dump(store)).toEqual(incremental);
    expect(incremental.length).toBeGreaterThan(0);
  });
});

test("two plan files that share an id are two plans, each joined to its own row", async () => {
  const { root, env } = plans();
  writeFileSync(
    join(root, "Skills", "007-output.md"),
    "# 007 output\n\n## Findings\n\nOutput words.\n",
  );

  const row = ["007", "output", "DONE", "P1", "S", "-", "-", "-", "2026-11-09", "-"].join("\t");
  writeFileSync(
    join(root, "Skills", "index.tsv"),
    `${readFileSync(join(root, "Skills", "index.tsv"), "utf8")}${row}\n`,
  );

  await importStore(env);

  inStore(root, (store) => {
    const world = { rows: projectedRows(store), issues: storedIssues(store) };
    const hits = [...match(store, "output"), ...match(store, "revisions")];
    expect(hits.map((hit) => [hit.ref, hit.slug, recallStatus(hit, world)])).toEqual([
      ["007", "output", "DONE"],
      ["007", "seven", "TODO"],
    ]);
  });
});

test("a legacy trail line named revision is a trail document", async () => {
  const { root, env } = plans();
  writeFileSync(
    join(root, "log.tsv"),
    `${LOG_HEADER}2026-01-02T03:04:05Z\tSkills\t007\trevision\tlegacy-revision words\n`,
  );

  await importStore(env);
  inStore(root, (store) =>
    expect(match(store, "legacy").map((hit) => [hit.ref, hit.section])).toEqual([["007", "trail"]]),
  );
});
