'use client';

import { projectPwaProvenanceBadge } from '@/lib/provenance-badge';

/** Compact source-only tag. Deliberately omits device, lease, and scenario metadata. */
export function ProvenanceBadge({ source }: { source: unknown }): React.ReactNode {
  const projection = projectPwaProvenanceBadge(source);
  if (projection.kind === 'unbadged') return null;
  const label = projection.kind === 'badge' ? `${projection.icon} ${projection.label}` : projection.label;
  return <span data-testid={`provenance-${projection.kind === 'unknown' ? 'unknown' : projection.source}`}
    aria-label={`출처: ${label}`} title={`출처: ${label}`}
    className="inline-flex shrink-0 items-center rounded-full border border-current/25 px-1.5 text-[10px] leading-4 text-text-secondary">
    {label}
  </span>;
}
