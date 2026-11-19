const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/s;
const FRONTMATTER = /^---\r?$/;

export type LineKind = "frontmatter" | "fenced" | "text";

export function lineKinds(lines: readonly string[]): LineKind[] {
  const closing = FRONTMATTER.test(lines[0] ?? "")
    ? lines.findIndex((line, at) => at > 0 && FRONTMATTER.test(line))
    : -1;

  let open: string | undefined;
  return lines.map((line, at) => {
    if (at <= closing) return "frontmatter";

    const match = FENCE.exec(line);
    if (!match) return open === undefined ? "text" : "fenced";

    const [, run = "", rest = ""] = match;
    if (open === undefined) open = run;
    else if (run[0] === open[0] && run.length >= open.length && rest.trim() === "")
      open = undefined;

    return "fenced";
  });
}
