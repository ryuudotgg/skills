import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Io } from "../io.ts";
import { withLock } from "../lock.ts";
import {
  avdHome,
  emulatorSerials,
  lines,
  run,
  runningAvd,
  sdkRoot,
  toolPath,
  type Tools,
} from "./artifact-kinds.ts";
import { avdWord, type Owner } from "./artifacts.ts";
import { plansDir } from "./index-tsv.ts";
import { readOwnCheckout } from "./reap.ts";

export type DeviceOptions = { scratch?: string; boot?: number; poll?: number };

type Timing = { boot: number; poll: number };

type Found<T> = T | { refused: string };

type Runtime = {
  identifier: string;
  version: string;
  types: { name: string; identifier: string }[];
};

type Simulator = { name: string; udid: string; booted: boolean };

type Profile = { id: string; width: number; height: number; density: number; api: string };

type Image = { platform: string; version: string; tag: string; abi: string };

const STEP = 60_000;
const IOS_BOOT = 300_000;
const ADB_WAIT = 60_000;

const FIRST_PORT = 5554;
const LAST_PORT = 5584;
const IMAGE_TAGS = ["google_apis", "google_apis_playstore"];
const PLAIN_IPHONE = /^iPhone ([0-9]+)$/;
const PLAIN_PIXEL = /^pixel_([0-9]+)$/;

const DENSITIES: Record<string, number> = {
  ldpi: 120,
  mdpi: 160,
  tvdpi: 213,
  hdpi: 240,
  xhdpi: 320,
  xxhdpi: 480,
  xxxhdpi: 640,
};

function refused(found: unknown): found is { refused: string } {
  return typeof found === "object" && found !== null && "refused" in found;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const step = (a[index] ?? 0) - (b[index] ?? 0);
    if (step) return step;
  }

  return 0;
}

function ownerWords(owner: Owner): Found<string[]> {
  const words =
    owner.kind === "plan"
      ? ["plans", owner.project, owner.id]
      : owner.kind === "adhoc"
        ? ["adhoc", owner.repo, owner.branch]
        : [];

  const spaced = words.find((word) => /\s/.test(word));
  if (words.length === 0) return { refused: "the checkout has no owner" };
  return spaced ? { refused: `${JSON.stringify(spaced)} holds whitespace` } : words;
}

