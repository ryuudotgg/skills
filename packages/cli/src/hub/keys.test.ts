import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPrivate, hex, parseId, randomId } from "skills-core";
import { keyStore, KeyStoreError, type DeviceKeys, type Enrollment } from "./keys.ts";
import { removeTemporary } from "../test/process.ts";

const STUB = `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const stdin = argv[0] === "-i" ? await Bun.stdin.text() : "";
appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv, stdin }) + "\\n");

const login = join(process.env.STUB_ITEMS, "login.keychain-db");
if (argv[0] === "login-keychain") {
  console.log('    "' + login + '"');
  process.exit(0);
}

const forced = process.env.STUB_EXIT;
if (forced) {
  console.error("security: stub failure");
  process.exit(Number(forced));
}

const words = argv[0] === "-i" ? stdin.trim().split(/\\s+/) : argv;
if (words.at(-1).replace(/^"(.*)"$/, "$1") !== login) {
  console.error("security: no keychain named");
  process.exit(50);
}

const flag = (name) => words[words.indexOf(name) + 1];
const item = join(process.env.STUB_ITEMS, flag("-s"), flag("-a").replace("/", "."));
mkdirSync(join(process.env.STUB_ITEMS, flag("-s")), { recursive: true });

if (words[0] === "add-generic-password") {
  if (existsSync(item)) {
    console.error("add-generic-password: returned -25299");
    process.exit(45);
  }

  writeFileSync(item, flag("-w"));
  process.exit(0);
}

if (!existsSync(item)) {
  console.error("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.");
  process.exit(44);
}

if (words[0] === "find-generic-password") console.log(readFileSync(item, "utf8"));
if (words[0] === "delete-generic-password") rmSync(item);
`;

type Call = { argv: string[]; stdin: string };

function encodings(keys: DeviceKeys): string[] {
  return [keys.sign, keys.wrap].flatMap((key) => {
    const pkcs8 = exportPrivate(key);
    const buffer = Buffer.from(pkcs8);
    return [
      buffer.toString("latin1"),
      buffer.toString("base64"),
      buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
      hex(pkcs8),
    ];
  });
}

function same(enrollment: Enrollment, keys: DeviceKeys): boolean {
  if (enrollment === "not enrolled") return false;

  return (
    hex(exportPrivate(enrollment.sign)) === hex(exportPrivate(keys.sign)) &&
    hex(exportPrivate(enrollment.wrap)) === hex(exportPrivate(keys.wrap))
  );
}

