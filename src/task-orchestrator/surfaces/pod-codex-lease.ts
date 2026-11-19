import { randomUUID } from 'node:crypto';
import { readCodexLeaseMarker } from '../../secret/codex-lease-guard.js';

/** Convert only the official OAuth lease result to the two isolated Pod auth files. */
export function podCodexLeaseCredential(raw: string, now: number, requiredUntil: number): { elanousAuth: string; codexAuth: string } {
  let store: { version?: number; providers?: Record<string, unknown> };
  try { store = JSON.parse(raw) as typeof store; } catch { throw new Error('codex-mirror-missing'); }
  const entry = store.providers?.['openai-codex'] as { source?: string; authMode?: string; lease?: unknown;
    tokens?: { accessToken?: unknown; idToken?: unknown; expiresAt?: unknown; refreshToken?: unknown; refresh_token?: unknown };
    chatGPT?: { accountId?: unknown } } | undefined;
  const marker = readCodexLeaseMarker(entry);
  const tokens = entry?.tokens;
  if (!entry || entry.source !== 'mirror' || entry.authMode !== 'chatgpt' || !marker || marker === 'malformed'
    || marker.revokedAt !== undefined || marker.expiresAt <= now || marker.expiresAt < requiredUntil
    || !tokens || typeof tokens.accessToken !== 'string' || !tokens.accessToken
    || typeof entry.chatGPT?.accountId !== 'string' || !entry.chatGPT.accountId
    || typeof tokens.expiresAt !== 'number' || tokens.expiresAt < requiredUntil
    || tokens.refreshToken !== '' || tokens.refresh_token !== '') throw new Error('codex-mirror-missing');
  return { elanousAuth: JSON.stringify({ version: store.version ?? 1, providers: { 'openai-codex': entry } }), codexAuth: '' };
}

export interface PodLeaseTransport {
  issue(target: string, account: string, ttlMinutes: number): Promise<{ leaseId: string }>;
  read(target: string): Promise<string>;
  revoke(leaseId: string): Promise<void>;
}

/** The target is one Job's isolated directory, never an owner or team auth path. */
export async function issuePodCodexLease(
  job: string, account: string, ttlMinutes: number, transport: PodLeaseTransport, now = Date.now(), nonce: string = randomUUID(),
): Promise<{ credential: { elanousAuth: string; codexAuth: string }; leaseId: string; expiresAt: number }> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(job) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(account)) throw new Error('pod-lease-identity-invalid');
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 1440) throw new Error('pod-lease-ttl-invalid');
  if (!/^[a-z0-9-]{1,64}$/.test(nonce)) throw new Error('pod-lease-identity-invalid');
  const target = `~/elanous-hq/seat-state/RES/pod-oauth-leases/${job}-${nonce}`;
  const issued = await transport.issue(target, account, ttlMinutes);
  try {
    const raw = await transport.read(target);
    const credential = podCodexLeaseCredential(raw, now, now + ttlMinutes * 60_000);
    const entry = JSON.parse(credential.elanousAuth).providers['openai-codex'];
    const marker = readCodexLeaseMarker(entry);
    if (!marker || marker === 'malformed' || marker.leaseId !== issued.leaseId) throw new Error('codex-lease-id-mismatch');
    return { credential, leaseId: issued.leaseId, expiresAt: marker.expiresAt };
  } catch (error) {
    await transport.revoke(issued.leaseId);
    throw error;
  }
}

/** Invoke the existing owner-side eln lease CLI; credential bytes stay in process memory. */
export function ownerPodLeaseTransport(owner: string, run: (host: string, command: string) => { status: number | null; stdout: string }): PodLeaseTransport {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(owner)) throw new Error('pod-lease-owner-invalid');
  const checked = (command: string) => {
    const result = run(owner, command);
    if (result.status !== 0) throw new Error('codex-mirror-missing');
    return result.stdout;
  };
  return {
    issue: async (target, account, ttl) => {
      if (!/^~\/elanous-hq\/seat-state\/RES\/pod-oauth-leases\/[a-z0-9-]+$/.test(target) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(account) || !Number.isSafeInteger(ttl) || ttl < 5 || ttl > 1440) throw new Error('pod-lease-identity-invalid');
      const out = checked(`export PATH="$HOME/.local/share/elanous/bin:$PATH"; eln secret oauth-lease codex --account '${account}' --to '${target}' --ttl '${ttl}m' --json`);
      let result: { ok?: unknown; leaseId?: unknown };
      try { result = JSON.parse(out) as typeof result; } catch { throw new Error('codex-mirror-missing'); }
      if (result.ok !== true || typeof result.leaseId !== 'string' || !/^lease-[a-z0-9-]+$/.test(result.leaseId)) throw new Error('codex-mirror-missing');
      return { leaseId: result.leaseId };
    },
    read: async target => {
      if (!/^~\/elanous-hq\/seat-state\/RES\/pod-oauth-leases\/[a-z0-9-]+$/.test(target)) throw new Error('pod-lease-identity-invalid');
      return checked(`cat "$HOME/${target.slice(2)}/auth.json"`);
    },
    revoke: async leaseId => {
      if (!/^lease-[a-z0-9-]+$/.test(leaseId)) throw new Error('pod-lease-id-invalid');
      checked(`export PATH="$HOME/.local/share/elanous/bin:$PATH"; eln secret oauth-lease revoke '${leaseId}' --json`);
    },
  };
}