function parseJson(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function iosRuntimes(tools: Tools): Promise<Found<Runtime[]>> {
  const listed = await run(["xcrun", "simctl", "list", "runtimes", "--json"], tools, STEP);
  if (!listed.ok) return { refused: listed.reason };

  const runtimes = parseJson(listed.stdout)?.runtimes;
  if (!Array.isArray(runtimes))
    return { refused: "xcrun simctl list runtimes printed no runtime list" };

  return (runtimes as Record<string, unknown>[]).flatMap((runtime) => {
    const { identifier, version, platform, isAvailable, supportedDeviceTypes } = runtime ?? {};
    if (platform !== "iOS" || isAvailable !== true) return [];
    if (typeof identifier !== "string" || typeof version !== "string") return [];

    const types = (Array.isArray(supportedDeviceTypes) ? supportedDeviceTypes : []).flatMap(
      (type: Record<string, unknown>) =>
        typeof type?.name === "string" && typeof type.identifier === "string"
          ? [{ name: type.name, identifier: type.identifier }]
          : [],
    );

    return [{ identifier, version, types }];
  });
}

function pickIos(runtimes: readonly Runtime[], wanted: string | undefined) {
  const newest = runtimes
    .map((runtime) => runtime.version)
    .sort(compareVersions)
    .at(-1);

  if (newest === undefined) return { refused: "no iOS runtime is available" };

  const offered = runtimes
    .filter((runtime) => compareVersions(runtime.version, newest) === 0)
    .flatMap((runtime) => runtime.types.map((type) => ({ runtime, type })));

  if (wanted !== undefined) {
    const match = offered.find(({ type }) => type.name === wanted);
    return match ?? { refused: `iOS ${newest} has no device type ${wanted}` };
  }

  const plain = offered
    .map((pair) => ({ pair, number: Number(PLAIN_IPHONE.exec(pair.type.name)?.[1] ?? -1) }))
    .filter(({ number }) => number >= 0)
    .sort((left, right) => right.number - left.number);

  return plain[0]?.pair ?? { refused: `iOS ${newest} has no plain iPhone type` };
}

async function simulatorsNamed(name: string, tools: Tools): Promise<Found<Simulator[]>> {
  const listed = await run(["xcrun", "simctl", "list", "devices", "--json"], tools, STEP);
  if (!listed.ok) return { refused: listed.reason };

  const devices = parseJson(listed.stdout)?.devices;
  if (typeof devices !== "object" || devices === null)
    return { refused: "xcrun simctl list devices printed no device list" };

  return Object.values(devices).flatMap((list: unknown) =>
    (Array.isArray(list) ? (list as Record<string, unknown>[]) : []).flatMap((device) =>
      device?.name === name && typeof device.udid === "string" && device.isAvailable !== false
        ? [{ name, udid: device.udid, booted: device.state === "Booted" }]
        : [],
    ),
  );
}

async function ios(words: readonly string[], wanted: string | undefined, tools: Tools) {
  let runtimes: Runtime[] | undefined;
  let typeName = wanted;
  if (typeName === undefined) {
    const read = await iosRuntimes(tools);
    if (refused(read)) return read;

    const picked = pickIos(read, undefined);
    if (refused(picked)) return picked;

    runtimes = read;
    typeName = picked.type.name;
  }

  const name = [...words, typeName].join(" ");
  return lockDevice("ios", name, IOS_BOOT + STEP * 4, tools, async () => {
    const found = await simulatorsNamed(name, tools);
    if (refused(found)) return found;

    let udid = (found.find((device) => device.booted) ?? found[0])?.udid;
    if (!udid) {
      const read = runtimes ?? (await iosRuntimes(tools));
      if (refused(read)) return read;

      const picked = pickIos(read, typeName);
      if (refused(picked)) return picked;

      const created = await run(
        ["xcrun", "simctl", "create", name, picked.type.identifier, picked.runtime.identifier],
        tools,
        STEP,
      );

      if (!created.ok) return { refused: created.reason };

      udid = created.stdout.trim();
    }

    const booted = await run(["xcrun", "simctl", "bootstatus", udid, "-b"], tools, IOS_BOOT);
    return booted.ok ? udid : { refused: booted.reason };
  });
}

async function lockDevice(
  platform: string,
  name: string,
  wait: number,
  tools: Tools,
  work: () => Promise<Found<string>>,
): Promise<Found<string>> {
  const folder = join(plansDir(tools.io.env), ".devices");
  mkdirSync(folder, { recursive: true });
  return withLock(join(folder, `${platform}-${avdWord(name)}.lock`), "device", work, wait);
}

function hostAbi(): string {
  return process.arch === "arm64" ? "arm64-v8a" : "x86_64";
}

function newestImage(sdk: string): Image | undefined {
  const abi = hostAbi();
  const root = join(sdk, "system-images");
  const platforms = existsSync(root) ? readdirSync(root) : [];
  const images = platforms.flatMap((platform) => {
    const version = /^android-([0-9]+(?:\.[0-9]+)?)(?:-ext[0-9]+)?$/.exec(platform)?.[1];
    if (!version) return [];

    return IMAGE_TAGS.filter((tag) => existsSync(join(root, platform, tag, abi))).map((tag) => ({
      platform,
      version,
      tag,
      abi,
    }));
  });

  return images.sort(
    (left, right) =>
      compareVersions(right.version, left.version) ||
      IMAGE_TAGS.indexOf(left.tag) - IMAGE_TAGS.indexOf(right.tag),
  )[0];
}

function fits(profile: Profile, image: Image): boolean {
  const [low = "", high = low] = profile.api.includes("-")
    ? profile.api.split("-")
    : [profile.api, profile.api];

  if (low && compareVersions(image.version, low) < 0) return false;
  return !high || compareVersions(image.version, high) <= 0;
}

function parseProfiles(xml: string): Profile[] {
  return xml
    .split("<d:device>")
    .slice(1)
    .flatMap((block) => {
      const field = (tag: string) =>
        new RegExp(`<d:${tag}(?:\\s[^>]*)?>([^<]*)</d:${tag}>`).exec(block)?.[1]?.trim() ?? "";

      const id = field("id");
      const density = field("pixel-density");
      const dpi = Number(/^([0-9]+)dpi$/.exec(density)?.[1] ?? DENSITIES[density]);
      const width = Number(field("x-dimension"));
      const height = Number(field("y-dimension"));
      return id && dpi && width && height
        ? [{ id, width, height, density: dpi, api: field("api-level") }]
        : [];
    });
}

async function readProfiles(sdk: string, tools: Tools): Promise<Found<Profile[]>> {
  const root = join(sdk, "cmdline-tools");
  const versions = existsSync(root) ? readdirSync(root).sort().reverse() : [];
  const ordered = [
    ...versions.filter((name) => name === "latest"),
    ...versions.filter((name) => name !== "latest"),
  ];

  for (const version of ordered) {
    const folder = join(root, version, "lib", "sdklib");
    const jars = existsSync(folder)
      ? readdirSync(folder).filter((file) => file.endsWith(".jar"))
      : [];

    for (const jar of jars.sort()) {
      const xml = await run(
        ["unzip", "-p", join(folder, jar), "com/android/sdklib/devices/*.xml"],
        tools,
        STEP,
        [0, 11],
      );

      if (!xml.ok) continue;

      const profiles = parseProfiles(xml.stdout);
      if (profiles.length) return profiles;
    }
  }

  return {
    refused: `no device profiles under ${root}: install cmdline-tools;latest with sdkmanager`,
  };
}

function pickProfile(profiles: readonly Profile[], image: Image, wanted: string | undefined) {
  const label = `${image.platform} ${image.tag}`;
  if (wanted !== undefined) {
    const profile = profiles.find((entry) => entry.id === wanted);
    if (!profile) return { refused: `no device profile ${wanted}` };
    return fits(profile, image)
      ? profile
      : { refused: `${wanted} needs API ${profile.api}, the newest image is ${label}` };
  }

  const plain = profiles
    .filter((profile) => fits(profile, image))
    .map((profile) => ({ profile, number: Number(PLAIN_PIXEL.exec(profile.id)?.[1] ?? -1) }))
    .filter(({ number }) => number >= 0)
    .sort((left, right) => right.number - left.number);

  return plain[0]?.profile ?? { refused: `no plain Pixel profile runs ${label}` };
}

function writeAvd(home: string, name: string, image: Image, profile: Profile): void {
  const data = join(home, `${name}.avd`);
  const ini = join(home, `${name}.ini`);
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });

  const config = {
    AvdId: name,
    "PlayStore.enabled": image.tag.endsWith("playstore") ? "yes" : "no",
    "abi.type": image.abi,
    "avd.ini.displayname": name,
    "avd.ini.encoding": "UTF-8",
    "disk.dataPartition.size": "6G",
    "hw.cpu.arch": image.abi === "arm64-v8a" ? "arm64" : "x86_64",
    "hw.cpu.ncore": "4",
    "hw.device.manufacturer": "Google",
    "hw.device.name": profile.id,
    "hw.gpu.enabled": "yes",
    "hw.gpu.mode": "auto",
    "hw.keyboard": "yes",
    "hw.lcd.density": String(profile.density),
    "hw.lcd.height": String(profile.height),
    "hw.lcd.width": String(profile.width),
    "hw.ramSize": "2G",
    "image.sysdir.1": `system-images/${image.platform}/${image.tag}/${image.abi}/`,
    "tag.id": image.tag,
    target: image.platform,
  };

  const text = (entries: Record<string, string>) =>
    Object.entries(entries)
      .map(([key, value]) => `${key}=${value}\n`)
      .join("");

  writeFileSync(join(data, "config.ini"), text(config));
  writeFileSync(
    `${ini}.tmp`,
    text({ "avd.ini.encoding": "UTF-8", path: data, target: image.platform }),
  );

  renameSync(`${ini}.tmp`, ini);
}

