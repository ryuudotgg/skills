import tailwind from "bun-plugin-tailwind";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export async function buildDashboard(outdir: string): Promise<string> {
  rmSync(outdir, { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "src/index.html")],
    outdir,
    target: "browser",
    minify: true,
    splitting: false,
    publicPath: "/",
    plugins: [tailwind],
    naming: { entry: "[name].[ext]", chunk: "[name].[ext]", asset: "[name].[ext]" },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    throw: false,
  });

  if (!result.success) throw new AggregateError(result.logs, "dashboard build failed");

  const files = readdirSync(outdir).sort();
  const expected = ["index.css", "index.html", "index.js"];
  if (files.join() !== expected.join())
    throw new Error(`dashboard build wrote ${files.join(", ")}, expected ${expected.join(", ")}`);

  return outdir;
}

if (import.meta.main)
  process.stdout.write(`${await buildDashboard(join(import.meta.dir, "dist"))}\n`);
