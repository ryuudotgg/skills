import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Shell, type ShellProps } from "../src/shell.tsx";
import { events, now } from "./fixture.ts";

type ShellOverrides = Partial<Pick<ShellProps, "search" | "events" | "sync" | "withheld">>;

export function renderShell(pathname: string, overrides: ShellOverrides = {}): string {
  return renderToStaticMarkup(
    createElement(Shell, {
      pathname,
      search: "",
      hash: "#token=fixture",
      events,
      wall: now,
      feed: { kind: "live" },
      read: async () => ({ status: 404, text: "" }),
      ...overrides,
    }),
  );
}

export function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
