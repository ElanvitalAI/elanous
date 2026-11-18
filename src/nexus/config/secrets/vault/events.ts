// HQ-VAULT V1 · audit events (내부 문서 `HQ-CREDENTIAL-VAULT` §3.5)
//
// category `secret` · events `meta.upsert` · `meta.remove` · `meta.touch` · `store` ·
// `kek.create` · `kek.unavailable` · `write.refused` · `inventory`.
// The payload type has no value/token/content field; callers pass ids, kinds, counts and
// reason codes only. `eln logs --category secret` reads them back.

export type VaultEventName =
  | 'meta.upsert' | 'meta.remove' | 'meta.touch' | 'store'
  | 'kek.create' | 'kek.unavailable' | 'write.refused' | 'inventory';

export interface VaultEventData {
  readonly itemId?: string;
  readonly kind?: string;
  readonly provider?: string;
  readonly ownerHost?: string;
  readonly allowedHostCount?: number;
  readonly generation?: number;
  readonly created?: boolean;
  readonly reason?: string;
  readonly items?: number;
  readonly external?: number;
  readonly risky?: number;
  readonly flags?: Readonly<Record<string, number>>;
}

export interface VaultEvent {
  readonly ts: string;
  readonly category: 'secret';
  readonly event: VaultEventName;
  readonly level: 'info' | 'warn';
  readonly data: VaultEventData;
}

export type VaultEventSink = (event: VaultEvent) => void;

/** Default sink: the shared logs store (`eln logs --category secret`). Lazy so tests/imports stay light. */
export const defaultVaultEventSink: VaultEventSink = (event) => {
  void import('../../../../mss/logging/log-store.js').then(({ getDefaultLogStore }) => {
    getDefaultLogStore()?.insertBatch([{ rec: { ts: event.ts, category: event.category, event: event.event, level: event.level, data: { ...event.data } }, surface: 'cli' }]);
  }).catch(() => { /* audit is best effort; never surface details */ });
};

export function vaultEvent(name: VaultEventName, data: VaultEventData, now: Date, level: 'info' | 'warn' = 'info'): VaultEvent {
  return { ts: now.toISOString(), category: 'secret', event: name, level, data };
}
