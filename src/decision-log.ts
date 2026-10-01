import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const header = "ts\tproject\tplan\tbranch\tevidence\tresult\n";

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function followLinks(file: string): string {
  let path = file;
  for (let hops = 0; hops < 40; hops++) {
    try {
      if (!lstatSync(path).isSymbolicLink())
        return path;
    } catch {
      return path;
    }

    path = resolve(dirname(path), readlinkSync(path));
  }

  throw new Error(`too many symbolic links: ${file}`);
}

function createExclusive(file: string): void {
  try {
    writeFileSync(file, header, { flag: "ax" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST")
      throw error;
  }
}

function writeHeader(file: string): void {
  const temporary = join(dirname(file), `.decision-log-${randomUUID()}.tmp`);
  writeFileSync(temporary, header, { flag: "wx" });

  try {
    linkSync(temporary, file);
  } catch (error) {
    if (errorCode(error) !== "EEXIST")
      createExclusive(file);
  } finally {
    unlinkSync(temporary);
  }
}

export function formulaSafe(value: string): string {
  const singleLine = value.replace(/[\t\n\r]/g, " ");
  return /^[=+\-@]/.test(singleLine) ? `'${singleLine}` : singleLine;
}

export function appendDecision(file: string, cells: readonly string[], now: Date): void {
  const target = followLinks(file);
  mkdirSync(dirname(target), { recursive: true });

  if (!existsSync(target))
    writeHeader(target);

  const timestamp = now.toISOString().slice(0, 19) + "Z";
  appendFileSync(target, `${timestamp}\t${cells.map(formulaSafe).join("\t")}\n`);
}

export function logDecision(args: readonly string[]): number {
  const [file] = args;
  if (args.length !== 6 || file === undefined) {
    process.stderr.write("usage: skills log <file> <project> <plan> <branch> <evidence> <result>\n");
    return 2;
  }

  appendDecision(file, args.slice(1), new Date());

  return 0;
}
