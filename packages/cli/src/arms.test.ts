import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultRoster,
  parseRoster,
  readArms,
  readOpencodeCatalog,
  rosterFrom,
  rewriteRoster,
  serializeRoster,
  validateRoster,
} from "./arms.ts";
import { readDeliveryConfig } from "./delivery.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "./test/process.ts";

let temporary: string;
let conf: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "skills-arms-"));
  conf = join(temporary, "skills.conf");
  env = { ...suiteEnvironment(), HOME: temporary, SKILLS_CONF: conf, PATH: "/usr/bin:/bin" };
});

afterEach(async () => {
  await removeTemporary(temporary);
});

function stubOpencode(body: string): void {
  const bin = join(temporary, "bin");
  mkdirSync(bin);
  const path = join(bin, "opencode");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);

  env.PATH = `${bin}:/usr/bin:/bin`;
}

async function arms() {
  return runCommand([process.execPath, resolve(import.meta.dir, "cli.ts"), "arms"], {
    cwd: temporary,
    env,
  });
}

test("no config resolves to Claude and Codex", () => {
  expect(rosterFrom(readDeliveryConfig(env))).toEqual({
    roster: defaultRoster,
    saved: false,
    notes: [],
  });
});

test("skills arms without a conf prints the default families and CLI availability", async () => {
  const result = await arms();
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("claude cli=no\ncodex cli=no\nimplementation=lead\n");
  expect(result.stderr).toBe("");
});

test("saved roster parses CRLF and serializes families and tiers in canonical order", () => {
  writeFileSync(
    conf,
    "ARMS_ROSTER=opencode codex claude astra=vendor/big#max sol=vendor/main#high luna=vendor/small terra=vendor/mid\r\n",
  );

  const result = rosterFrom(readDeliveryConfig(env));
  expect(result.saved).toBe(true);
  expect(result.notes).toEqual([]);
  expect(serializeRoster(result.roster)).toBe(
    "claude codex opencode luna=vendor/small terra=vendor/mid sol=vendor/main#high astra=vendor/big#max",
  );
});

test("model ids split on the first slash and last hash without restricting catalog names", () => {
  const { roster, notes } = parseRoster("opencode sol=vendor/model/path@1:tag#part#effort=high");
  expect(notes).toEqual([]);
  expect(roster.opencode.sol).toEqual({
    model: "vendor/model/path@1:tag#part",
    variant: "effort=high",
  });

  expect(() =>
    validateRoster(roster, [{ model: "vendor/model/path@1:tag#part", variants: ["effort=high"] }]),
  ).not.toThrow();
});

test("a malformed line elsewhere in the conf leaves the saved roster in force", async () => {
  writeFileSync(conf, "WITH=Greptile\nARMS_ROSTER=claude\n");

  const result = await arms();
  expect(result.stdout).toBe("claude cli=no\nimplementation=lead\n");
  expect(result.stderr).toContain("malformed");
});

test("bad and repeated tokens skip only the token and repeated keys use the first row", () => {
  writeFileSync(
    conf,
    "ARMS_ROSTER=claude claude unknown opencode sol=vendor/main#high sol=vendor/other bad=vendor/no luna=bad\nARMS_ROSTER=codex\n",
  );

  const result = rosterFrom(readDeliveryConfig(env));
  expect(serializeRoster(result.roster)).toBe("claude opencode sol=vendor/main#high");
  expect(result.notes).toEqual([
    `${conf}: ARMS_ROSTER is set more than once, first row wins`,
    `${conf}: claude is repeated, skipped`,
    `${conf}: unknown is not an arm family or tier model, skipped`,
    `${conf}: sol is repeated, skipped`,
    `${conf}: bad=vendor/no is not an arm family or tier model, skipped`,
    `${conf}: luna=bad is not an arm family or tier model, skipped`,
  ]);
});

test.each(["/model", "provider/", "provider/model#", "provider/model=other"])(
  "malformed model %s does not discard another family",
  (model) => {
    const result = parseRoster(`claude opencode sol=${model}`);
    expect(result.roster).toEqual({ families: ["claude"], opencode: {} });
    expect(result.notes).toHaveLength(2);
    expect(result.notes[1]).toBe("opencode requires a sol model, skipped");
  },
);

test("tier tokens without OpenCode are noted and skipped", () => {
  expect(parseRoster("codex sol=vendor/main")).toEqual({
    roster: { families: ["codex"], opencode: {} },
    notes: ["sol requires opencode, skipped"],
  });
});

test("astra alone cannot supply the required OpenCode sol tier", () => {
  expect(parseRoster("opencode astra=vendor/big")).toEqual({
    roster: { families: [], opencode: {} },
    notes: ["opencode requires a sol model, skipped", "no arm families selected"],
  });
});