describe("keychain", () => {
  let temporary: string;
  let env: NodeJS.ProcessEnv;
  const made: DeviceKeys[] = [];

  beforeAll(() => {
    temporary = mkdtempSync(join(tmpdir(), "skills-hub-keys-"));

    const bin = join(temporary, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "security"), STUB, { mode: 0o755 });

    env = {
      HOME: join(temporary, "home"),
      PATH: `${bin}:/usr/bin:/bin`,
      STUB_LOG: join(temporary, "calls.jsonl"),
      STUB_ITEMS: join(temporary, "items"),
    };
  });

  afterAll(async () => {
    const calls = readFileSync(env.STUB_LOG ?? "", "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Call);

    const secrets = made.flatMap(encodings);
    for (const call of calls)
      for (const argument of call.argv)
        for (const secret of secrets) expect(argument).not.toContain(secret);

    await removeTemporary(temporary);
  });

  function calls(): Call[] {
    if (!existsSync(env.STUB_LOG ?? "")) return [];

    return readFileSync(env.STUB_LOG ?? "", "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Call)
      .filter((call) => call.argv[0] !== "login-keychain");
  }

  const login = () => join(env.STUB_ITEMS ?? "", "login.keychain-db");

  test("macOS without HUB_KEYS adds each key on the stdin of security -i", async () => {
    const device = randomId();
    const before = calls().length;

    const keys = await keyStore(env, "darwin").create(device);
    made.push(keys);

    const adds = calls().slice(before);
    expect(adds.map((call) => call.argv)).toEqual([["-i"], ["-i"]]);
    expect(adds.map((call) => call.stdin)).toEqual([
      `add-generic-password -s skills-hub -a ${device}/sign -w ${hex(exportPrivate(keys.sign))} "${login()}"\n`,
      `add-generic-password -s skills-hub -a ${device}/wrap -w ${hex(exportPrivate(keys.wrap))} "${login()}"\n`,
    ]);
  });

  test("a find-generic-password -w answer round trips the key, read once per process", async () => {
    const device = randomId();
    const keys = await keyStore(env, "darwin").create(device);
    made.push(keys);

    const before = calls().length;
    expect(same(await keyStore(env, "darwin").read(device), keys)).toBe(true);

    const finds = calls().slice(before);
    expect(finds.map((call) => call.argv).sort()).toEqual([
      ["find-generic-password", "-s", "skills-hub", "-a", `${device}/sign`, "-w", login()],
      ["find-generic-password", "-s", "skills-hub", "-a", `${device}/wrap`, "-w", login()],
    ]);

    expect(same(await keyStore(env, "darwin").read(device), keys)).toBe(true);
    expect(calls().length).toBe(before + 2);
  });

  test("reads at once share one lookup", async () => {
    const device = randomId();
    const store = keyStore(env, "darwin");
    const keys = await store.create(device);
    made.push(keys);

    const before = calls().length;
    const [left, right] = await Promise.all([store.read(device), store.read(device)]);
    expect(same(left, keys) && same(right, keys)).toBe(true);
    expect(calls().length).toBe(before + 2);
  });

  test("a read started before a delete does not bring the keys back", async () => {
    const device = randomId();
    const store = keyStore(env, "darwin");
    made.push(await store.create(device));

    const reading = store.read(device);
    await store.delete(device);
    await reading.catch(() => "the stub raced its own delete");

    expect(await store.read(device)).toBe("not enrolled");
  });

  test("exit 44 reads as not enrolled", async () => {
    expect(await keyStore(env, "darwin").read(randomId())).toBe("not enrolled");
    expect(await keyStore({ ...env, STUB_EXIT: "44" }, "darwin").read(randomId())).toBe(
      "not enrolled",
    );
  });

  test("any other exit is an error naming security", async () => {
    const locked = keyStore({ ...env, STUB_EXIT: "36" }, "darwin");

    await expect(locked.read(randomId())).rejects.toThrow(
      new KeyStoreError(
        "security find-generic-password failed with exit 36: security: stub failure",
      ),
    );

    await expect(locked.create(randomId())).rejects.toThrow(
      /^security add-generic-password failed with exit 36/,
    );

    await expect(locked.delete(randomId())).rejects.toThrow(
      /^security delete-generic-password failed with exit 36/,
    );
  });

  test("a second create refuses and leaves the first keys in place", async () => {
    const device = randomId();
    const store = keyStore(env, "darwin");
    const keys = await store.create(device);
    made.push(keys);

    await expect(store.create(device)).rejects.toThrow(new KeyStoreError("device keys exist"));
    expect(same(await store.read(device), keys)).toBe(true);
  });

  test("delete removes both items and the cached read", async () => {
    const device = randomId();
    const store = keyStore(env, "darwin");
    made.push(await store.create(device));
    await store.read(device);

    await store.delete(device);

    expect(await store.read(device)).toBe("not enrolled");
    await store.delete(device);
  });
});

describe("files", () => {
  const live =
    process.env.HUB_KEYS === "file" && /^\/tmp\/plans-\d+\//.test(process.env.HOME ?? "");

  const first = parseId("23000000000000000000000000000001");
  const second = parseId("23000000000000000000000000000002");

  let temporary: string;
  let home: string;

  const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

  beforeAll(() => {
    temporary = mkdtempSync(join(tmpdir(), "skills-hub-files-"));
    home = live ? (process.env.HOME ?? "") : temporary;
  });

  afterAll(async () => {
    await removeTemporary(temporary);
  });

  test("HUB_KEYS=file keeps each device in a 0700 directory of 0600 keys", async () => {
    const store = keyStore({ HUB_KEYS: "file", HOME: home, PATH: "/nonexistent" }, "darwin");
    const hub = join(home, ".agents", "hub");
    await store.delete(first);
    await store.delete(second);

    const keys = await store.create(first);
    expect(mode(join(hub, first))).toBe("700");
    expect(mode(join(hub, first, "sign.key"))).toBe("600");
    expect(mode(join(hub, first, "wrap.key"))).toBe("600");
    expect(same(await store.read(first), keys)).toBe(true);

    await expect(store.create(first)).rejects.toThrow(new KeyStoreError("device keys exist"));
    const kept = readFileSync(join(hub, first, "sign.key"));
    await store.create(second);
    expect(readFileSync(join(hub, first, "sign.key"))).toEqual(kept);

    await store.delete(second);
    expect(existsSync(join(hub, second))).toBe(false);
    expect(readdirSync(join(hub, first)).sort()).toEqual(["sign.key", "wrap.key"]);
    expect(same(await store.read(first), keys)).toBe(true);
  });

  test("other platforms use files without HUB_KEYS", async () => {
    const root = mkdtempSync(join(temporary, "linux-"));
    const device = randomId();
    await keyStore({ HOME: root }, "linux").create(device);

    expect(readdirSync(join(root, ".agents", "hub", device)).sort()).toEqual([
      "sign.key",
      "wrap.key",
    ]);

    expect(await keyStore({ HOME: root }, "linux").read(randomId())).toBe("not enrolled");
  });

  test("a key file open to other users is not read", async () => {
    const root = mkdtempSync(join(temporary, "loose-"));
    const device = randomId();
    await keyStore({ HOME: root }, "linux").create(device);
    chmodSync(join(root, ".agents", "hub", device, "wrap.key"), 0o644);

    await expect(keyStore({ HOME: root }, "linux").read(device)).rejects.toThrow(
      /wrap\.key is open to other users/,
    );
  });

  test("a device directory open to other users is not used", async () => {
    const root = mkdtempSync(join(temporary, "open-"));
    const device = randomId();
    await keyStore({ HOME: root }, "linux").create(device);
    chmodSync(join(root, ".agents", "hub", device), 0o755);

    await expect(keyStore({ HOME: root }, "linux").read(device)).rejects.toThrow(
      /is not a private directory of this user/,
    );

    await expect(keyStore({ HOME: root }, "linux").create(device)).rejects.toThrow(
      /is not a private directory of this user/,
    );
  });

  test("HUB_KEYS takes file only", () => {
    expect(() => keyStore({ HUB_KEYS: "keychain", HOME: home }, "darwin")).toThrow(
      new KeyStoreError("HUB_KEYS takes file, not keychain"),
    );
  });
});
