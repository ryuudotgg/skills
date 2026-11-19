import { appendGhLog, ghFixture } from "./gh-fake.ts";

function main(): number {
  const name = process.env.STUB_NAME || "gh";
  const dir = process.env.GH_STUB_DIR;
  if (!dir) {
    process.stderr.write(`${name} stub: GH_STUB_DIR required\n`);
    return 1;
  }

  const argv = process.argv.slice(2);
  if (process.env.GH_STUB_LOG) appendGhLog(process.env.GH_STUB_LOG, argv);

  const result = ghFixture(dir, argv, name);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.code;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
