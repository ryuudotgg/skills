import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../io.ts";
import { commitFixture, fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, suiteEnvironment } from "../test/process.ts";
import { deviceVerb } from "./device.ts";

const usage = "skills device ios|android [--type <type>]";
const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote";
const avdName = "plans_Skills_007_pixel_9";
const abi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";

const STUBS: Record<string, string> = {
  xcrun: `case "$1 $2 $3" in
  "simctl list runtimes") /bin/cat "$STUB/runtimes.json" ;;
  "simctl list devices")
    printf '{"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-26-0": ['
    sep=
    while IFS='|' read -r udid name state; do
      printf '%s{"name": "%s", "udid": "%s", "state": "%s", "isAvailable": true}' "$sep" "$name" "$udid" "$state"
      sep=,
    done < "$STUB/sims"
    printf ']}}\\n' ;;
esac
case "$1 $2" in
  "simctl create")
    udid="U-$(($(/usr/bin/wc -l < "$STUB/sims") + 1))"
    echo "$udid|$3|Shutdown" >> "$STUB/sims"
    echo "$udid" ;;
  "simctl bootstatus")
    /usr/bin/awk -F'|' -v u="$3" 'BEGIN { OFS = "|" } $1 == u { $3 = "Booted" } 1' "$STUB/sims" > "$STUB/sims.new"
    /bin/mv "$STUB/sims.new" "$STUB/sims" ;;
esac`,
  emulator: `case "$1" in
  -avd)
    echo "emulator-$4 $2" >> "$STUB/emulators"
    echo $$ >> "$STUB/pids"
    exec /bin/sleep 10 ;;
esac`,
  adb: `case "$1 $3 $4" in
  "devices  ")
    echo "List of devices attached"
    while read -r serial name; do printf '%s\\tdevice\\n' "$serial"; done < "$STUB/emulators" ;;
  "-s emu avd")
    while read -r serial name; do
      [ "$serial" = "$2" ] && printf '%s\\r\\nOK\\r\\n' "$name"
    done < "$STUB/emulators" ;;
  "-s shell getprop")
    [ -e "$STUB/neverboots" ] && exit 0
    echo poll >> "$STUB/polls-$2"
    [ "$(/usr/bin/wc -l < "$STUB/polls-$2")" -ge 3 ] && echo 1 ;;
esac`,
  unzip: `/bin/cat "$STUB/devices.xml"`,
};

const temporary: string[] = [];

type Tree = {
  directory: string;
  repo: string;
  checkout: string;
  stub: string;
  sdk: string;
  avd: string;
  env: NodeJS.ProcessEnv;
};

function row(id: string, status: string, branch: string): string {
  return [id, `p${id}`, status, "P1", "S", "-", "-", branch, "2026-10-01", "-"].join("\t");
}

