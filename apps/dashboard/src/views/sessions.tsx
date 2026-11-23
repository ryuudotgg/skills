import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  durationText,
  isSessionPolicy,
  machineLabel,
  machineLabels,
  policyAllows,
  sessionList,
  type SessionPolicy,
  type SessionSummary,
} from "skills-core";
import { LeftOut } from "../left-out.tsx";
import { planPath, sessionPath } from "../links.ts";
import type { Reply, View, ViewProps } from "../view.ts";

const EMPTY = "no sessions";

const MISSING = "no such session";

const NO_DIGEST = "no digest for this session";

const RETRY_MS = 5_000;

const PAGE = 200;

export type DigestState =
  | { kind: "reading" }
  | { kind: "shown"; text: string }
  | { kind: "none" }
  | { kind: "failed"; reason: string }
  | { kind: "withheld"; policy: SessionPolicy };

type Labels = ReadonlyMap<string, string>;

export type SessionPages = { count: number; at: number | undefined };

function request(read: ViewProps["read"], path: string): Promise<Reply> {
  return read(path).catch((error: unknown) => ({
    status: 0,
    text: error instanceof Error ? error.message : String(error),
  }));
}

function failure(reply: Reply): string | undefined {
  if (reply.status === 200 || reply.status === 404) return undefined;
  return reply.text.trim() || `HTTP ${reply.status}`;
}

export async function readDigest(
  summary: Pick<SessionSummary, "session" | "digest">,
  read: ViewProps["read"],
  live: boolean,
): Promise<DigestState> {
  const local = live
    ? await request(read, `${sessionPath(summary.session)}/digest`)
    : { status: 404, text: "" };

  if (local.status === 200) return { kind: "shown", text: local.text };

  const policy = local.text.trim();
  if (local.status === 403 && isSessionPolicy(policy)) return { kind: "withheld", policy };

  const pulled =
    summary.digest === null ? undefined : await request(read, `/blobs/${summary.digest}`);

  if (pulled?.status === 200) return { kind: "shown", text: pulled.text };

  const reason = (pulled && failure(pulled)) ?? failure(local);
  return reason === undefined ? { kind: "none" } : { kind: "failed", reason };
}

function Cell({ children, wraps = false }: { children: ReactNode; wraps?: boolean }) {
  const flow = wraps ? "min-w-24 [overflow-wrap:anywhere]" : "whitespace-nowrap";
  return <td className={`py-1.5 pr-4 align-baseline ${flow}`}>{children}</td>;
}

function Anchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="font-mono underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
    >
      {children}
    </a>
  );
}

type RowProps = { summary: SessionSummary; labels: Labels; link: ViewProps["link"] };

type Column = { wraps?: boolean; content: (row: RowProps) => ReactNode };

const CELLS = {
  Time: {
    content: ({ summary }) => (
      <time dateTime={summary.start} className="font-mono text-ink-secondary tabular-nums">
        {summary.start}
      </time>
    ),
  },
  Session: {
    wraps: true,
    content: ({ summary, link }) => (
      <Anchor href={link(sessionPath(summary.session))}>{summary.session}</Anchor>
    ),
  },
  Host: { content: ({ summary }) => summary.host },
  Project: { content: ({ summary }) => summary.project },
  Branch: {
    wraps: true,
    content: ({ summary }) => <span className="font-mono">{summary.branch}</span>,
  },
  Plan: {
    content: ({ summary, link }) =>
      summary.plans.length === 0 ? (
        "-"
      ) : (
        <span className="flex flex-wrap gap-x-2">
          {summary.plans.map((plan) => {
            const [project = "", id = ""] = plan.split("/");
            return (
              <Anchor key={plan} href={link(planPath(project, id))}>
                {plan}
              </Anchor>
            );
          })}
        </span>
      ),
  },
  Models: { content: ({ summary }) => summary.models.join(" ") || "-" },
  "Tokens in": {
    content: ({ summary }) => (
      <span data-cell="in" className="font-mono tabular-nums">
        {summary.in}
      </span>
    ),
  },
  "Tokens out": {
    content: ({ summary }) => (
      <span data-cell="out" className="font-mono tabular-nums">
        {summary.out}
      </span>
    ),
  },
  "Tool calls": {
    content: ({ summary }) => (
      <span data-cell="tools" className="font-mono tabular-nums">
        {summary.tools}
      </span>
    ),
  },
  Duration: {
    content: ({ summary }) => (
      <span className="tabular-nums">
        {summary.duration === null ? "-" : durationText(summary.duration)}
      </span>
    ),
  },
  Machine: { content: ({ summary, labels }) => machineLabel(labels, summary.machine) },
} satisfies Record<string, Column>;

export type SessionColumn = keyof typeof CELLS;

const COLUMNS: readonly SessionColumn[] = [
  "Time",
  "Session",
  "Host",
  "Project",
  "Branch",
  "Plan",
  "Models",
  "Tokens in",
  "Tokens out",
  "Tool calls",
  "Duration",
  "Machine",
];

type ColumnsProp = { columns: readonly SessionColumn[] };

function Row({ columns, ...row }: RowProps & ColumnsProp) {
  return (
    <tr data-session={row.summary.session} className="border-b border-hairline">
      {columns.map((name) => {
        const column: Column = CELLS[name];
        return (
          <Cell key={name} wraps={column.wraps}>
            {column.content(row)}
          </Cell>
        );
      })}
    </tr>
  );
}

