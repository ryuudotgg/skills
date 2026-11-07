import { flattenTree } from "fumadocs-core/page-tree";
import { source } from "../lib/source";

export function sidebarUrls(): string[] {
  return flattenTree(source.getPageTree().children).map((page) => page.url);
}
