import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectIgnore } from "./ignore.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ignoreWith(rootRules: string, projectRules: string) {
  const root = mkdtempSync(join(tmpdir(), "plans-ignore-"));
  roots.push(root);

  mkdirSync(join(root, "Skills"));
  writeFileSync(join(root, ".plansignore"), rootRules);
  writeFileSync(join(root, "Skills", ".plansignore"), projectRules);
  return projectIgnore(root, "Skills");
}

test("ignores the store's own files and folders by default", () => {
  const ignore = ignoreWith("", "");
  for (const path of ["Skills/x.lock", "Skills/.DS_Store", "Skills/.resume-1", "Skills/plans.db"])
    expect(ignore.ignores(path, false)).toBe(true);

  expect(ignore.ignores("Skills/_archive", true)).toBe(true);
  expect(ignore.ignores("Skills/_archive", false)).toBe(false);
  expect(ignore.ignores("Skills/notes.md", false)).toBe(false);
});

test("scopes root rules to the plans directory and project rules to the project", () => {
  const ignore = ignoreWith("/Skills/\n", "/top.txt\n");

  expect(ignore.ignores("Skills", true)).toBe(true);
  expect(ignore.ignores("Skills/top.txt", false)).toBe(true);
  expect(ignore.ignores("Skills/deep/top.txt", false)).toBe(false);
});

test("takes negation, double stars, classes and escapes", () => {
  const ignore = ignoreWith("", "*.png\n!keep.png\nlogs/**\n[[:digit:]].txt\n\\#hash\nspace\\ \n");

  expect(ignore.ignores("Skills/a/b.png", false)).toBe(true);
  expect(ignore.ignores("Skills/a/keep.png", false)).toBe(false);
  expect(ignore.ignores("Skills/logs/a/b.txt", false)).toBe(true);

  expect(ignore.ignores("Skills/1.txt", false)).toBe(true);
  expect(ignore.ignores("Skills/a.txt", false)).toBe(false);
  expect(ignore.ignores("Skills/#hash", false)).toBe(true);
  expect(ignore.ignores("Skills/space ", false)).toBe(true);
});

test("reads every POSIX class gitignore names", () => {
  const ignore = ignoreWith("", "[[:print:]].txt\n[[:graph:]].md\n[[:cntrl:]].bin\n");

  expect(ignore.ignores("Skills/a.txt", false)).toBe(true);
  expect(ignore.ignores("Skills/ .md", false)).toBe(false);
  expect(ignore.ignores("Skills/b.md", false)).toBe(true);
  expect(ignore.ignores("Skills/\x01.bin", false)).toBe(true);
});

test("skips a pattern that does not compile instead of failing the walk", () => {
  const ignore = ignoreWith("", "[z-a].txt\n[[:nope:]].txt\n*.tmp\n");
  expect(ignore.ignores("Skills/b.txt", false)).toBe(false);
  expect(ignore.ignores("Skills/x.tmp", false)).toBe(true);
});
