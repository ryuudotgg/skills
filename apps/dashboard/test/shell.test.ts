import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FeedEvent } from "skills-core";
import { Shell } from "../src/shell.tsx";
import { views } from "../src/views.ts";
import { cut, events, now } from "./fixture.ts";

const HASH = "#token=fixture";

const routes = [
  ["/board", "Board", "no plans doing"],
  ["/frontier", "Frontier", "no plans"],
  ["/plan", "Plan", "no plan"],
  ["/stats", "Stats", "no stats"],
  ["/evals", "Eval history", "no eval runs"],
  ["/digests", "Digests", "no digests"],
  ["/sessions", "Sessions", "no sessions"],
] as const;

function render(pathname: string, search = "", feed: readonly FeedEvent[] = []): string {
  return renderToStaticMarkup(
    createElement(Shell, {
      pathname,
      search,
      hash: HASH,
      events: feed,
      wall: now,
      feed: { kind: "live" },
      read: async () => ({ status: 404, text: "" }),
    }),
  );
}

function navLinks(html: string): string[] {
  const nav = /<nav[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? "";
  return [...nav.matchAll(/<a [^>]*href="([^"]+)"/g)].map(([, href]) => href ?? "");
}

test("the shell holds one navigation link per route of the view table, each keeping the token", () => {
  expect(navLinks(render("/board"))).toEqual(routes.map(([path]) => `${path}${HASH}`));
  expect(views.map((view) => view.path)).toEqual(routes.map(([path]) => path));
});

test("each route renders its empty state under its view name", () => {
  for (const [path, name, empty] of routes) {
    const html = render(path);
    expect(html).toContain(`<h1 id="view-name" class="mb-4 text-lg font-semibold">${name}</h1>`);
    expect(html).toContain(`>${empty}</p>`);
  }

  expect(render("/plan/Alpha/002")).toContain(">no plan</p>");
  expect(render("/sessions/s-1")).toContain(">no such session</p>");
  expect(render("/")).toContain(">no plans doing</p>");
});

test("a path no view takes, or one that does not decode, renders no such view", () => {
  for (const path of ["/nowhere", "/board/extra", "/plan/Alpha/%E0"])
    expect(render(path)).toContain("no such view");
});

test("with the cut set the shell shows it and every link keeps it", () => {
  const html = render("/board", `?at=${cut}`, events);

  expect(html).toContain("2026-11-03T12:00:00Z");
  expect(navLinks(html)).toEqual(routes.map(([path]) => `${path}?at=2026-11-03T12:00:00Z${HASH}`));
  expect(html).toContain("local only");
});

test("a cut that is not a time renders no view, says so and keeps the text to fix", () => {
  const html = render("/board", "?at=yesterday", events);

  expect(html).toContain("not a time: yesterday");
  expect(html).toContain('value="yesterday"');
  expect(html).not.toContain("no plans doing");
});

test("the theme defines every chart token in both themes", () => {
  const css = readFileSync(join(import.meta.dir, "../src/theme.css"), "utf8");
  const tokens = [1, 2, 3, 4, 5, 6].map((slot) => `--chart-${slot}`);
  tokens.push("--chart-accent", "--chart-neutral", "--chart-grid", "--chart-text");

  for (const scope of [":root", ".dark"]) {
    const block =
      new RegExp(`^${scope.replace(".", "\\.")} \\{(.*?)^\\}`, "ms").exec(css)?.[1] ?? "";

    for (const token of tokens) expect(block).toMatch(new RegExp(`${token}: #[0-9a-f]{6};`));
  }
});
