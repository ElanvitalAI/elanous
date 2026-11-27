// 수호자·열쇠지기 (keys) — credentials as metadata-only world rows ⊕ secret exposure (GUARDIAN-CHARTER-1127 §1 자격 · v2 table).
// Name · owner · expiry · last refresh only — never a value. A token that stopped refreshing (> 7 days) or is disconnected is
// `stale` (the event that spawns the keys sub-agent); a secret-shaped string in logs / decisions / context (the existing
// scanSecretExposures, shadow mode) is one red card to OP per row, prefix and length only.
import type { WorldEntry } from './world.js';

export const KEY_STALE_MS = 7 * 24 * 60 * 60_000;
export interface CredentialIn { readonly provider: string; readonly connected: boolean; readonly expiresAt: number | null; readonly lastRefresh: string | null }
export interface ExposureIn { readonly store: string; readonly rowId: string; readonly kind: string; readonly prefix: string; readonly length: number }

/** Pure: credential metadata → world rows (no values ever reach this function). */
export function credentialEntries(creds: readonly CredentialIn[], nowMs: number): WorldEntry[] {
  return creds.map(c => {
    const refreshedMs = c.lastRefresh ? Date.parse(c.lastRefresh) : NaN;
    const stopped = Number.isFinite(refreshedMs) && nowMs - refreshedMs > KEY_STALE_MS && (c.expiresAt === null || c.expiresAt < nowMs);
    const status = !c.connected || stopped ? 'stale' : 'ok';
    return { kind: 'credential' as const, id: `oauth:${c.provider}`, owner: null, status, lastSeen: c.lastRefresh,
      facts: { connected: c.connected, expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null, lastRefresh: c.lastRefresh, ...(stopped ? { why: 'no refresh > 7d and access expired' } : !c.connected ? { why: 'disconnected' } : {}) } };
  });
}

export function judgeKeys(rows: readonly WorldEntry[], exposures: readonly ExposureIn[]): { value: string; ok: boolean | null; stale: string[] } {
  const creds = rows.filter(e => e.kind === 'credential');
  const stale = creds.filter(e => e.status === 'stale').map(e => e.id);
  return { stale, value: `자격 ${creds.length} · 만료/정지 ${stale.join(',') || '0'} · 노출 ${exposures.length}`, ok: creds.length || exposures.length ? stale.length === 0 && exposures.length === 0 : null };
}

export const exposureCard = (x: ExposureIn): string =>
  `[수호자·열쇠지기 · 🚨 비밀 노출] ${x.store} 행 ${x.rowId} 에 ${x.kind} 꼴 문자열(앞 ${x.prefix.length}자 «${x.prefix}…» · 길이 ${x.length}) — 값은 옮기지 않았다. 해당 키 회전·행 정리는 OP 결정(대표 보고).`;
