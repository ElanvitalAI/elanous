import { readFileSync } from 'node:fs';

/** Operator-owned serverId -> Nexus memberId pins. Caller-provided IDs never choose an owner. */
export function loadRelayHostOwners(path: string): ReadonlyMap<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid relay host owners');
  const owners = new Map<string, string>();
  for (const [serverId, memberId] of Object.entries(parsed)) {
    if (!/^[a-f0-9]{64}$/.test(serverId) || typeof memberId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(memberId)) {
      throw new Error('invalid relay host owner entry');
    }
    owners.set(serverId, memberId);
  }
  return owners;
}

/** Every handshake asks Nexus again so expiry, key rotation and plan changes take effect. */
export function createNexusRelayMemberVerifier(nexusUrl: string, fetcher: typeof fetch = fetch) {
  const base = new URL(nexusUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('relay member Nexus URL must be an HTTPS origin');
  }
  return async (token: string, serverId: string): Promise<{ memberId: string } | null> => {
    if (!/^emt_[A-Za-z0-9_-]+$/.test(token) || !/^[a-f0-9]{64}$/.test(serverId)) return null;
    const url = new URL('/v1/tokens/introspect', base);
    url.searchParams.set('audience', serverId);
    try {
      const response = await fetcher(url, { method: 'POST', headers: { authorization: `Bearer ${token}` },
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(3_000) });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      const memberId = (body as { memberId?: unknown } | null)?.memberId;
      return typeof memberId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(memberId) ? { memberId } : null;
    } catch { return null; }
  };
}
