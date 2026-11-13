import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

/** Operator-provisioned mapping from a public user label to one authenticated Nexus host. */
export interface PublicDispatchRoute {
  serverId: string;
  ownerMemberId: string;
}

/** Load an operator-owned route file. Never trust a host-supplied user label. */
export function loadPublicDispatchRoutes(path: string): ReadonlyMap<string, PublicDispatchRoute> {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') {
    throw new Error('public dispatch safe open is unavailable');
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('public dispatch config must be owner-only regular file');
    }
    raw = readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).join() !== 'routes' || !Array.isArray((parsed as { routes?: unknown }).routes)) {
    throw new Error('invalid public dispatch config');
  }
  const result = new Map<string, PublicDispatchRoute>();
  for (const item of (parsed as { routes: unknown[] }).routes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join() !== 'ownerMemberId,serverId,user') throw new Error('invalid public dispatch config');
    const route = item as { user?: unknown; serverId?: unknown; ownerMemberId?: unknown };
    if (typeof route.user !== 'string' || typeof route.serverId !== 'string' || typeof route.ownerMemberId !== 'string'
      || result.has(route.user)) throw new Error('invalid public dispatch config');
    result.set(route.user, { serverId: route.serverId, ownerMemberId: route.ownerMemberId });
  }
  return result;
}

export function buildPublicDispatchRoutes(
  routes: ReadonlyMap<string, PublicDispatchRoute>,
  trustedServerIds: ReadonlySet<string>,
  hostOwnerMemberIds: ReadonlyMap<string, string>,
): ReadonlyMap<string, PublicDispatchRoute> {
  if (!routes.size) throw new Error('public dispatch requires at least one route');
  const result = new Map<string, PublicDispatchRoute>();
  const servers = new Set<string>();
  for (const [user, route] of routes) {
    if (user.length < 3 || user.length > 20 || user.includes('--')
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(user)
      || !/^[a-f0-9]{64}$/.test(route.serverId) || !trustedServerIds.has(route.serverId)
      || !route.ownerMemberId || hostOwnerMemberIds.get(route.serverId) !== route.ownerMemberId
      || servers.has(route.serverId)) {
      throw new Error('invalid public dispatch route');
    }
    servers.add(route.serverId);
    result.set(user, { serverId: route.serverId, ownerMemberId: route.ownerMemberId });
  }
  return result;
}
