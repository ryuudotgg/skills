import { useMemo, type ReactNode } from "react";
import { boardRows, type BoardHeartbeat, type BoardPr, type BoardRow } from "skills-core";
import type { View, ViewProps } from "../view.ts";

const EMPTY = "no plans doing";

const COLUMNS = ["Plan", "Machine", "Thread", "Branch", "PR", "Heartbeat", "Conflict"];

const ACCENT = { color: "var(--chart-accent)" };

function prText(pr: BoardPr | undefined): string {
  if (pr === undefined) return "-";
  const head = `#${pr.pr} ${pr.state === "open" ? (pr.verdict ?? "open") : pr.state}`;
  return pr.failing.length === 0 ? head : `${head}: ${pr.failing.join(", ")}`;
}

function Pulse({ heartbeat }: { heartbeat: BoardHeartbeat | undefined }) {
  if (heartbeat === undefined) return "none";
  if (!heartbeat.stale) return `${heartbeat.minutes} min`;
  return <span style={ACCENT}>stale {heartbeat.minutes} min</span>;
}

function Cell({ children, wraps = false }: { children: ReactNode; wraps?: boolean }) {
  const flow = wraps ? "min-w-32 [overflow-wrap:anywhere]" : "whitespace-nowrap";
  return <td className={`py-1.5 pr-4 align-baseline ${flow}`}>{children}</td>;
}

function Row({ row, link }: { row: BoardRow; link: ViewProps["link"] }) {
  const plan = `/plan/${encodeURIComponent(row.project)}/${encodeURIComponent(row.id)}`;
  return (
    <tr data-plan={`${row.project}/${row.id}`} className="border-b border-hairline">
      <Cell wraps>
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-ink-secondary">{row.project}</span>
          <a
            href={link(plan)}
            className="font-mono underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
          >
            {row.id}
          </a>
          <span className="font-medium">{row.slug}</span>
        </span>
      </Cell>
      <Cell>{row.machine ?? "-"}</Cell>
      <Cell>
        {row.thread === undefined ? (
          "-"
        ) : (
          <a
            href={`t3-thread://v1/${row.thread}`}
            className="underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
          >
            open
          </a>
        )}
      </Cell>
      <Cell wraps>
        <span className="font-mono">{row.branch}</span>
      </Cell>
      <Cell wraps>
        <span className="font-mono tabular-nums">{prText(row.pr)}</span>
      </Cell>
      <Cell>
        <span className="tabular-nums">
          <Pulse heartbeat={row.heartbeat} />
        </span>
      </Cell>
      <Cell>
        {row.conflict === undefined ? null : (
          <span style={ACCENT}>conflict with {row.conflict}</span>
        )}
      </Cell>
    </tr>
  );
}

export function BoardTable({ scene, link }: Pick<ViewProps, "scene" | "link">) {
  const rows = useMemo(() => boardRows(scene.events, scene.now), [scene]);
  if (rows.length === 0) return <p className="text-ink-secondary">{EMPTY}</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-hairline text-ink-secondary">
            {COLUMNS.map((name) => (
              <th key={name} scope="col" className="py-1.5 pr-4 font-normal whitespace-nowrap">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={`${row.project}/${row.id}`} row={row} link={link} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const board: View = { name: "Board", path: "/board", empty: EMPTY, Component: BoardTable };
