import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function ghFixture(dir: string, argv: readonly string[]): { stdout: Buffer; stderr: string; code: number } {
  const args = argv.join(" ");
  const key = args.replace(/[^A-Za-z0-9._-]/gu, "_");

  let file = join(dir, key);
  if (!isFile(file)) {
    const names = readdirSync(dir).filter((name) => !name.startsWith(".") && name.endsWith(".prefix"));
    names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

    const prefix = names.find((name) => key.startsWith(name.slice(0, -7)) && isFile(join(dir, name)));
    if (!prefix) return { stdout: Buffer.alloc(0), stderr: `gh stub: no fixture ${key} for: ${args}\n`, code: 1 };

    file = join(dir, prefix);
  }

  const stdout = readFileSync(file);
  const code = isFile(`${file}.exit`) ? Number(readFileSync(`${file}.exit`, "utf8").trim()) : 0;
  if (!Number.isInteger(code)) return { stdout, stderr: `gh stub: bad exit status in ${file}.exit\n`, code: 2 };

  return { stdout, stderr: "", code };
}

export function appendGhLog(logPath: string, argv: readonly string[]): void {
  appendFileSync(logPath, `${argv.join(" ")}\n`);
}
