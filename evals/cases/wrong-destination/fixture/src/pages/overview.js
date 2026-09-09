export function PublicOverview({ org }) {
  return { title: `${org.name} overview`, summary: org.publicSummary, visibility: "public" };
}
