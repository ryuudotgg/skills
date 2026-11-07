import { NextRequest, NextResponse } from "next/server";
import { isMarkdownPreferred, rewritePath } from "fumadocs-core/negotiation";
import { docsContentRoute } from "@/lib/shared";

const { rewrite: rewriteDocs } = rewritePath("{/*path}", `${docsContentRoute}{/*path}/content.md`);
const { rewrite: rewriteSuffix } = rewritePath(
  "{/*path}.md",
  `${docsContentRoute}{/*path}/content.md`,
);

export default function proxy(request: NextRequest) {
  const result = rewriteSuffix(request.nextUrl.pathname);
  if (result) return NextResponse.rewrite(new URL(result, request.nextUrl));

  if (isMarkdownPreferred(request)) {
    const result = rewriteDocs(request.nextUrl.pathname);
    if (result)
      return NextResponse.rewrite(new URL(result, request.nextUrl), {
        headers: { Vary: "Accept" },
      });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/|og/|llms|_next/|.*\\.(?!md$)[^/]+$).*)"],
};
