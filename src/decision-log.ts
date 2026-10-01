import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function formulaSafe(value: string): string {
  const singleLine = value.replace(/[\t\n\r]/g, " ");
  return /^[=+\-@]/.test(singleLine) ? `'${singleLine}` : singleLine;
}

export function appendDecision(file: string, cells: readonly string[], now: Date): void {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });

  if (!existsSync(file)) {
    const temporary = join(directory, `.decision-log-${randomUUID()}.tmp`);
    writeFileSync(temporary, "ts\tproject\tplan\tbranch\tevidence\tresult\n", { flag: "wx" });

    try {
      linkSync(temporary, file);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
        throw error;
    } finally {
      unlinkSync(temporary);
    }
  }

  const timestamp = now.toISOString().slice(0, 19) + "Z";
  appendFileSync(file, `${timestamp}\t${cells.map(formulaSafe).join("\t")}\n`);
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