export const Table = memo(function Table({
  sessions,
  labels,
  link,
  columns,
}: Omit<RowProps, "summary"> & ColumnsProp & { sessions: readonly SessionSummary[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-hairline text-ink-secondary">
            {columns.map((name) => (
              <th key={name} scope="col" className="py-1.5 pr-4 font-normal whitespace-nowrap">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sessions.map((summary) => (
            <Row
              key={`${summary.host} ${summary.session}`}
              summary={summary}
              labels={labels}
              link={link}
              columns={columns}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
});

function Digest({ state }: { state: DigestState }) {
  if (state.kind === "reading") return <p className="text-ink-secondary">reading digest</p>;
  if (state.kind === "none") return <p className="text-ink-secondary">{NO_DIGEST}</p>;
  if (state.kind === "failed")
    return <p className="text-accent">digest unreadable: {state.reason}</p>;

  if (state.kind === "withheld")
    return <p className="text-ink-secondary">digest not synced under policy {state.policy}</p>;

  return (
    <pre
      data-digest=""
      className="overflow-x-auto rounded border border-hairline bg-surface p-3 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
    >
      {state.text}
    </pre>
  );
}

type SessionDetailProps = {
  summary: SessionSummary;
  labels: Labels;
  digest: DigestState;
  link: ViewProps["link"];
};

export function SessionDetail({ summary, labels, digest, link }: SessionDetailProps) {
  return (
    <div className="flex flex-col gap-8">
      <Table sessions={[summary]} labels={labels} link={link} columns={COLUMNS} />
      <section aria-labelledby="session-digest" className="flex min-w-0 flex-col gap-3">
        <h2 id="session-digest" className="text-base font-semibold">
          Digest
        </h2>
        <Digest state={digest} />
      </section>
    </div>
  );
}

function withheld(summary: SessionSummary): DigestState | undefined {
  return policyAllows(summary.policy, "redacted")
    ? undefined
    : { kind: "withheld", policy: summary.policy };
}

function SessionPage({
  summary,
  labels,
  link,
  read,
  live,
}: Omit<SessionDetailProps, "digest"> & {
  read: ViewProps["read"];
  live: boolean;
}) {
  const [state, setState] = useState<DigestState>({ kind: "reading" });
  const [attempt, setAttempt] = useState(0);

  const held = withheld(summary);
  const { session, digest } = summary;
  const fetches = held === undefined;
  const version = [summary.end, summary.in, summary.out, summary.tools].join(" ");

  useEffect(() => {
    if (!fetches) return;

    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void readDigest({ session, digest }, read, live).then((next) => {
      if (!current) return;

      setState(next);

      if (next.kind === "failed" || (next.kind === "none" && digest !== null))
        retry = setTimeout(() => setAttempt((count) => count + 1), RETRY_MS);
    });

    return () => {
      current = false;
      clearTimeout(retry);
    };
  }, [fetches, session, digest, version, read, live, attempt]);

  return <SessionDetail summary={summary} labels={labels} digest={held ?? state} link={link} />;
}

type SessionListProps = {
  sessions: readonly SessionSummary[];
  labels: Labels;
  link: ViewProps["link"];
  at: number | undefined;
  pages?: SessionPages;
  onPages?: (pages: SessionPages) => void;
};

export function SessionList({ sessions, labels, link, at, pages, onPages }: SessionListProps) {
  const count = pages !== undefined && pages.at === at ? pages.count : 1;
  const shown = useMemo(() => sessions.slice(0, count * PAGE), [sessions, count]);

  if (sessions.length === 0) return <p className="text-ink-secondary">{EMPTY}</p>;

  const left = sessions.length - shown.length;
  return (
    <div className="flex flex-col gap-4">
      <Table sessions={shown} labels={labels} link={link} columns={COLUMNS} />
      {left === 0 ? null : (
        <LeftOut
          text={`${left} older session${left === 1 ? "" : "s"} not shown`}
          action={`Show ${PAGE} more`}
          onMore={() => onPages?.({ count: count + 1, at })}
        />
      )}
    </div>
  );
}

function SessionsView({ scene, params, link, read }: ViewProps) {
  const sessions = useMemo(
    () => sessionList(scene.events, scene.sessions),
    [scene.events, scene.sessions],
  );

  const labels = useMemo(() => machineLabels(scene.events), [scene.events]);
  const [pages, setPages] = useState<SessionPages>();
  if (pages !== undefined && pages.at !== scene.at) setPages(undefined);

  const [id] = params;

  if (params.length > 1) return <p className="text-ink-secondary">{MISSING}</p>;
  if (id !== undefined) {
    const summary = sessions.find((each) => each.session === id);
    if (!summary) return <p className="text-ink-secondary">{MISSING}</p>;
    return (
      <SessionPage
        key={summary.session}
        summary={summary}
        labels={labels}
        link={link}
        read={read}
        live={scene.at === undefined}
      />
    );
  }

  return (
    <SessionList
      sessions={sessions}
      labels={labels}
      link={link}
      at={scene.at}
      pages={pages}
      onPages={setPages}
    />
  );
}

export const sessions: View = {
  name: "Sessions",
  path: "/sessions",
  detail: true,
  Component: SessionsView,
};
