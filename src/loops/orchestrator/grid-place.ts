interface GridCell { kind?: string }
export interface GridHost { name: string; capabilities: ReadonlySet<string>; available: boolean }

/** A proposal only: the caller owns the host inventory and the actual launch. */
export function placeOnGrid(cell: GridCell, hosts: readonly GridHost[]): { host: string; reason?: never } | { host: null; reason: string } {
  const kind = cell.kind ?? 'unknown';
  const host = hosts.find(candidate => candidate.available && candidate.capabilities.has(kind));
  if (host) return { host: host.name };
  return { host: null, reason: hosts.some(candidate => candidate.capabilities.has(kind))
    ? `no available host for ${kind}` : `no host with ${kind} capability` };
}
