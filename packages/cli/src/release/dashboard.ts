import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dashboardAsset, sumsAsset } from "../update/dashboard.ts";

export async function packDashboard(version: string, dist: string, outdir: string) {
  const files: Record<string, Uint8Array> = {};
  for (const name of readdirSync(dist, { recursive: true, encoding: "utf8" }).sort())
    if (statSync(join(dist, name)).isFile()) files[name] = await Bun.file(join(dist, name)).bytes();

  if (!files["index.html"]) throw new Error(`no index.html in ${dist}`);

  mkdirSync(outdir, { recursive: true });

  const name = dashboardAsset(version);
  const tarball = join(outdir, name);
  await Bun.Archive.write(tarball, files, { compress: "gzip" });

  const sum = new Bun.CryptoHasher("sha256").update(await Bun.file(tarball).bytes()).digest("hex");
  const sums = join(outdir, sumsAsset);
  await Bun.write(sums, `${sum}  ${name}\n`);

  return { tarball, sums };
}

if (import.meta.main) {
  const [version, dist, outdir] = process.argv.slice(2);
  if (!version || !dist || !outdir || !/^\d+\.\d+\.\d+$/.test(version)) {
    process.stderr.write(
      "usage: bun packages/cli/src/release/dashboard.ts <version> <dist> <outdir>\n",
    );

    process.exit(2);
  }

  const { tarball, sums } = await packDashboard(version, dist, outdir);
  process.stdout.write(`${tarball}\n${sums}\n`);
}
