import { join } from "node:path";
import { processIo, type Io } from "../io.ts";
import { checkoutPinKey, gitRead, projectDirectories, type Pin, writePin } from "../project.ts";
import { describe } from "../read.ts";
import { logicalPath, plansDir } from "./paths.ts";

export async function bindVerb(
  args: readonly string[],
  usage: string,
  io: Io = processIo(),
): Promise<number> {
  const [arg = ""] = args;
  const clear = arg === "--clear";
  if (args.length !== 1 || arg === "" || (arg.startsWith("-") && !clear)) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const refuse = (reason: string): number => {
    io.err(`bind: ${reason}\n`);
    return 1;
  };

  const found = await gitRead(
    io.cwd,
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
    {},
    { ...io, env: { ...io.env, LC_ALL: "C" } },
  );

  if (!found.ok) return refuse(describe(found.failure));

  const [top = "", common = ""] = found.stdout.split("\n");
  if (found.code !== 0 || top === "" || common === "") {
    const said = found.stderr.trim();
    return /not a git repository/i.test(said) || said === ""
      ? refuse(`not inside a git repository: ${logicalPath(io.cwd, io.env, io.cwd)}`)
      : refuse(said);
  }

  let pin: Pin | undefined;
  if (!clear) {
    const plans = plansDir(io.env);
    const [name] = projectDirectories(plans, [{ step: "pin", name: arg }]).sort();
    if (name === undefined) return refuse(`no project ${arg} under ${plans}`);

    const keyed = await checkoutPinKey(io.cwd, io);
    if (!keyed.ok) return refuse("cannot read the checkout's remotes with git remote");

    pin = keyed.key ? { name, key: keyed.key } : { name };
  }

  const failure = await writePin(io.cwd, pin, io);
  if (failure !== undefined) return refuse(`cannot write ${join(common, "config")}: ${failure}`);

  const path = logicalPath(top, io.env, io.cwd);
  io.out(pin === undefined ? `unbound ${path}\n` : `bound ${path} to ${pin.name}\n`);
  return 0;
}
