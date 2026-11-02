export interface RemoteElnSession {
  readonly ptyId: string;
  readonly kind: string;
  readonly name: string;
  readonly alive: boolean;
  readonly registered: boolean;
  readonly registeredBy?: string;
  readonly registeredAt?: number;
  readonly lastActivityAt?: number;
  readonly status?: string;
}

export type RemoteElnInventoryHost =
  | { readonly host: string; readonly status: 'measured'; readonly sessions: readonly RemoteElnSession[] }
  | { readonly host: string; readonly status: 'unmeasured'; readonly reason: string; readonly sessions: readonly [] };

export interface RemoteElnInventoryFilters {
  readonly host?: readonly string[];
  readonly kind?: readonly string[];
  readonly registered?: boolean;
}

const HOST_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function normalizeSession(value: RemoteElnSession): RemoteElnSession {
  if (!value || typeof value !== 'object' || typeof value.ptyId !== 'string' || !value.ptyId.trim()
    || typeof value.kind !== 'string' || !value.kind.trim()) {
    throw new Error('invalid session identity');
  }
  if (typeof value.name !== 'string' || typeof value.alive !== 'boolean' || typeof value.registered !== 'boolean') {
    throw new Error('invalid session row');
  }
  return {
    ptyId: value.ptyId.trim(),
    kind: value.kind.trim(),
    name: value.name.trim() || value.ptyId.trim(),
    alive: value.alive,
    registered: value.registered,
    ...(typeof value.registeredBy === 'string' && value.registeredBy.trim() ? { registeredBy: value.registeredBy.trim() } : {}),
    ...(Number.isFinite(value.registeredAt) ? { registeredAt: value.registeredAt } : {}),
    ...(Number.isFinite(value.lastActivityAt) ? { lastActivityAt: value.lastActivityAt } : {}),
    ...(typeof value.status === 'string' && value.status ? { status: value.status } : {}),
  };
}

/** Query an explicit host roster. A failed host remains visible as unmeasured, never as an empty success. */
export async function collectRemoteElnInventory(
  hosts: readonly string[],
  queryHost: (host: string) => Promise<readonly RemoteElnSession[]>,
): Promise<RemoteElnInventoryHost[]> {
  const normalizedHosts = hosts.map((host) => host.trim());
  if (new Set(normalizedHosts).size !== normalizedHosts.length) throw new Error('duplicate host');
  for (const host of normalizedHosts) {
    if (!HOST_ALIAS.test(host)) throw new Error(`invalid host alias: ${host}`);
  }
  return Promise.all(normalizedHosts.map(async (host): Promise<RemoteElnInventoryHost> => {
    try {
      const sessions = await queryHost(host);
      if (!Array.isArray(sessions)) throw new Error('invalid inventory response');
      return { host, status: 'measured', sessions: sessions.map(normalizeSession) };
    } catch (error) {
      return {
        host,
        status: 'unmeasured',
        reason: error instanceof Error ? error.message : String(error),
        sessions: [],
      };
    }
  }));
}

export function filterRemoteElnInventory(
  inventory: readonly RemoteElnInventoryHost[],
  filters: RemoteElnInventoryFilters = {},
): RemoteElnInventoryHost[] {
  const hosts = filters.host?.length ? new Set(filters.host.map((host) => host.trim())) : null;
  const kinds = filters.kind?.length ? new Set(filters.kind.map((kind) => kind.trim())) : null;
  return inventory
    .filter((entry) => !hosts || hosts.has(entry.host))
    .map((entry): RemoteElnInventoryHost => entry.status === 'unmeasured'
      ? entry
      : {
        ...entry,
        sessions: entry.sessions.filter((session) =>
          (!kinds || kinds.has(session.kind))
          && (filters.registered === undefined || session.registered === filters.registered)),
      });
}
