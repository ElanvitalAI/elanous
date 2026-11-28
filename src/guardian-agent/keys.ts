// 수호자·열쇠지기 (keys) — credentials as metadata-only world rows ⊕ secret exposure (GUARDIAN-CHARTER-1127 §1 자격 · v2 table).
// Name · owner · expiry · last refresh only — never a value. A token that stopped refreshing (> 7 days) or is disconnected is
// `stale` (the event that spawns the keys sub-agent); a secret-shaped string in logs / decisions / context (the existing
// scanSecretExposures, shadow mode) is one red card to OP per row, prefix and length only (the card text is agent.yaml
// subs[keys].resource_check — CODE-BODY-TO-KIND).
import type { WorldEntry } from './world.js';
import { gp } from './def.js';
import { credentialId } from '../kit/credential-keeper/index.js';

// key_stale_days — agent.yaml policy (graphs/loop-agents/guardian · def.ts gp())
export interface CredentialIn {
  readonly provider: string; readonly connected: boolean; readonly expiresAt: number | null; readonly lastRefresh: string | null;
  /** KEYS-PROACTIVE-REFRESH: the CLI credential home (CODEX_HOME) this login lives in — the 열쇠지기 can refresh only these */
  readonly home?: string | null;
  /** the home holds a refresh token (an access-only seat copy cannot refresh — its owner home does) */
  readonly refreshable?: boolean;
}
export interface ExposureIn { readonly store: string; readonly rowId: string; readonly kind: string; readonly prefix: string; readonly length: number }

/** Pure: credential metadata → world rows (no values ever reach this function). */
export function credentialEntries(creds: readonly CredentialIn[], nowMs: number): WorldEntry[] {
  const KEY_STALE_MS = gp('key_stale_days') * 24 * 60 * 60_000;
  return creds.map(c => {
    const refreshedMs = c.lastRefresh ? Date.parse(c.lastRefresh) : NaN;
    // GUARDIAN-SUBS 11-28: «stopped» needs a KNOWN expiry in the past. An unknown expiry (a named codex account's elanous row
    // only points at its CODEX_HOME · lastRefresh = the import time) is `unknown`, never `stale` — the 30× false alarm on
    // codex team/third whose tokens were live (live deps read <codexHome>/auth.json for the real numbers · pulse.ts).
    const stopped = Number.isFinite(refreshedMs) && nowMs - refreshedMs > KEY_STALE_MS && c.expiresAt !== null && c.expiresAt < nowMs;
    const status = !c.connected || stopped ? 'stale' : c.expiresAt === null && Number.isFinite(refreshedMs) && nowMs - refreshedMs > KEY_STALE_MS ? 'unknown' : 'ok';
    return { kind: 'credential' as const, id: credentialId(c), owner: null, status, lastSeen: c.lastRefresh,
      facts: { connected: c.connected, expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null, lastRefresh: c.lastRefresh, ...(c.home ? { home: c.home } : {}), ...(stopped ? { why: `no refresh > ${gp('key_stale_days')}d and access expired` } : !c.connected ? { why: 'disconnected' } : {}) } };
  });
}

/** Pure: the 열쇠지기 summary line (the KPI's ok is the agent.yaml line — CODE-BODY-TO-KIND). */
export function judgeKeys(rows: readonly WorldEntry[], exposures: readonly ExposureIn[]): { value: string; stale: string[] } {
  const creds = rows.filter(e => e.kind === 'credential');
  const stale = creds.filter(e => e.status === 'stale').map(e => e.id);
  const unknown = creds.filter(e => e.status === 'unknown').map(e => e.id);
  return { stale, value: `자격 ${creds.length} · 만료/정지 ${stale.join(',') || '0'}${unknown.length ? ` · 만료 모름 ${unknown.join(',')}` : ''} · 노출 ${exposures.length}` };
}
