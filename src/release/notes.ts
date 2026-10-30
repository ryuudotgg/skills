import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangelogEntry } from "tegami";

export const packageName = "skills-cli";
export const repoUrl = "https://github.com/ryuudotgg/skills";
export const versionBranch = "tegami/version-packages";

export const categories = [
  { emoji: "🚨", title: "Heads up" },
  { emoji: "✨", title: "New" },
  { emoji: "🎨", title: "Improved" },
  { emoji: "🐛", title: "Fixed" },
  { emoji: "🧰", title: "Internal" },
] as const;

const variationSelector = String.fromCodePoint(0xfe0f);

type Category = (typeof categories)[number];

export type Reference = {
  label: string;
  url: string;
};

export type Change = {
  category: Category;
  title: string;
  body: string;
  reference?: Reference;
};

type Section = ChangelogEntry["sections"][number];

export function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);

  return result.stdout.toString();
}

export function parseChange(filename: string, section: Section, reference?: Reference): Change {
  const refuse = (problem: string) => new Error(`.tegami/${filename}: ${problem}`);
  if (section.depth !== 3)
    throw refuse(
      `"${section.title}" is not a ### heading. Give each change one ### heading and no other headings`,
    );

  const category = categories.find(({ emoji }) => section.title.startsWith(emoji));
  const rest = category ? section.title.slice(category.emoji.length) : "";
  const title = /^ +(\S.*)$/.exec(rest.startsWith(variationSelector) ? rest.slice(1) : rest)?.[1];
  if (!category || !title)
    throw refuse(
      `start the heading "${section.title}" with one of ${categories.map(({ emoji }) => emoji).join(" ")} and a title`,
    );

  if (/\n\s*\n|^\s*([-*+] |\d+\. |>|\||```|~~~)/m.test(section.content))
    throw refuse(`keep the body under "${section.title}" to one plain paragraph`);

  const body = section.content
    .split("\n")
    .map((line) => line.trim())
    .join(" ")
    .trim();

  return { category, title: title.trim(), body, reference };
}

export function hasHeading(markdown: string): boolean {
  let fence: string | undefined;
  for (const line of markdown.split(/\r\n|\r|\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !fence) fence = marker;
    else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length)
      fence = undefined;
    else if (!fence && /^ {0,3}#{1,6}([ \t]|$)/.test(line)) return true;
  }

  return false;
}

export function assertHeadings(changelogDir: string): void {
  if (!existsSync(changelogDir)) return;

  for (const file of readdirSync(changelogDir).filter((name) => name.endsWith(".md"))) {
    const content = readFileSync(join(changelogDir, file), "utf8").replace(
      /^---\r?\n(.+?)\r?\n---\r?\n?/s,
      "",
    );

    if (!hasHeading(content))
      throw new Error(
        `.tegami/${file}: it has no heading, so Tegami would drop it. Give the change a ### heading`,
      );
  }
}

export function assertEntries(entries: readonly ChangelogEntry[]): void {
  if (!entries.some((entry) => entry.packages.has(packageName)))
    throw new Error(`No pending notes in .tegami/: add one naming ${packageName} and its bump`);

  for (const entry of entries) {
    if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(entry.filename))
      throw new Error(
        `.tegami/${entry.filename}: name the note <date>-<topic>.md, such as 2026-10-30-release-through-tegami.md`,
      );

    for (const section of entry.sections) parseChange(entry.filename, section);
  }
}

export function addedIn(cwd: string, path: string): Reference | undefined {
  const [sha, short, subject] = git(cwd, [
    "log",
    "-n",
    "1",
    "--diff-filter=A",
    "--format=%H%x00%h%x00%s",
    "--",
    path,
  ])
    .trim()
    .split("\0");

  if (!sha || !short) return undefined;

  const pr = /\(#(\d+)\)$/.exec(subject ?? "")?.[1];
  return pr
    ? { label: `#${pr}`, url: `${repoUrl}/pull/${pr}` }
    : { label: short, url: `${repoUrl}/commit/${sha}` };
}

function renderChange({ title, body, reference }: Change): string {
  const link = reference ? ` ([${reference.label}](${reference.url}))` : "";
  const heading = `- **${title}**${link}`;
  return body ? `${heading}\\\n  ${body}` : heading;
}

export function renderRelease(version: string, changes: readonly Change[], date: Date): string {
  const day = date.toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" });
  const lines = [`## ${version}`, "", `*${day}*`];
  for (const category of categories) {
    const inCategory = changes.filter((change) => change.category === category);
    if (inCategory.length > 0)
      lines.push(
        "",
        `### ${category.emoji} ${category.title}`,
        "",
        ...inCategory.map(renderChange),
      );
  }

  return lines.join("\n");
}

export function changelogSection(cwd: string, version: string): string {
  const lines = readFileSync(join(cwd, "CHANGELOG.md"), "utf8").split("\n");
  const start = lines.indexOf(`## ${version}`);
  if (start === -1) throw new Error(`CHANGELOG.md has no "## ${version}" section to release`);

  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: notes.ts <version>, the release to print notes for");
    process.exit(2);
  }

  console.log(changelogSection(process.cwd(), version));
}
