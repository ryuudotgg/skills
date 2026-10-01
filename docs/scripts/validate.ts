import { printErrors, scanURLs, validateFiles } from "next-validate-link";
import { source } from "../lib/source";
import { sidebarUrls } from "./sidebar";
import { guards } from "../../src/hooks/guards";

const pages = source.getPages();
const sidebar = new Set(sidebarUrls());

for (const page of pages)
  if (!sidebar.has(page.url)) {
    console.error(`Page Missing: ${page.url}`);
    process.exit(1);
  }

const hookScripts = new Set<string>(guards);
const hookPages = new Set(
  pages.filter((page) => page.url.startsWith("/hooks/")).map((page) => page.url.slice(7)),
);

const hookErrors = [
  ...[...hookScripts]
    .filter((name) => !hookPages.has(name))
    .map((name) => `Hook Page Missing: /hooks/${name} (CLI guard)`),
  ...[...hookPages]
    .filter((name) => !hookScripts.has(name))
    .map((name) => `Hook Guard Missing: ${name} (/hooks/${name})`),
];

if (hookErrors.length) {
  for (const error of hookErrors) console.error(error);
  process.exit(1);
}

const scanned = await scanURLs({
  preset: "next",
  populate: {
    "(docs)/[[...slug]]": pages.map((page) => ({
      value: page.slugs,
      hashes: page.data.toc.map((heading) => heading.url.slice(1)),
    })),
  },
});

const files = await Promise.all(
  pages.map(async (page) => ({
    path: `content/docs/${page.path}`,
    url: page.url,
    content: await page.data.getText("raw"),
  })),
);

const results = await validateFiles(files, {
  scanned,
  markdown: { components: { Card: { attributes: ["href"] } } },
  checkRelativePaths: "as-url",
});

printErrors(results, true);