test.each(["", "unknown", "opencode", "sol=vendor/main"])(
  "empty saved roster %j never falls back to the defaults",
  async (value) => {
    writeFileSync(conf, `ARMS_ROSTER=${value}\n`);
    const result = await arms();

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("implementation=lead\n");
    expect(result.stderr).toContain("arms: ");
    expect(result.stderr).toContain("no arm families selected");
  },
);

test("an implementation family without a roster row reads against the default roster", async () => {
  writeFileSync(conf, "ARMS_IMPLEMENTATION=codex\n");

  const result = await arms();
  expect(result.stdout).toBe("claude cli=no\ncodex cli=no\nimplementation=codex\n");
  expect(result.stderr).toBe("");
});

test("an OpenCode implementation family prints after the roster lines", async () => {
  writeFileSync(
    conf,
    "ARMS_ROSTER=claude opencode sol=vendor/main#high\nARMS_IMPLEMENTATION=opencode\n",
  );

  const result = await arms();
  expect(result.stdout).toBe(
    "claude cli=no\nopencode cli=no sol=vendor/main#high\nimplementation=opencode\n",
  );
});

test.each([
  ["ARMS_IMPLEMENTATION=claude\n", "claude is not lead, codex or opencode"],
  ["ARMS_IMPLEMENTATION=\n", "an empty value is not lead, codex or opencode"],
  ["ARMS_ROSTER=claude codex\nARMS_IMPLEMENTATION=opencode\n", "opencode is not in the roster"],
])(
  "an implementation value the roster cannot take leaves the lead writing: %j",
  (content, note) => {
    writeFileSync(conf, content);

    const result = readArms(env);
    expect(result.implementation).toBe("lead");
    expect(result.notes).toEqual([`${conf}: ${note}, the lead writes the code`]);
  },
);

test("a repeated implementation key keeps its first row", () => {
  writeFileSync(conf, "ARMS_IMPLEMENTATION=codex\nARMS_IMPLEMENTATION=lead\n");

  expect(readArms(env)).toEqual({
    roster: defaultRoster,
    implementation: "codex",
    notes: [`${conf}: ARMS_IMPLEMENTATION is set more than once, first row wins`],
  });
});

test("rewrite keeps unrelated content and collapses repeated roster rows", () => {
  const content = "# keep\nARMS_ROSTER=opencode sol=vendor/main\nWITH=\nARMS_ROSTER=codex\n";
  const rewritten = rewriteRoster(content, defaultRoster);
  expect(rewritten).toBe("# keep\nARMS_ROSTER=claude codex\nWITH=\n");
  expect(rewriteRoster(rewritten, defaultRoster)).toBe(rewritten);
  expect(rewriteRoster("# keep\nWITH=\n", defaultRoster)).toBe("# keep\nWITH=\n");
});

test("catalog uses models membership and model.list variants, not extra API models", async () => {
  stubOpencode(`case "$*" in
models) printf 'vendor/model/path@1:tag#part\\nother/plain\\n' ;;
'api model.list') printf '%s\\n' '{"data":[{"providerID":"vendor","id":"model/path@1:tag#part","variants":[{"id":"effort=high"}]},{"providerID":"extra","id":"absent","variants":[]}]}' ;;
*) exit 1 ;;
esac`);

  expect(await readOpencodeCatalog(env)).toEqual([
    { model: "vendor/model/path@1:tag#part", variants: ["effort=high"] },
    { model: "other/plain", variants: [] },
  ]);
});

test.each([
  ["exit 1", "opencode models failed"],
  [
    'if [ "$1" = models ]; then echo vendor/model; else exit 2; fi',
    "opencode api model.list failed",
  ],
  ["echo vendor/model", "opencode api model.list returned invalid JSON"],
  ['if [ "$1" = models ]; then echo vendor/model; else echo "{}"; fi', "no data array"],
  [
    'if [ "$1" = models ]; then echo vendor/model; else echo \'{"data":[{}]}\'; fi',
    "invalid model",
  ],
  [
    'if [ "$1" = models ]; then exit 0; else echo \'{"data":[]}\'; fi',
    "opencode models returned no models",
  ],
])("catalog failures name the failed command: %s", async (body, error) => {
  stubOpencode(body);
  await expect(readOpencodeCatalog(env)).rejects.toThrow(error);
});

test("catalog refuses a missing OpenCode executable", async () => {
  await expect(readOpencodeCatalog(env)).rejects.toThrow("opencode is not on PATH");
});

test("validation rejects missing models and unknown variants", () => {
  const catalog = [{ model: "vendor/main", variants: ["high"] }];
  expect(() => validateRoster(parseRoster("opencode sol=vendor/missing").roster, catalog)).toThrow(
    "model vendor/missing is not in the catalog",
  );

  expect(() => validateRoster(parseRoster("opencode sol=vendor/main#low").roster, catalog)).toThrow(
    "variant vendor/main#low is not in the catalog",
  );

  expect(() =>
    validateRoster(parseRoster("opencode sol=vendor/main#high").roster, catalog),
  ).not.toThrow();
});
