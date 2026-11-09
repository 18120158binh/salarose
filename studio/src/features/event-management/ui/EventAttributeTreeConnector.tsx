// The lines that join an attribute row to its parent. inset is where the first level's line
// sits, which depends on the row's padding.
export function EventAttributeTreeConnector({ depth, inset = 11 }: { depth: number; inset?: number }) {
  if (depth === 0) return null;

  return (
    <>
      {Array.from({ length: depth }).map((_, level) => (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 border-l-2 border-primary/50"
          key={level}
          style={{ insetInlineStart: `${level * 24 + inset}px` }}
        />
      ))}
      <span
        aria-hidden="true"
        className="absolute top-1/2 w-3 border-t-2 border-primary/50"
        style={{ insetInlineStart: `${(depth - 1) * 24 + inset}px` }}
      />
    </>
  );
}
