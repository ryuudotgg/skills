export function OwnerOverview({ org, viewer }) {
  if (viewer.id !== org.ownerId) throw new Error("forbidden");
  return { title: "Overview", summary: org.internalSummary, visibility: "private" };
}
