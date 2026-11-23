import { createGetUrl } from "fumadocs-core/source";

export const appName = "Ryuu's Skills";
export const docsRoute = "/";
export const docsImageRoute = "/og";
export const docsContentRoute = "/llms.mdx";

export const gitConfig = {
  user: "ryuudotgg",
  repo: "skills",
  branch: "main",
};

const getContentUrl = createGetUrl(docsContentRoute);
export function getPageMarkdownUrl(page: { slugs: string[] }) {
  const segments = [...page.slugs, "content.md"];
  return { segments, url: getContentUrl(segments) };
}

const getImageUrl = createGetUrl(docsImageRoute);
export function getPageImageUrl(page: { slugs: string[] }) {
  const segments = [...page.slugs, "image.png"];
  return { segments, url: getImageUrl(segments) };
}
