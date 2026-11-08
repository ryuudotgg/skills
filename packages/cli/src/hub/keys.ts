import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  exportPrivate,
  fromHex,
  hex,
  importSigning,
  importWrapping,
  signingKeys,
  wrappingKeys,
  type Bytes,
  type Id,
  type SigningKeys,
  type WrappingKeys,
} from "skills-core";

export type DeviceKeys = { readonly sign: SigningKeys; readonly wrap: WrappingKeys };

export type Enrollment = DeviceKeys | "not enrolled";

export type KeyStore = {
  readonly create: (device: Id) => Promise<DeviceKeys>;
  readonly read: (device: Id) => Promise<Enrollment>;
  readonly delete: (device: Id) => Promise<void>;
};

export class KeyStoreError extends Error {
  override name = "KeyStoreError";
}

const SLOTS = ["sign", "wrap"] as const;

type Slot = (typeof SLOTS)[number];

type Backend = {
  readonly name: string;
  readonly add: (device: Id, slot: Slot, pkcs8: Bytes) => Promise<"added" | "exists">;
  readonly find: (device: Id, slot: Slot) => Promise<Bytes | undefined>;
  readonly remove: (device: Id, slot: Slot) => Promise<void>;
};

const SERVICE = "skills-hub";

const ITEM_NOT_FOUND = 44;

const DUPLICATE_ITEM = 45;

const read = new Map<string, Promise<Enrollment>>();

function account(device: Id, slot: Slot): string {
  return `${device}/${slot}`;
}

async function security(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const executable = Bun.which("security", { PATH: env.PATH ?? "" });
  if (executable === null) throw new KeyStoreError("security is not on PATH");

  const child = Bun.spawn([executable, ...args], {
    env,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code, stdout, stderr };
}

function failed(verb: string, code: number, stderr: string): KeyStoreError {
  const reason = stderr.trim().split("\n")[0] ?? "";
  return new KeyStoreError(
    `security ${verb} failed with exit ${code}${reason ? `: ${reason}` : ""}`,
  );
}

async function loginKeychain(env: NodeJS.ProcessEnv): Promise<string> {
  const { code, stdout, stderr } = await security(env, ["login-keychain"]);
  if (code !== 0) throw failed("login-keychain", code, stderr);

  const path = stdout.trim().replace(/^"(.*)"$/, "$1");
  if (path === "" || /["\n]/.test(path))
    throw new KeyStoreError(`security login-keychain printed no usable path: ${path}`);

  return path;
}

function keychain(env: NodeJS.ProcessEnv): Backend {
  let login: Promise<string> | undefined;
  const target = () => (login ??= loginKeychain(env));

  return {
    name: "keychain",
    async add(device, slot, pkcs8) {
      const secret = hex(pkcs8);
      const command = `add-generic-password -s ${SERVICE} -a ${account(device, slot)} -w ${secret} "${await target()}"\n`;
      const { code, stderr } = await security(env, ["-i"], command);
      if (code === 0) return "added";
      if (code === DUPLICATE_ITEM) return "exists";

      throw failed("add-generic-password", code, stderr.replaceAll(secret, "<key>"));
    },
    async find(device, slot) {
      const args = [
        "find-generic-password",
        "-s",
        SERVICE,
        "-a",
        account(device, slot),
        "-w",
        await target(),
      ];

      const { code, stdout, stderr } = await security(env, args);
      if (code === ITEM_NOT_FOUND) return undefined;
      if (code !== 0) throw failed("find-generic-password", code, stderr);

      return fromHex(stdout.trim());
    },
    async remove(device, slot) {
      const args = [
        "delete-generic-password",
        "-s",
        SERVICE,
        "-a",
        account(device, slot),
        await target(),
      ];

      const { code, stderr } = await security(env, args);
      if (code !== 0 && code !== ITEM_NOT_FOUND)
        throw failed("delete-generic-password", code, stderr);
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

function owned(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new KeyStoreError(
      `${directory} is not a private directory of this user, so it is not used`,
    );
}

function files(root: string): Backend {
  const directory = (device: Id) => join(root, device);
  const path = (device: Id, slot: Slot) => join(directory(device), `${slot}.key`);

  return {
    name: `file:${root}`,
    async add(device, slot, pkcs8) {
      mkdirSync(directory(device), { recursive: true, mode: 0o700 });
      owned(directory(device));

      let descriptor: number;
      try {
        descriptor = openSync(path(device, slot), "wx", 0o600);
      } catch (error) {
        if (errorCode(error) === "EEXIST") return "exists";
        throw error;
      }

      try {
        writeFileSync(descriptor, pkcs8);
      } catch (error) {
        rmSync(path(device, slot), { force: true });
        throw error;
      } finally {
        closeSync(descriptor);
      }

      return "added";
    },
    async find(device, slot) {
      let descriptor: number;
      try {
        descriptor = openSync(path(device, slot), "r");
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      }

      try {
        owned(directory(device));

        if ((fstatSync(descriptor).mode & 0o077) !== 0)
          throw new KeyStoreError(
            `${path(device, slot)} is open to other users, so it is not read`,
          );

        return new Uint8Array(readFileSync(descriptor));
      } finally {
        closeSync(descriptor);
      }
    },
    async remove(device, slot) {
      rmSync(path(device, slot), { force: true });

      try {
        rmdirSync(directory(device));
      } catch (error) {
        if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTEMPTY") throw error;
      }
    },
  };
}

function backend(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Backend {
  const mode = env.HUB_KEYS ?? "";
  if (mode !== "" && mode !== "file") throw new KeyStoreError(`HUB_KEYS takes file, not ${mode}`);
  if (mode === "" && platform === "darwin") return keychain(env);
  if (!env.HOME) throw new KeyStoreError("HOME is not set");

  return files(join(env.HOME, ".agents", "hub"));
}

async function load(store: Backend, device: Id): Promise<DeviceKeys | undefined> {
  const [sign, wrap] = await Promise.all(SLOTS.map((slot) => store.find(device, slot)));
  if (sign === undefined || wrap === undefined) return undefined;

  try {
    return { sign: await importSigning(sign), wrap: await importWrapping(wrap) };
  } catch {
    throw new KeyStoreError(`the ${store.name} keys of device ${device} do not parse`);
  }
}

export function keyStore(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): KeyStore {
  const store = backend(env, platform);
  const cached = (device: Id) => `${store.name}\n${device}`;

  return {
    async create(device) {
      const keys: DeviceKeys = { sign: await signingKeys(), wrap: await wrappingKeys() };

      const added: Slot[] = [];
      try {
        for (const slot of SLOTS) {
          if ((await store.add(device, slot, exportPrivate(keys[slot]))) === "exists")
            throw new KeyStoreError("device keys exist");

          added.push(slot);
        }
      } catch (error) {
        for (const slot of added) await store.remove(device, slot);
        throw error;
      } finally {
        read.delete(cached(device));
      }

      return keys;
    },
    read(device) {
      const key = cached(device);
      const known = read.get(key);
      if (known) return known;

      const loading = load(store, device).then((loaded) => loaded ?? "not enrolled");
      read.set(key, loading);
      loading.catch(() => {
        if (read.get(key) === loading) read.delete(key);
      });

      return loading;
    },
    async delete(device) {
      try {
        for (const slot of SLOTS) await store.remove(device, slot);
      } finally {
        read.delete(cached(device));
      }
    },
  };
}
