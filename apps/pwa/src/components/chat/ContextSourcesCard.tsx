import type { ContextSource } from './context-sources';

export function ContextSourcesCard({ sources }: { sources?: readonly ContextSource[] }) {
  if (!sources?.length) return null;
  return (
    <ul aria-label="출처" className="mt-1 space-y-0.5 rounded border border-border/60 bg-muted/20 px-2 py-1 text-xs text-muted-foreground">
      {sources.map((row, index) => (
        <li key={`${row.source}-${index}`} title={row.source} className="break-words">
          {row.label}{row.ago !== null ? ` · ${row.ago}` : ''}
        </li>
      ))}
    </ul>
  );
}
