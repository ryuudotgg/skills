import { slugify } from "./slug.js";

export function permalink(post) {
  return `/${post.year}/${slugify(post.title)}`;
}
