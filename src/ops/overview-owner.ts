/** Owner labels used by ops overview task rows and the --owner filter. */
type OverviewOwnerKind = 'seat' | 'steward' | 'orchestrator' | 'external';
type OverviewOwner = `${OverviewOwnerKind}:${string}` | 'unassigned';

const OWNER_KINDS = new Set<OverviewOwnerKind>(['seat', 'steward', 'orchestrator', 'external']);

/** Normalize a task-card owner into a stable kind-prefixed overview key. */
export function normalizeOverviewOwner(value: unknown): OverviewOwner {
  if (typeof value !== 'string' || value.trim() === '') return 'unassigned';
  const normalized = value.trim();
  const separator = normalized.indexOf(':');
  if (separator >= 0) {
    const kind = normalized.slice(0, separator).toLowerCase() as OverviewOwnerKind;
    const name = normalized.slice(separator + 1).trim();
    if (OWNER_KINDS.has(kind) && name) return `${kind}:${name}`;
  }
  const kind = normalized.toLowerCase();
  if (kind === 'steward' || kind === 'orchestrator' || kind === 'external') return `${kind}:default`;
  return `seat:${normalized}`;
}

/** Whether a normalized owner key matches a CLI filter, accepting either the full key or its kind. */
export function matchesOverviewOwner(owner: OverviewOwner, filter?: string): boolean {
  if (!filter || filter === 'all') return true;
  const normalizedFilter = filter.trim();
  if (!normalizedFilter) return true;
  if (normalizedFilter.toLowerCase() === 'unassigned') return owner === 'unassigned';
  return owner === normalizeOverviewOwner(normalizedFilter) || owner.startsWith(`${normalizedFilter.toLowerCase()}:`);
}
