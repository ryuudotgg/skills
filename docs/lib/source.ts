import { llms, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";
import { docsRoute } from "./shared";
import { defineDocs } from "fumadocs-mdx/macro";
import { applyMdxPreset } from "fumadocs-mdx/config";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { remarkDelivery } from "./delivery";
import { remarkAgents } from "./agents";
import { remarkWorkflow } from "./workflow";
import { remarkSkills } from "./skills";

const docs = defineDocs({
  dir: "content/docs",
  meta: { schema: metaSchema },
  docs: {
    schema: pageSchema,
    mdxOptions: applyMdxPreset({
      remarkPlugins: [remarkDelivery, remarkAgents, remarkWorkflow, remarkSkills],
    }),
    postprocess: { includeProcessedMarkdown: true },
  },
});

export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText("processed")}`,
});
