import { expect, test } from "bun:test";
import {
  parseAdvertisement,
  pickCandidate,
  readRelease,
  trustedOrigin,
  verifiedCommit,
} from "./release.ts";

const a = "a".repeat(40);
const b = "b".repeat(40);
const c = "c".repeat(40);

test("trusts only ryuudotgg/skills on github.com", () => {
  for (const url of [
    "https://github.com/ryuudotgg/skills",
    "https://github.com/ryuudotgg/skills.git",
    "https://github.com/ryuudotgg/skills/",
    "https://github.com/Ryuudotgg/Skills.git",
    "git@github.com:ryuudotgg/skills.git",
    "ssh://git@github.com/ryuudotgg/skills",
  ])
    expect(trustedOrigin(url), url).toBe(true);

  for (const url of [
    "https://github.com/someone/skills.git",
    "https://github.com/ryuudotgg/skills-fork.git",
    "https://github.com.evil.example/ryuudotgg/skills.git",
    "https://gitlab.com/ryuudotgg/skills.git",
    "http://github.com/ryuudotgg/skills.git",
    "/tmp/skills.git",
  ])
    expect(trustedOrigin(url), url).toBe(false);
});

test("reads the default branch and release tags, peeled commits first", () => {
  const advertised = parseAdvertisement(
    [
      "ref: refs/heads/main\tHEAD",
      `${a}\tHEAD`,
      `${a}\trefs/tags/v1.0.0`,
      `${b}\trefs/tags/v1.1.0`,
      `${c}\trefs/tags/v1.1.0^{}`,
      `${c}\trefs/tags/v1.2.0-rc.1`,
      `${c}\trefs/tags/vnext`,
      "",
    ].join("\n"),
  );

  expect(advertised).toEqual({
    defaultBranch: "main",
    tags: [
      { tag: "v1.0.0", version: "1.0.0", sha: a },
      { tag: "v1.1.0", version: "1.1.0", sha: c },
    ],
  });

  expect(parseAdvertisement(`${a}\trefs/tags/v1.0.0\n`)).toBeUndefined();
});

test("picks the highest version above the current one", () => {
  const tags = [
    { tag: "v1.0.0", version: "1.0.0", sha: a },
    { tag: "v1.10.0", version: "1.10.0", sha: b },
    { tag: "v1.9.0", version: "1.9.0", sha: c },
  ];

  expect(pickCandidate(tags, "1.0.0")?.tag).toBe("v1.10.0");
  expect(pickCandidate(tags, "1.10.0")).toBeUndefined();
});

test("a release must be published and match its tag", () => {
  const tag = { tag: "v1.1.0", version: "1.1.0", sha: a };
  const body = {
    tag_name: "v1.1.0",
    draft: false,
    prerelease: false,
    published_at: "2026-10-30T00:00:00Z",
    html_url: "https://github.com/ryuudotgg/skills/releases/tag/v1.1.0",
  };

  expect(readRelease(tag, JSON.stringify(body))).toEqual({ ...tag, url: body.html_url });
  expect(readRelease(tag, JSON.stringify({ ...body, tag_name: "v1.0.0" }))).toEqual({
    reason: "v1.1.0 has no release",
  });

  expect(readRelease(tag, JSON.stringify({ ...body, published_at: null }))).toEqual({
    reason: "v1.1.0 release is not published",
  });

  expect(readRelease(tag, "not json")).toEqual({ reason: "v1.1.0 has no release" });
});

test("a commit is verified only when GitHub says so for that sha", () => {
  const body = (sha: string, verified: unknown) =>
    JSON.stringify({ sha, commit: { verification: { verified } } });

  expect(verifiedCommit(a, body(a, true))).toBe(true);
  expect(verifiedCommit(a, body(b, true))).toBe(false);
  expect(verifiedCommit(a, body(a, "true"))).toBe(false);
  expect(verifiedCommit(a, JSON.stringify({ sha: a, verification: { verified: true } }))).toBe(
    false,
  );
});
