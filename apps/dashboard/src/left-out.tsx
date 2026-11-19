export function LeftOut({
  text,
  action,
  onMore,
}: {
  text: string;
  action: string;
  onMore?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <p className="text-sm text-ink-secondary">{text}</p>
      <button
        type="button"
        onClick={onMore}
        className="rounded border border-hairline px-2 py-1 text-sm hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus"
      >
        {action}
      </button>
    </div>
  );
}
