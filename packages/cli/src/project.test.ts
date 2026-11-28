import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MACHINE_EVENT, TOOLS, type Facts } from "skills-core";
import { importStore } from "./plans/import.ts";
import { appendEvent, openStore, write } from "./plans/store.ts";
import { checkoutIs, detectProject, learnProject, pinOf, repoKey } from "./project.ts";
import { captureIo, fixtureGit, fixtureGitEnv } from "./test/fixtures.ts";
import { removeTemporary } from "./test/process.ts";

describe("repoKey", () => {
  test.each([
    ["git@example.com:Acme/Demo.git", "example.com/acme/demo"],
    ["ssh://git@example.com:22/acme/demo.git/", "example.com/acme/demo"],
    ["https://example.com/acme/demo", "example.com/acme/demo"],
    ["https://user:secret@Example.com/Acme/Demo.GIT?ref=x#top", "example.com/acme/demo"],
    ["git+ssh://example.com/acme/demo//", "example.com/acme/demo"],
    ["git@[2001:db8::1]:acme/demo.git", "[2001:db8::1]/acme/demo"],
    ["ssh://git@[2001:db8::1]:22/acme/demo.git", "[2001:db8::1]/acme/demo"],
    ["persistent-https::https://example.com/acme/demo", "example.com/acme/demo"],
  ])("%s gives %s", (url, key) => {
    expect(repoKey(url)).toBe(key);
  });

  test.each([
    "/tmp/origin.git",
    "../origin.git",
    "origin.git",
    "file:///tmp/origin.git",
    "FILE://host/origin.git",
    "https://example.com/",
  ])("%s gives no key", (url) => {
    expect(repoKey(url)).toBeUndefined();
  });
});

describe("pinOf", () => {
  test("each value reads as its last, newlines in a value kept", () => {
    const config = [
      "skills.project\nOld",
      "skills.repo\nexample.com/acme/old",
      "skills.project\nDemo\nArchive",
      "skills.repo\nexample.com/acme/demo",
      "",
    ].join("\0");

    expect(pinOf(config)).toEqual({ name: "Demo\nArchive", key: "example.com/acme/demo" });
  });

  test("a pin key with no pin is no pin, a pin with an empty key has none", () => {
    expect(pinOf("skills.repo\nexample.com/acme/demo\0")).toBeUndefined();
    expect(pinOf("skills.project\nDemo\0skills.repo\n\0")).toEqual({ name: "Demo" });
  });
});

