import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getMDXComponents } from "../components/mdx";
import { source } from "../lib/source";
import { sidebarUrls } from "./sidebar";

const rendered = process.argv.includes("--html");
const pages = source.getPages();
const texts = Object.fromEntries(
  await Promise.all(
    pages.map(async (page) => [
      page.url,
      {
        path: page.path,
        raw: await page.data.getText("raw"),
        processed: await page.data.getText("processed"),
        ...(rendered && {
          html: renderToStaticMarkup(
            createElement(page.data.body, { components: getMDXComponents() }),
          ),
        }),
      },
    ]),
  ),
);

console.log(
  JSON.stringify({ pages: pages.map((page) => page.url), sidebar: sidebarUrls(), texts }),
);
