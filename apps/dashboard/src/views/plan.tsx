import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  machineLabel,
  machineLabels,
  planPage,
  type PlanPage,
  type RevisionEntry,
  type SessionEntry,
  type TimelineEntry,
  type TimelineFact,
} from "skills-core";
import { hunkHeader, unifiedDiff } from "../diff.ts";
import { Markdown } from "../markdown.tsx";
import type { View, ViewProps } from "../view.ts";

const EMPTY = "no plan";

export type Pair = { from: number; to: number };

export type Texts = ReadonlyMap<string, string | null>;

const UNREADABLE = "revision text not available yet, trying again";

const RETRY_MS = 5_000;

export type PlanDetailProps = {
  project: string;
  id: string;
  page: PlanPage;
  labels: ReadonlyMap<string, string>;
  texts: Texts;
  pair: Pair | undefined;
  onPair?: (pair: Pair) => void;
  link: ViewProps["link"];
};

type Title = { text: string; anchor?: { href: string; text: string }; detail?: string };

function prWord(fact: TimelineFact & { kind: "pr" }): string {
  return fact.verdict ?? fact.state;
}

function titleOf(fact: TimelineFact, link: ViewProps["link"]): Title {
  if (fact.kind === "row") return { text: fact.type };
  if (fact.kind === "status") {
    if (fact.from === fact.to)
      return { text: fact.to, detail: fact.changed.join(" ") || undefined };

    return { text: fact.from === undefined ? fact.to : `${fact.from} -> ${fact.to}` };
  }

  if (fact.kind === "trail") return { text: fact.verb, detail: fact.detail };
  if (fact.kind === "thread")
    return {
      text: "thread",
      anchor: { href: `t3-thread://v1/${encodeURIComponent(fact.thread)}`, text: fact.thread },
    };

  if (fact.kind === "session")
    return {
      text: "session",
      anchor: { href: link(`/sessions/${encodeURIComponent(fact.session)}`), text: fact.session },
    };

  if (fact.kind === "pr")
    return { text: `#${fact.pr} ${prWord(fact)}`, detail: `${fact.state} ${fact.head}`.trim() };

  if (fact.kind === "round")
    return {
      text: fact.outcomes.map(([reviewer, outcome]) => `${reviewer} ${outcome}`).join(", "),
      detail: `#${fact.pr} ${fact.verdict}`,
    };

  if (fact.kind === "revision")
    return { text: "revision", detail: `${fact.sha256.slice(0, 12)} ${fact.size} bytes` };

  return { text: fact.type };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `plan-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Text({ revision, texts }: { revision: RevisionEntry | undefined; texts: Texts }) {
  if (!revision) return <p className="text-ink-secondary">no revision recorded</p>;

  const text = texts.get(revision.sha256);
  if (text === undefined) return <p className="text-ink-secondary">reading revision</p>;
  if (text === null) return <p className="text-ink-secondary">{UNREADABLE}</p>;

  return (
    <article data-revision={revision.sha256} className="min-w-0">
      <Markdown text={text} />
    </article>
  );
}

function Timeline({ page, labels, link }: Pick<PlanDetailProps, "page" | "labels" | "link">) {
  return (
    <ol className="flex flex-col">
      {page.timeline.map((entry: TimelineEntry, index) => {
        const title = titleOf(entry.fact, link);
        return (
          <li
            key={index}
            data-kind={entry.fact.kind}
            className="flex flex-wrap items-baseline gap-x-3 border-b border-hairline py-1 text-sm"
          >
            <time
              dateTime={entry.ts}
              className="font-mono whitespace-nowrap text-ink-secondary tabular-nums"
            >
              {entry.ts}
            </time>
            <span data-title="" className="font-medium">
              {title.text}
              {title.anchor ? (
                <>
                  {" "}
                  <a
                    href={title.anchor.href}
                    className="font-mono underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    {title.anchor.text}
                  </a>
                </>
              ) : null}
            </span>
            {title.detail ? (
              <span className="font-mono text-ink-secondary">{title.detail}</span>
            ) : null}
            <span className="ml-auto text-ink-muted">{machineLabel(labels, entry.machine)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Hunks({ before, after, names }: { before: string; after: string; names: string }) {
  const hunks = useMemo(() => unifiedDiff(before, after), [before, after]);
  if (hunks.length === 0) {
    const same = before === after ? "no change" : "differ only in the final newline";
    return <p className="text-sm text-ink-secondary">{`${names}: ${same}`}</p>;
  }

  return (
    <pre
      aria-label={`Diff of ${names}`}
      data-diff=""
      className="overflow-x-auto rounded border border-hairline bg-surface p-3 font-mono text-sm"
    >
      {hunks.map((hunk, index) => (
        <span key={index} className="block">
          <span className="block text-ink-muted">{hunkHeader(hunk)}</span>
          {hunk.lines.map((line, at) => (
            <span
              key={at}
              data-mark={line.mark === " " ? "context" : line.mark === "+" ? "added" : "removed"}
              className="block whitespace-pre data-[mark=added]:font-medium data-[mark=removed]:text-accent"
            >
              {`${line.mark}${line.text}`}
            </span>
          ))}
        </span>
      ))}
    </pre>
  );
}

function Diff({
  pair,
  texts,
  revisions,
}: {
  pair: Pair;
  texts: Texts;
  revisions: readonly RevisionEntry[];
}) {
  const before = texts.get(revisions[pair.from]?.sha256 ?? "");
  const after = texts.get(revisions[pair.to]?.sha256 ?? "");
  if (before === undefined || after === undefined)
    return <p className="text-sm text-ink-secondary">reading revisions</p>;

  if (before === null || after === null)
    return <p className="text-sm text-ink-secondary">{UNREADABLE}</p>;

  const names = `r${pair.from + 1} against r${pair.to + 1}`;
  return <Hunks before={before} after={after} names={names} />;
}

function Picker({
  label,
  value,
  revisions,
  onChange,
}: {
  label: string;
  value: number;
  revisions: readonly RevisionEntry[];
  onChange: (index: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink-secondary">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="rounded border border-hairline bg-surface px-2 py-1 font-mono text-ink focus:outline-2 focus:outline-focus"
      >
        {revisions.map((revision, index) => (
          <option key={index} value={index}>
            r{index + 1} {revision.captured}
          </option>
        ))}
      </select>
    </label>
  );
}

const REVISION_COLUMNS = ["", "Time", "sha256", "Machine id", "Bytes"];
function Revisions({
  page,
  texts,
  pair,
  onPair,
}: Pick<PlanDetailProps, "page" | "texts" | "pair" | "onPair">) {
  const { revisions } = page;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-ink-secondary">
            <tr className="border-b border-hairline">
              {REVISION_COLUMNS.map((column) => (
                <th key={column} scope="col" className="py-1 pr-4 font-normal whitespace-nowrap">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {revisions.map((revision, index) => (
              <tr
                key={revision.sha256 + index}
                className="border-b border-hairline font-mono tabular-nums"
              >
                <td className="py-1 pr-4">r{index + 1}</td>
                <td className="py-1 pr-4 whitespace-nowrap">
                  <time dateTime={revision.captured}>{revision.captured}</time>
                </td>
                <td className="py-1 pr-4 whitespace-nowrap">{revision.sha256}</td>
                <td className="py-1 pr-4 whitespace-nowrap">{revision.machine}</td>
                <td className="py-1 pr-4">{revision.size}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pair && revisions.length > 1 ? (
        <>
          <div className="flex flex-wrap gap-4">
            <Picker
              label="From"
              value={pair.from}
              revisions={revisions}
              onChange={(from) => onPair?.({ ...pair, from })}
            />
            <Picker
              label="To"
              value={pair.to}
              revisions={revisions}
              onChange={(to) => onPair?.({ ...pair, to })}
            />
          </div>
          <Diff pair={pair} texts={texts} revisions={revisions} />
        </>
      ) : null}
    </div>
  );
}

const SESSION_COLUMNS = [
  "Session",
  "Host",
  "Branch",
  "Machine",
  "Models",
  "Tokens in",
  "Tokens out",
  "Tool calls",
];

function Sessions({
  sessions,
  labels,
  link,
}: {
  sessions: readonly SessionEntry[];
  labels: PlanDetailProps["labels"];
  link: ViewProps["link"];
}) {
  if (sessions.length === 0) return <p className="text-sm text-ink-secondary">no sessions</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-ink-secondary">
          <tr className="border-b border-hairline">
            {SESSION_COLUMNS.map((column) => (
              <th key={column} scope="col" className="py-1 pr-4 font-normal whitespace-nowrap">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr
              key={`${session.host} ${session.session}`}
              data-session={session.session}
              className="border-b border-hairline"
            >
              <td className="py-1 pr-4 font-mono">
                <a
                  href={link(`/sessions/${encodeURIComponent(session.session)}`)}
                  className="underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
                >
                  {session.session}
                </a>
              </td>
              <td className="py-1 pr-4">{session.host}</td>
              <td className="py-1 pr-4 font-mono">{session.branch || "-"}</td>
              <td className="py-1 pr-4">{machineLabel(labels, session.machine)}</td>
              <td className="py-1 pr-4">{session.models.join(" ") || "-"}</td>
              <td data-cell="in" className="py-1 pr-4 font-mono tabular-nums">
                {session.in}
              </td>
              <td data-cell="out" className="py-1 pr-4 font-mono tabular-nums">
                {session.out}
              </td>
              <td className="py-1 pr-4 font-mono tabular-nums">{session.tools}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PlanDetail(props: PlanDetailProps) {
  const { project, id, page, labels, texts, pair, onPair, link } = props;
  if (!page.row && page.timeline.length === 0) return <p className="text-ink-secondary">{EMPTY}</p>;

  const heading = page.row ? `${project} ${id} ${page.row.slug}` : `${project} ${id}`;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="font-mono font-medium">{heading}</span>
        {page.row ? (
          <span className="text-sm text-ink-secondary">
            {page.row.status}
            {page.row.branch === "-" ? "" : ` on ${page.row.branch}`}
          </span>
        ) : null}
      </div>
      <Section title="Text">
        <Text revision={page.revisions.at(-1)} texts={texts} />
      </Section>
      <Section title="Timeline">
        <Timeline page={page} labels={labels} link={link} />
        {page.blocks.length === 0 ? null : (
          <p data-blocks="" className="text-sm text-ink-secondary">
            Hook blocks: {page.blocks.map(([rule, count]) => `${rule} ${count}`).join(", ")}
          </p>
        )}
      </Section>
      <Section title="Revisions">
        {page.revisions.length === 0 ? (
          <p className="text-sm text-ink-secondary">no revision recorded</p>
        ) : (
          <Revisions page={page} texts={texts} pair={pair} onPair={onPair} />
        )}
      </Section>
      <Section title="Sessions">
        <Sessions sessions={page.sessions} labels={labels} link={link} />
      </Section>
    </div>
  );
}

export function defaultPair(revisions: readonly RevisionEntry[]): Pair | undefined {
  const count = revisions.length;
  return count > 1 ? { from: count - 2, to: count - 1 } : undefined;
}

function pairIn(chosen: Pair | undefined, revisions: readonly RevisionEntry[]): Pair | undefined {
  const fits = chosen && chosen.from < revisions.length && chosen.to < revisions.length;
  return fits ? chosen : defaultPair(revisions);
}

function wanted(page: PlanPage, pair: Pair | undefined): string[] {
  const picked = pair ? [page.revisions[pair.from], page.revisions[pair.to]] : [];
  const shas = [page.revisions.at(-1), ...picked].map((revision) => revision?.sha256);
  return [...new Set(shas.filter((sha256) => sha256 !== undefined))];
}

function PlanView({ scene, params, link, blob }: ViewProps) {
  const [project = "", id = ""] = params;
  const page = useMemo(() => planPage(scene.events, project, id), [scene.events, project, id]);
  const labels = useMemo(() => machineLabels(scene.events), [scene.events]);

  const [chosen, setChosen] = useState<Pair>();
  const [texts, setTexts] = useState<Texts>(new Map());
  const [attempt, setAttempt] = useState(0);

  const pair = pairIn(chosen, page.revisions);
  const missing = wanted(page, pair)
    .filter((sha256) => (texts.get(sha256) ?? null) === null)
    .join(" ");

  useEffect(() => {
    if (missing === "") return;

    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const reads = missing.split(" ").map(async (sha256) => {
      const text = await blob(sha256).catch(() => undefined);
      return [sha256, text ?? null] as const;
    });

    void Promise.all(reads).then((read) => {
      if (!current) return;

      setTexts((held) => new Map([...held, ...read]));

      if (read.some(([, text]) => text === null))
        retry = setTimeout(() => setAttempt((count) => count + 1), RETRY_MS);
    });

    return () => {
      current = false;
      clearTimeout(retry);
    };
  }, [missing, blob, attempt]);

  if (params.length !== 2) return <p className="text-ink-secondary">{EMPTY}</p>;

  return (
    <PlanDetail
      project={project}
      id={id}
      page={page}
      labels={labels}
      texts={texts}
      pair={pair}
      onPair={setChosen}
      link={link}
    />
  );
}

export const plan: View = {
  name: "Plan",
  path: "/plan",
  empty: EMPTY,
  detail: true,
  Component: PlanView,
};
