import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTemporary } from "../test/process.ts";
import { gitleaks, translate } from "./gitleaks.ts";
import { envSecrets, redact } from "./redact.ts";

const fixture = join(import.meta.dir, "fixture");

const secretKinds = [
  "aws-access-key",
  "aws-secret",
  "github-pat",
  "github-oauth",
  "github-fine-grained",
  "openai",
  "anthropic",
  "slack",
  "pem-block",
  "jwt",
  "url-userinfo",
  "bearer",
  "env",
  "entropy",
];

const lookalikeKinds = [
  "git-sha",
  "sha256",
  "uuid",
  "path",
  "url",
  "integrity-hash",
  "env-example-short",
  "marker",
  "json-key",
];

function corpus(name: string): string[][] {
  return readFileSync(join(fixture, name), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => line.split("\t"));
}

const secrets = corpus("secrets.txt");
const lookalikes = corpus("lookalikes.txt");
const envValue = secrets.find(([kind]) => kind === "env")![2]!;

describe("the corpus", () => {
  test("secrets.txt holds exactly the 14 secret kinds", () => {
    expect([...new Set(secrets.map(([kind]) => kind))].sort()).toEqual([...secretKinds].sort());
  });

  test("lookalikes.txt holds exactly the 9 look alike kinds", () => {
    expect([...new Set(lookalikes.map(([kind]) => kind))].sort()).toEqual(
      [...lookalikeKinds].sort(),
    );
  });

  test.each(secrets)("%s is redacted", (_kind, text, planted) => {
    const out = redact(text!, [envValue]);
    expect(out).toContain("[redacted:");
    expect(out).not.toContain(planted!);
  });

  test.each(lookalikes)("%s comes back byte identical", (_kind, text) => {
    expect(redact(text!, [envValue])).toBe(text!);
  });
});

describe("the vendored rule set", () => {
  test("every rule and allowlist compiles", () => {
    const set = gitleaks();
    expect(set.untranslated).toEqual([]);
    expect(set.rules.length).toBeGreaterThan(200);
  });

  test("Go syntax translates to JavaScript", () => {
    expect(translate("(?i)ab(?-i:C)|d")).toBe("(?i:ab(?-i:C))|(?i:d)");
    expect(translate("(?P<name>x)\\z")).toBe("(?<name>x)$");
    expect(translate("[[:alnum:]_]")).toBe("[a-zA-Z0-9_]");
    expect(() => translate("\\p{Greek}")).toThrow();
  });
});