function runtime(version: string, identifier: string, types: readonly string[]) {
  return {
    identifier,
    version,
    platform: "iOS",
    isAvailable: true,
    supportedDeviceTypes: types.map((name) => ({
      name,
      identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replace(/\W+/g, "-")}`,
    })),
  };
}

function profile(id: string, api = ""): string {
  const level = api ? `<d:api-level>${api}</d:api-level>` : "";
  return `<d:device><d:name>${id}</d:name><d:id>${id}</d:id><d:hardware><d:screen>
<d:pixel-density>420dpi</d:pixel-density><d:dimensions><d:x-dimension>1080</d:x-dimension>
<d:y-dimension>2424</d:y-dimension></d:dimensions></d:screen></d:hardware>
<d:software>${level}</d:software></d:device>`;
}

const RUNTIMES = {
  runtimes: [
    runtime("26.4", "com.apple.CoreSimulator.SimRuntime.iOS-26-4", ["iPhone 16", "iPhone 17"]),
    runtime("27.2", "com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4", ["iPhone Duo"]),
    runtime("27.2", "com.apple.CoreSimulator.SimRuntime.iOS-27-2", [
      "iPhone 18 Pro",
      "iPhone 17e",
      "iPhone Air",
      "iPhone 17",
      "iPhone 16 Plus",
      "iPad Air 11-inch (M4)",
    ]),
    {
      ...runtime("28.0", "com.apple.CoreSimulator.SimRuntime.iOS-28-0", ["iPhone 19"]),
      isAvailable: false,
    },
    {
      ...runtime("28.0", "com.apple.CoreSimulator.SimRuntime.watchOS-28-0", ["iPhone 19"]),
      platform: "watchOS",
    },
  ],
};

async function state(tree: Tree, name: string, content: string): Promise<void> {
  await writeFile(join(tree.stub, name), content);
}

async function createTree(): Promise<Tree> {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), "skills-device-")));
  temporary.push(directory);

  const bin = join(directory, "bin");
  const tree: Tree = {
    directory,
    repo: join(directory, "Skills"),
    checkout: join(directory, "wt-007"),
    stub: join(directory, "stub"),
    sdk: join(directory, "sdk"),
    avd: join(directory, "avd"),
    env: {
      ...suiteEnvironment(),
      PATH: bin,
      HOME: directory,
      STUB: join(directory, "stub"),
      PLANS_DIR: join(directory, "plans"),
      SKILLS_CONF: join(directory, "skills.conf"),
      ANDROID_HOME: join(directory, "sdk"),
      ANDROID_AVD_HOME: join(directory, "avd"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  };

  await Promise.all([bin, tree.stub, tree.avd].map((path) => mkdir(path)));
  await symlink(Bun.which("git")!, join(bin, "git"));

  for (const [tool, body] of Object.entries(STUBS)) {
    const script = `#!/bin/sh\necho "${tool} $*" >> "$STUB/calls"\n${body}\n`;
    await writeFile(join(bin, tool), script);
    await chmod(join(bin, tool), 0o755);
  }

  await mkdir(join(tree.sdk, "system-images", "android-35", "google_apis", abi), {
    recursive: true,
  });

  await mkdir(join(tree.sdk, "system-images", "android-36", "google_apis_playstore", abi), {
    recursive: true,
  });

  await writeFixture(tree.sdk, "cmdline-tools/latest/lib/sdklib/sdklib.core.jar", "");

  const origin = join(directory, "origin.git");
  await fixtureGit(directory, ["init", "--quiet", "--bare", "-b", "main", origin]);
  await fixtureGit(directory, ["init", "--quiet", "-b", "main", tree.repo]);
  await fixtureGit(tree.repo, ["remote", "add", "origin", origin]);

  await writeFixture(tree.repo, "base", "base\n");
  await commitFixture(tree.repo);
  await fixtureGit(tree.repo, ["push", "--quiet", "origin", "main"]);
  await fixtureGit(tree.repo, ["worktree", "add", "--quiet", "-b", "feat/a", tree.checkout]);

  const plans = join(directory, "plans");
  await writeFixture(
    plans,
    "Skills/index.tsv",
    `${[header, row("007", "DOING", "feat/a")].join("\n")}\n`,
  );

  await writeFixture(plans, "log.tsv", "ts\tproject\tid\tevent\tdetail\n");

  await state(tree, "runtimes.json", JSON.stringify(RUNTIMES));
  await state(tree, "sims", "");
  await state(tree, "emulators", "");
  await state(
    tree,
    "devices.xml",
    [
      profile("pixel_8"),
      profile("pixel_9"),
      profile("pixel_9_pro"),
      profile("pixel_10", "36.1-"),
    ].join("\n"),
  );

  return tree;
}

async function device(tree: Tree, args: readonly string[], cwd = tree.checkout) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: Io = {
    cwd,
    env: tree.env,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    capture: true,
  };

  const code = await deviceVerb(args, usage, io, { boot: 2_000, poll: 20 });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

async function calls(tree: Tree, prefix: string): Promise<string[]> {
  const log = join(tree.stub, "calls");
  const lines = existsSync(log) ? (await readFile(log, "utf8")).split("\n") : [];
  return lines.filter((line) => line.startsWith(prefix));
}

afterEach(async () => {
  for (const directory of temporary) {
    const pids = join(directory, "stub", "pids");
    const listed = existsSync(pids) ? (await readFile(pids, "utf8")).split("\n") : [];
    for (const pid of listed.filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
  }

  for (const directory of temporary) await removeTemporary(directory);
  temporary.length = 0;
});

describe("skills device ios", () => {
  test("creates and boots the owner's newest plain iPhone once, then reuses it", async () => {
    const tree = await createTree();

    const first = await device(tree, ["ios"]);
    expect(first).toEqual({ code: 0, stdout: "U-1\n", stderr: "" });
    expect(await calls(tree, "xcrun simctl create")).toEqual([
      "xcrun simctl create plans Skills 007 iPhone 17 com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-27-2",
    ]);

    const second = await device(tree, ["ios"]);
    expect(second).toEqual({ code: 0, stdout: "U-1\n", stderr: "" });
    expect(await calls(tree, "xcrun simctl create")).toHaveLength(1);
    expect(await readFile(join(tree.stub, "sims"), "utf8")).toBe(
      "U-1|plans Skills 007 iPhone 17|Booted\n",
    );
  });

  test("a type makes a second device beside the default one", async () => {
    const tree = await createTree();

    expect((await device(tree, ["ios"])).stdout).toBe("U-1\n");
    const ipad = await device(tree, ["ios", "--type", "iPad Air 11-inch (M4)"]);
    expect(ipad).toEqual({ code: 0, stdout: "U-2\n", stderr: "" });
    expect(await readFile(join(tree.stub, "sims"), "utf8")).toBe(
      "U-1|plans Skills 007 iPhone 17|Booted\nU-2|plans Skills 007 iPad Air 11-inch (M4)|Booted\n",
    );
  });

  test("boots a shut down device again and prefers the booted one of two", async () => {
    const tree = await createTree();
    await state(tree, "sims", "U-7|plans Skills 007 iPhone 17|Shutdown\n");

    expect(await device(tree, ["ios"])).toEqual({ code: 0, stdout: "U-7\n", stderr: "" });
    expect(await calls(tree, "xcrun simctl bootstatus")).toEqual([
      "xcrun simctl bootstatus U-7 -b",
    ]);

    await state(
      tree,
      "sims",
      "U-7|plans Skills 007 iPhone 17|Shutdown\nU-8|plans Skills 007 iPhone 17|Booted\n",
    );

    expect((await device(tree, ["ios"])).stdout).toBe("U-8\n");
    expect(await calls(tree, "xcrun simctl create")).toEqual([]);
  });

  test("names a rowless branch's device for the ad hoc owner", async () => {
    const tree = await createTree();
    const adhoc = join(tree.directory, "wt-z");
    await fixtureGit(tree.repo, ["worktree", "add", "--quiet", "-b", "feat/z", adhoc]);

    expect(await device(tree, ["ios"], adhoc)).toEqual({ code: 0, stdout: "U-1\n", stderr: "" });
    expect(await readFile(join(tree.stub, "sims"), "utf8")).toBe(
      "U-1|adhoc Skills feat/z iPhone 17|Booted\n",
    );
  });

  test("names a branch only a closed row holds for the ad hoc owner", async () => {
    const tree = await createTree();
    await writeFixture(
      tree.env.PLANS_DIR!,
      "Skills/index.tsv",
      `${[header, row("007", "DONE", "feat/a")].join("\n")}\n`,
    );

    expect(await device(tree, ["ios"])).toEqual({ code: 0, stdout: "U-1\n", stderr: "" });
    expect(await readFile(join(tree.stub, "sims"), "utf8")).toBe(
      "U-1|adhoc Skills feat/a iPhone 17|Booted\n",
    );
  });

  test("two calls at once for one owner make one device", async () => {
    const tree = await createTree();

    const both = await Promise.all([device(tree, ["ios"]), device(tree, ["ios"])]);
    expect(both.map((result) => result.stdout)).toEqual(["U-1\n", "U-1\n"]);
    expect(await calls(tree, "xcrun simctl create")).toHaveLength(1);
  });

  test("refuses with no iOS runtime and creates nothing", async () => {
    const tree = await createTree();
    await state(tree, "runtimes.json", JSON.stringify({ runtimes: [RUNTIMES.runtimes[3]] }));

    expect(await device(tree, ["ios"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "device: no iOS runtime is available\n",
    });

    expect(await calls(tree, "xcrun simctl create")).toEqual([]);
  });

  test("refuses a type the newest runtime lacks", async () => {
    const tree = await createTree();

    const result = await device(tree, ["ios", "--type", "iPhone 16"]);
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "device: iOS 27.2 has no device type iPhone 16\n",
    });
  });

  test("refuses on the default branch and a bad argument", async () => {
    const tree = await createTree();

    expect(await device(tree, ["ios"], tree.repo)).toEqual({
      code: 1,
      stdout: "",
      stderr: "device: the checkout has no owner: main is the default branch\n",
    });

    expect((await device(tree, ["watch"])).code).toBe(2);
    expect((await device(tree, ["ios", "--type"])).code).toBe(2);
    expect(await calls(tree, "xcrun")).toEqual([]);
  });
});

describe("skills device android", () => {
  test("creates the AVD, boots it headless and waits for boot completed", async () => {
    const tree = await createTree();

    const first = await device(tree, ["android"]);
    expect([first.code, first.stderr]).toEqual([0, ""]);
    expect(first.stdout).toMatch(/^emulator-55[5-8][0-9]\n$/);

    const serial = first.stdout.trim();
    const port = serial.slice("emulator-".length);
    expect(await calls(tree, "emulator")).toEqual([
      `emulator -avd ${avdName} -port ${port} -no-window -no-audio -no-boot-anim -no-snapshot`,
    ]);

    expect(await calls(tree, `adb -s ${serial} shell getprop`)).toHaveLength(3);

    const config = await readFile(join(tree.avd, `${avdName}.avd`, "config.ini"), "utf8");
    expect(config).toContain("hw.device.name=pixel_9\n");
    expect(config).toContain(
      `image.sysdir.1=system-images/android-36/google_apis_playstore/${abi}/\n`,
    );

    expect(await readFile(join(tree.avd, `${avdName}.ini`), "utf8")).toBe(
      `avd.ini.encoding=UTF-8\npath=${join(tree.avd, `${avdName}.avd`)}\ntarget=android-36\n`,
    );

    const second = await device(tree, ["android"]);
    expect(second).toEqual({ code: 0, stdout: first.stdout, stderr: "" });
    expect(await calls(tree, "emulator")).toHaveLength(1);
  });

  test("returns the booted emulator of two running the AVD", async () => {
    const tree = await createTree();
    await writeFixture(tree.avd, `${avdName}.ini`, "path=x\n");
    await state(tree, "emulators", `emulator-5560 ${avdName}\nemulator-5562 ${avdName}\n`);
    await state(tree, "polls-emulator-5562", "poll\npoll\n");

    expect(await device(tree, ["android"])).toEqual({
      code: 0,
      stdout: "emulator-5562\n",
      stderr: "",
    });

    expect(await calls(tree, "emulator")).toEqual([]);
  });

  test("refuses with the log path when boot never completes", async () => {
    const tree = await createTree();
    await state(tree, "neverboots", "");

    const result = await device(tree, ["android"]);
    const log = join(tree.avd, `${avdName}.avd`, "emulator.log");
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toMatch(
      new RegExp(
        `^device: emulator-[0-9]+ did not report boot completed within 2 s, see ${log}\n$`,
      ),
    );
  });

  test("refuses with no system image", async () => {
    const tree = await createTree();
    await rm(join(tree.sdk, "system-images"), { recursive: true });

    expect(await device(tree, ["android"])).toEqual({
      code: 1,
      stdout: "",
      stderr: `device: no Google APIs system image for ${abi} under ${join(tree.sdk, "system-images")}\n`,
    });

    expect(await calls(tree, "emulator")).toEqual([]);
  });

  test("refuses a profile the newest image cannot run", async () => {
    const tree = await createTree();

    const result = await device(tree, ["android", "--type", "pixel_10"]);
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "device: pixel_10 needs API 36.1-, the newest image is android-36 google_apis_playstore\n",
    });
  });
});