async function bootCompleted(serial: string, tools: Tools): Promise<boolean> {
  const read = await run(
    ["adb", "-s", serial, "shell", "getprop", "sys.boot_completed"],
    tools,
    STEP,
  );

  return read.ok && lines(read.stdout)[0]?.trim() === "1";
}

async function serialOf(name: string, tools: Tools): Promise<Found<string | undefined>> {
  const serials = await emulatorSerials(tools);
  if (!Array.isArray(serials)) return { refused: serials.reason };

  const matching: string[] = [];
  for (const serial of serials)
    if ((await runningAvd(serial, tools)) === name) matching.push(serial);

  for (const serial of matching) if (await bootCompleted(serial, tools)) return serial;
  return matching[0];
}

async function portFree(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function startEmulator(
  name: string,
  sdk: string,
  log: string,
  tools: Tools,
): Promise<Found<{ serial: string; exited: () => boolean }>> {
  const { env } = tools.io;
  const emulator = toolPath("emulator", env);
  if (!emulator) return { refused: `emulator not found on PATH or under ${sdk}/emulator` };

  const serials = await emulatorSerials(tools);
  if (!Array.isArray(serials)) return { refused: serials.reason };

  for (let port = FIRST_PORT; port <= LAST_PORT; port += 2) {
    const serial = `emulator-${port}`;
    if (serials.includes(serial) || !(await portFree(port)) || !(await portFree(port + 1)))
      continue;

    const output = openSync(log, "a");
    const child = spawn(
      emulator,
      [
        "-avd",
        name,
        "-port",
        String(port),
        "-no-window",
        "-no-audio",
        "-no-boot-anim",
        "-no-snapshot",
      ],
      {
        cwd: avdHome(env),
        detached: true,
        stdio: ["ignore", output, output],
        env: { ...env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_AVD_HOME: avdHome(env) },
      },
    );

    closeSync(output);

    let exited = false;
    child.on("exit", () => (exited = true));
    child.on("error", () => (exited = true));
    child.unref();

    const deadline = Date.now() + ADB_WAIT;
    for (;;) {
      const now = await emulatorSerials(tools);
      const avd =
        Array.isArray(now) && now.includes(serial) ? await runningAvd(serial, tools) : undefined;

      if (avd === name) return { serial, exited: () => exited };
      if (avd) return { refused: `${serial} runs ${avd}, not ${name}, see ${log}` };
      if (exited) return { refused: `the emulator for ${name} exited, see ${log}` };
      if (Date.now() > deadline)
        return { refused: `adb never listed ${serial} within ${ADB_WAIT / 1000} s, see ${log}` };

      await Bun.sleep(250);
    }
  }

  return { refused: `no free emulator port from ${FIRST_PORT} to ${LAST_PORT + 1}` };
}

async function waitBooted(
  serial: string,
  log: string,
  exited: () => boolean,
  tools: Tools,
  { boot, poll }: Timing,
): Promise<Found<string>> {
  const deadline = Date.now() + boot;
  for (;;) {
    if (await bootCompleted(serial, tools)) return serial;
    if (exited()) return { refused: `${serial} exited before boot completed, see ${log}` };
    if (Date.now() > deadline)
      return {
        refused: `${serial} did not report boot completed within ${boot / 1000} s, see ${log}`,
      };

    await Bun.sleep(poll);
  }
}

async function android(
  words: readonly string[],
  wanted: string | undefined,
  tools: Tools,
  timing: Timing,
) {
  const { env } = tools.io;
  const sdk = sdkRoot(env);
  if (!existsSync(sdk)) return { refused: `no Android SDK at ${sdk}` };

  const image = newestImage(sdk);
  if (!image)
    return {
      refused: `no Google APIs system image for ${hostAbi()} under ${join(sdk, "system-images")}`,
    };

  let profiles: Profile[] | undefined;
  let type = wanted;
  if (type === undefined) {
    const read = await readProfiles(sdk, tools);
    if (refused(read)) return read;

    const picked = pickProfile(read, image, undefined);
    if (refused(picked)) return picked;

    profiles = read;
    type = picked.id;
  }

  const name = [...words.map(avdWord), type.replace(/[^A-Za-z0-9._-]/g, "-")].join("_");
  const home = avdHome(env);
  const log = join(home, `${name}.avd`, "emulator.log");
  const wait = timing.boot + ADB_WAIT * 2 + STEP * 6;
  return lockDevice("android", name, wait, tools, async () => {
    if (!existsSync(join(home, `${name}.ini`))) {
      const read = profiles ?? (await readProfiles(sdk, tools));
      if (refused(read)) return read;

      const picked = pickProfile(read, image, type);
      if (refused(picked)) return picked;

      writeAvd(home, name, image, picked);
    }

    const running = await serialOf(name, tools);
    if (refused(running)) return running;
    if (running) return waitBooted(running, log, () => false, tools, timing);

    const started = await withLock(
      join(plansDir(env), ".devices", "android-ports.lock"),
      "device ports",
      () => startEmulator(name, sdk, log, tools),
      ADB_WAIT + STEP,
    );

    if (refused(started)) return started;

    return waitBooted(started.serial, log, started.exited, tools, timing);
  });
}

export async function deviceVerb(
  args: readonly string[],
  usage: string,
  io: Io,
  { scratch = "/tmp", boot = 180_000, poll = 1_000 }: DeviceOptions = {},
): Promise<number> {
  const [platform = "", ...rest] = args;
  const typed = rest[0] === "--type" && rest.length === 2 ? rest[1] : undefined;
  if (!["ios", "android"].includes(platform) || (rest.length && !typed)) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const refuse = (reason: string): number => {
    io.err(`device: ${reason}\n`);
    return 1;
  };

  const checkout = await readOwnCheckout(io, scratch, true);
  if (typeof checkout === "string") return refuse(checkout);

  const { base } = checkout;
  const mine = base.mine ?? [];
  const owner = mine.find((entry) => entry.kind === "adhoc") ?? mine[0];
  const words = owner ? ownerWords(owner) : { refused: "the checkout has no owner" };
  if (refused(words)) return refuse(words.refused);

  const tools: Tools = { io, grace: 0, self: process.pid };
  try {
    const found =
      platform === "ios"
        ? await ios(words, typed, tools)
        : await android(words, typed, tools, { boot, poll });

    if (refused(found)) return refuse(found.refused);

    io.out(`${found}\n`);
    return 0;
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}
