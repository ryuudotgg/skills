import { useMemo } from "react";
import { digestsOf, machineLabel, machineLabels, type PlanEvent } from "skills-core";
import { Markdown } from "../markdown.tsx";
import type { View, ViewProps } from "../view.ts";

const EMPTY = "no digests";
export function DigestList({ events }: { events: readonly PlanEvent[] }) {
  const digests = useMemo(() => digestsOf(events), [events]);
  const labels = useMemo(() => machineLabels(events), [events]);
  if (digests.length === 0) return <p className="text-ink-secondary">{EMPTY}</p>;

  return (
    <div className="flex flex-col gap-10">
      {digests.map((digest) => (
        <section key={digest.week} data-week={digest.week} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="font-mono text-lg font-semibold tabular-nums">{digest.week}</h2>
            <p className="text-sm text-ink-secondary">
              {digest.final ? "written" : "partial, written"}{" "}
              <time className="font-mono tabular-nums">{digest.ts}</time> on{" "}
              {machineLabel(labels, digest.machine)}
            </p>
          </div>
          <Markdown text={digest.markdown} depth={1} />
        </section>
      ))}
    </div>
  );
}

function DigestsView({ scene }: ViewProps) {
  return <DigestList events={scene.events} />;
}

export const digests: View = {
  name: "Digests",
  path: "/digests",
  empty: EMPTY,
  Component: DigestsView,
};
