import { git } from "./notes.ts";

export function addedNotes(cwd: string, base: string, head: string): string[] {
  const added = git(cwd, [
    "diff",
    "--name-only",
    "-z",
    "--diff-filter=A",
    `${base}...${head}`,
    "--",
    ":(glob).tegami/*.md",
  ])
    .split("\0")
    .filter(Boolean);

  return added.filter((note) => /^### /m.test(git(cwd, ["show", `${head}:${note}`])));
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: require-note.ts <base> <head>");
    process.exit(2);
  }

  const notes = addedNotes(process.cwd(), base, head);
  if (!notes.length) {
    console.error(
      "This pull request adds no note with a ### heading in .tegami/. Add one as the Releases section of AGENTS.md describes, internal changes included.",
    );

    process.exit(1);
  }

  for (const note of notes) console.log(note);
}
