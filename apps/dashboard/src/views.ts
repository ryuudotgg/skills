import type { View } from "./view.ts";
import { board } from "./views/board.tsx";
import { digests } from "./views/digests.tsx";
import { evals } from "./views/evals.tsx";
import { frontier } from "./views/frontier.tsx";
import { plan } from "./views/plan.tsx";
import { sessions } from "./views/sessions.tsx";
import { stats } from "./views/stats.tsx";

export const views: readonly View[] = [board, frontier, plan, stats, evals, digests, sessions];

export type Match = { view: View; params: string[] };

function decoded(segments: readonly string[]): string[] | undefined {
  try {
    return segments.map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

export function matchView(pathname: string): Match | undefined {
  const [first = "", ...rest] = pathname.split("/").filter((segment) => segment !== "");
  const view = first === "" ? board : views.find((each) => each.path === `/${first}`);
  if (!view || (rest.length > 0 && !view.detail)) return undefined;

  const params = decoded(rest);
  return params && { view, params };
}