describe("redact", () => {
  test("a line with no match is returned byte identical", () => {
    const line = '{"b": 1,  "a": "plain text"}\r';
    expect(redact(`${line}\n${line}`, [])).toBe(`${line}\n${line}`);
  });

  test("keys stay and only string values change", () => {
    const value = "ghp_" + "Ab3dE5gH7jK9mN1pQ3sT5vX7zB9dF1hJ3lN5";
    const out = JSON.parse(redact(JSON.stringify({ [value]: value, n: 2 }), []));
    expect(out).toEqual({ [value]: "[redacted:github-pat]", n: 2 });
  });

  test("the claude fixture keeps its shape and is idempotent", () => {
    const text = readFileSync(
      join(
        fixture,
        "home/.claude/projects/-tmp-sessions-fixture-checkout-Alpha/claude-fixture.jsonl",
      ),
      "utf8",
    );

    const once = redact(text, []);

    expect(redact(once, [])).toBe(once);
    expect(once.split("\n").length).toBe(text.split("\n").length);
    expect(once.match(/redacted:/gu)!.length).toBeGreaterThanOrEqual(14);

    for (const line of once.split("\n").filter(Boolean))
      expect(() => JSON.parse(line)).not.toThrow();
  });

  test("short secrets are ignored", () => {
    expect(redact("token abc1234", ["abc1234"])).toBe("token abc1234");
  });

  test("a redacted line keeps every byte outside the replaced strings", () => {
    const line =
      '{"2":1, "1": "ghp_Ab3dE5gH7jK9mN1pQ3sT5vX7zB9dF1hJ3lN5", "n": 12345678901234567890}';

    expect(redact(line, [])).toBe(
      '{"2":1, "1": "[redacted:github-pat]", "n": 12345678901234567890}',
    );
  });

  test("a JSON value is scanned with its key", () => {
    const out = redact('{"input":{"api_key":"Zk8pQ2vR7tY4wB9nM3xC"}}', []);
    expect(out).toBe('{"input":{"api_key":"[redacted:generic-api-key]"}}');
  });

  test("rules whose groups are fragments replace the whole match", () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const url = `https://abc.webhook.office.com/webhookb2/${id}@${id}/IncomingWebhook/${"0123456789abcdef".repeat(2)}/${id}`;
    expect(redact(`posted to ${url}`, [])).toBe("posted to [redacted:microsoft-teams-webhook]");
  });

  test("a flag inside one alternative does not swallow the next", () => {
    const out = redact("curl -H 'Authorization: Bearer Zk8pQ2vR7tY4wB9nM3xC6' https://x.test", []);
    expect(out).toBe("curl -H 'Authorization: Bearer [redacted:curl-auth-header]' https://x.test");
  });

  test("a multi line PEM in raw text is redacted line for line", () => {
    const body = Array.from({ length: 3 }, (_, n) => `${"Qm9vZ3Vz".repeat(8)}${n}`);
    const pem = ["-----BEGIN PRIVATE KEY-----", ...body, "-----END PRIVATE KEY-----"].join("\n");
    const out = redact(`before\n${pem}\nafter`, []);

    expect(out.split("\n")).toHaveLength(7);
    expect(out).not.toContain(body[0]!);
  });

  test("key names count only as whole identifier parts", () => {
    const text =
      "monkey Zk8pQ2vR7tY4wB9nM3xC6 keyboard Zk8pQ2vR7tY4wB9nM3xC6 getAuthorizationHeaderFromRequest";

    expect(redact(text, [])).toBe(text);
  });

  test("a four megabyte base64 image redacts in under two seconds", () => {
    const data = Buffer.from(crypto.getRandomValues(new Uint8Array(65536)))
      .toString("base64")
      .repeat(46);

    const line = JSON.stringify({ message: { content: [{ type: "image", source: { data } }] } });
    const started = performance.now();

    expect(redact(line, [])).toBe(line);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("a secret around an existing marker is still redacted", () => {
    expect(redact("https://user:prefix[redacted:env]suffix@host.test", [])).toBe(
      "https://user:[redacted:url-userinfo][redacted:env][redacted:url-userinfo]@host.test",
    );
  });

  test("entropy names match in any case and up to 48 characters ahead", () => {
    const token = "G7mP2zQ9vX4kL8nD1wR6cY3b";
    for (const text of [`cOoKiE=${token}`, `cookie is ${token}`, `cookie: value ${token}`])
      expect(redact(text, [])).not.toContain(token);
  });

  test("entropy skips names and words with no digit", () => {
    const text = "keyName=customer-orders-primary credentialHelper=git-credential-manager-core";
    expect(redact(text, [])).toBe(text);
  });

  test("an escaped JSON key keeps its context", () => {
    const line = '{"coo\\u006bie":"G7mP2zQ9vX4kL8nD1wR6cY3b"}';
    expect(redact(line, [])).toBe('{"coo\\u006bie":"[redacted:entropy]"}');
  });

  test("keywords anywhere on a JSON line enable a rule for its values", () => {
    const pat = `pat${"A1b2C3d4E5f6G7h".slice(0, 14)}.${"0123456789abcdef".repeat(4)}`;
    const line = JSON.stringify({ provider: "airtable", value: pat });
    expect(redact(line, [])).not.toContain(pat);
  });

  test("text full of curl with no auth flag stays fast", () => {
    const started = performance.now();
    redact("curl ".repeat(20000), []);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test("many repeated env values redact in linear time", () => {
    const value = "envvalue-0123456789";
    const started = performance.now();

    redact(`${value} `.repeat(100000), [value]);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("JSON lines with thousands of strings stay linear", () => {
    const filenames = Array.from({ length: 4000 }, (_, n) => `/repo/src/module-${n}/index.ts`);
    const line = JSON.stringify({ toolUseResult: { filenames } });
    const started = performance.now();

    expect(redact(line, [])).toBe(line);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("curl with an auth flag far from many curls stays fast", () => {
    const started = performance.now();
    redact(`${"curl ".repeat(100000)} -u`, []);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test("text after a marker whose label names a key word is left alone", () => {
    const text = "[redacted:generic-api-key] run --model claude-opus-4-5-20251101";
    expect(redact(text, [])).toBe(text);
  });

  test("paths, model ids and versions near key names are left alone", () => {
    const texts = [
      "the auth middleware lives in packages/cli/src/hub/oauth2/client.ts",
      "token budget for claude-sonnet-4-20250514 is fine",
      "key file at src/components/AuthProviderWrapper2.tsx",
    ];

    for (const text of texts) expect(redact(text, [])).toBe(text);
  });

  test("letters only tokens and tokens starting with a slash are still caught", () => {
    for (const token of ["xFugAQKklDnyjSWUuAqFrWKhcZ", "/aB3dE5gH7jK9mN1pQ3sT5vX7z"])
      expect(redact(`api_token=${token}`, [])).not.toContain(token);
  });

  test("URL passwords with an empty user or an @ inside are redacted whole", () => {
    expect(redact("redis-cli -u redis://:Zx9pQ2wE7rT4yU1i@cache:6379", [])).toBe(
      "redis-cli -u redis://:[redacted:url-userinfo]@cache:6379",
    );

    expect(redact("mysql://root:p@ssW0rd!2024@db/app", [])).toBe(
      "mysql://root:[redacted:url-userinfo]@db/app",
    );
  });

  test("CRLF inside a multi line secret keeps its line endings", () => {
    const body = `${"Qm9vZ3Vz".repeat(8)}0`;
    const pem = `-----BEGIN PRIVATE KEY-----\r\n${body}\r\n-----END PRIVATE KEY-----`;
    const out = redact(`x\r\n${pem}\r\ny`, []);

    expect(out.split("\r\n")).toHaveLength(5);
  });

  test("env values match only on word boundaries", () => {
    expect(redact("databases", ["database"])).toBe("databases");
  });

  test("an escaped provider token in JSON is redacted", () => {
    const line = '{"content":"gh\\u0070_HjIoKA31k9Um2sUfxUWK8GPuHIsSb8QiXVdF"}';
    expect(redact(line, [])).toBe('{"content":"[redacted:github-pat]"}');
  });

  test("many curl flags in one command stay linear", () => {
    const started = performance.now();
    redact(`curl${" -H x".repeat(50000)}`, []);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test("a quoted curl password containing a flag is redacted whole", () => {
    const out = redact("curl -u 'admin:Xk9#mQ2 -u vP7zR4wL' https://x.test", []);
    expect(out).toBe("curl -u [redacted:curl-auth-user] https://x.test");
  });

  test("every curl header is checked, not just the first", () => {
    const token = "redact-4f2dff4a8ba7";
    const text = `curl -H "Authorization: Bearer xxxxxxxx" -H "Authorization: Bearer ${token}" https://x.test`;
    expect(redact(text, [])).not.toContain(token);
  });
});

describe("envSecrets", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "skills-redact-"));
  });

  afterEach(async () => {
    await removeTemporary(directory);
  });

  test("reads .env and .env.* values of eight or more characters, quotes stripped", async () => {
    await writeFile(join(directory, ".env"), "TOKEN=fixture-value-0123456789abcdef\nPORT=3000\n");
    await writeFile(
      join(directory, ".env.local"),
      "export NAME='quoted value here'\n# A=commented\n",
    );

    await writeFile(join(directory, "env.txt"), "IGNORED=not-an-env-file-value\n");
    await writeFile(join(directory, ".env.example"), "TOKEN=placeholder-0123456789\n");
    await writeFile(
      join(directory, ".env.development"),
      [
        "NODE_ENV=development",
        "PORT=30000000",
        "API=http://localhost:3000/v1",
        "WIN_SECRET=crlf-value-0123456789\r",
        'QUOTED_TOKEN="quoted-0123456789" # staging',
        'ESCAPED_KEY="a\\"b-0123456789"',
        "NEXTAUTH_URL=http://localhost:3000",
        "SESSION_DRIVER=database",
        "AWS_REGION=us-east-1",
        "DB_HOST=127.0.0.1",
        "TOKEN_TTL_MS=86400000",
        "APP_ROOT=/Users/me/work/app",
        "DB_PASSWORD=5839201746",
        "HOST_PASSWORD=correctHorse",
        "API_KEY_FILE=keys/production.pem",
        "ADMIN_PASSWORD=/slash-led-pass",
        "PASSWORD=QmZtRkYpWvNxHsJcLdFg",
        "OTHER=client-id:abcdef0123456789",
        "",
      ].join("\n"),
    );

    expect(envSecrets([directory, join(directory, "missing")]).sort()).toEqual([
      "/slash-led-pass",
      "5839201746",
      "QmZtRkYpWvNxHsJcLdFg",
      'a"b-0123456789',
      "client-id:abcdef0123456789",
      "correctHorse",
      "crlf-value-0123456789",
      "fixture-value-0123456789abcdef",
      "quoted value here",
      "quoted-0123456789",
    ]);
  });

  test("redacts every occurrence of an env value as env", async () => {
    await writeFile(join(directory, ".env"), "TOKEN=fixture-value-0123456789abcdef\n");
    const value = "fixture-value-0123456789abcdef";
    const text = `https://x.test/?t=${value} {"k":"${value}"} curl -H ${value}`;

    expect(redact(text, envSecrets([directory]))).toBe(
      'https://x.test/?t=[redacted:env] {"k":"[redacted:env]"} curl -H [redacted:env]',
    );
  });
});
