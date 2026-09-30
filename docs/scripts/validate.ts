import { printErrors, scanURLs, validateFiles } from "next-validate-link";
import { source } from "../lib/source";
import { sidebarUrls } from "./sidebar";

const pages = source.getPages();
const sidebar = new Set(sidebarUrls());

for (const page of pages)
  if (!sidebar.has(page.url)) {
    console.error(`Page Missing: ${page.url}`);
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