describe("the remote rule", () => {
  let temporary: string;
  let plans: string;
  let repo: string;

  const io = () => captureIo({ ...fixtureGitEnv(), PLANS_DIR: plans });

  async function project(name: string): Promise<void> {
    await mkdir(join(plans, name), { recursive: true });
  }

  async function record(checkouts: Record<string, string>, machine?: string): Promise<void> {
    await importStore({ PLANS_DIR: plans });

    const store = openStore(join(plans, "plans.db"));
    try {
      const payload: Facts = {
        label: machine ?? "here",
        environment: null,
        os: { platform: "darwin", version: "27.2.0" },
        arch: "arm64",
        tools: Object.fromEntries(
          TOOLS.map((name) => [name, { version: "1.0.0" }]),
        ) as Facts["tools"],
        checkouts: Object.fromEntries(
          Object.entries(checkouts).map(([name, origin]) => [
            name,
            { path: join(temporary, name), origin },
          ]),
        ),
        captured: "2026-11-28T12:00:00.000Z",
      };

      const id = write(store, () =>
        appendEvent(store, {
          kind: "stored",
          type: MACHINE_EVENT,
          at: Date.now(),
          project: "-",
          plan: "-",
          payload,
        }),
      );

      if (machine) store.db.run("UPDATE events SET machine = ? WHERE id = ?", [machine, id]);
    } finally {
      store.db.close();
    }
  }

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), "skills-remote-"));
    plans = join(temporary, "plans");
    repo = join(temporary, "fresh");

    await mkdir(plans);
    await mkdir(repo);
    await fixtureGit(repo, ["init", "-q", "-b", "main"]);
    await fixtureGit(repo, ["remote", "add", "origin", "https://example.com/acme/demo"]);
  });

  afterEach(async () => {
    await removeTemporary(temporary);
  });

  test("an origin recorded only in another machine's facts resolves the checkout", async () => {
    await project("Demo");
    await record({ Demo: "git@example.com:Acme/Demo.git" }, "other-machine");

    expect(await detectProject(repo, plans, true, io())).toBe("Demo");
    expect(await checkoutIs(repo, "Demo", io())).toBeUndefined();
  });

  test("a learn point pins a checkout the remote rule resolved", async () => {
    await project("Demo");
    await record({ Demo: "git@example.com:Acme/Demo.git" }, "other-machine");

    expect(await learnProject(repo, plans, io())).toBe("Demo");
    expect(await fixtureGit(repo, ["config", "--local", "skills.project"])).toBe("Demo\n");
    expect(await fixtureGit(repo, ["config", "--local", "skills.repo"])).toBe(
      "example.com/acme/demo\n",
    );
  });

  test("a pin with no pin key keeps answering in a checkout that has a key", async () => {
    await project("Demo");
    await fixtureGit(repo, ["config", "--local", "skills.project", "Demo"]);

    expect(await detectProject(repo, plans, true, io())).toBe("Demo");
    expect(await checkoutIs(repo, "Demo", io())).toBeUndefined();

    expect(await learnProject(repo, plans, io())).toBe("Demo");
    expect(await fixtureGit(repo, ["config", "--local", "skills.project"])).toBe("Demo\n");
    expect(await fixtureGit(repo, ["config", "--local", "skills.repo"])).toBe(
      "example.com/acme/demo\n",
    );
  });

  test("a learn point rewrites a pin that no longer answers with the project another step resolved", async () => {
    await project("Demo");
    await project("Other");
    await record({ Other: "git@example.com:acme/demo.git" });
    await fixtureGit(repo, ["remote", "add", "fork", "https://example.com/acme/fork"]);

    await fixtureGit(repo, ["config", "--local", "skills.project", "Demo"]);
    await fixtureGit(repo, ["config", "--local", "skills.repo", "example.com/acme/gone"]);

    expect(await learnProject(repo, plans, io())).toBe("Other");
    expect(await fixtureGit(repo, ["config", "--local", "skills.project"])).toBe("Other\n");
    expect(await fixtureGit(repo, ["config", "--local", "skills.repo"])).toBe(
      "example.com/acme/demo\n",
    );

    expect(await detectProject(repo, plans, true, io())).toBe("Other");
  });

  test("a pin beside the key of another repository does not answer", async () => {
    await project("Demo");
    await fixtureGit(repo, ["config", "--local", "skills.project", "Demo"]);
    await fixtureGit(repo, ["config", "--local", "skills.repo", "example.com/acme/other"]);

    expect(await detectProject(repo, plans, true, io())).toBeUndefined();
    expect(await checkoutIs(repo, "Demo", io())).toBe(
      "this checkout is fresh, not a checkout of Demo",
    );

    expect(await learnProject(repo, plans, io())).toBeUndefined();
    expect(await fixtureGit(repo, ["config", "--local", "skills.repo"])).toBe(
      "example.com/acme/other\n",
    );

    await fixtureGit(repo, ["remote", "set-url", "origin", "git@example.com:Acme/Other.git"]);
    expect(await detectProject(repo, plans, true, io())).toBe("Demo");
  });

  test("a recorded project name matches its directory in any letter case", async () => {
    await project("Demo");
    await record({ demo: "git@example.com:Acme/Demo.git" });
    expect(await detectProject(repo, plans, true, io())).toBe("Demo");
  });

  test("only a machine's newest facts record its origins", async () => {
    await project("Demo");
    await record({ Demo: "git@example.com:Acme/Demo.git" });
    await record({ Demo: "git@example.com:acme/other.git" });

    expect(await detectProject(repo, plans, true, io())).toBeUndefined();
  });

  test("a checkout whose keys two project directories recorded gets no answer", async () => {
    await project("Demo");
    await project("Fork");
    await record({ Demo: "git@example.com:Acme/Demo.git" });
    await record({ Fork: "https://example.com/acme/demo.git" }, "other-machine");

    expect(await detectProject(repo, plans, true, io())).toBeUndefined();
  });

  test("a recorded origin naming a project with no directory is ignored", async () => {
    await project("Demo");
    await record({ Demo: "git@example.com:Acme/Demo.git", Gone: "git@example.com:acme/demo" });
    expect(await detectProject(repo, plans, true, io())).toBe("Demo");
  });

  test("a folder name that matches a project beats a recorded origin naming another", async () => {
    await project("Demo");
    await project("fresh");
    await record({ Demo: "git@example.com:Acme/Demo.git" });

    expect(await detectProject(repo, plans, true, io())).toBe("fresh");
    expect(await checkoutIs(repo, "Demo", io())).toBe(
      "this checkout is fresh, not a checkout of Demo",
    );
  });

  test("detection with no plans.db creates none", async () => {
    await project("Demo");
    const before = await readdir(plans);

    expect(await detectProject(repo, plans, true, io())).toBeUndefined();
    expect(await readdir(plans)).toEqual(before);
  });
});
