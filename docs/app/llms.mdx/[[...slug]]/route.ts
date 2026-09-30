import { docsLlms, source } from "@/lib/source";
import { getPageMarkdownUrl } from "@/lib/shared";
import { notFound } from "next/navigation";

export const revalidate = false;

export async function GET(_req: Request, { params }: RouteContext<"/llms.mdx/[[...slug]]">) {
  const { slug } = await params;
  const segments = slug?.slice(0, -1) ?? [];
  const slugs = segments.at(-1) === "index" ? segments.slice(0, -1) : segments;

  const page = source.getPage(slugs);
  if (!page) notFound();

  return new Response(await docsLlms.page(page), {
    headers: {
      "Content-Type": "text/markdown",
    },
  });
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageMarkdownUrl(page).segments,
  }));
}
