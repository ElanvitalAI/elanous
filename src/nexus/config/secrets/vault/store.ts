// HQ-VAULT V1 · vault store: metadata index ⊕ encrypted envelopes (§3.1 · C2)
//
// Layout (all under `<configDir>/vault`, dir 0700, files 0600):
//   index.json                 metadata only (meta.ts)
//   items/<sha256(id)[0:32]>.json   one envelope per static item (envelope.ts)
// OAuth items are reference-only: metadata here, refresh token stays in the owner's store.
// Writes require the HQ fence (one writer); reads do not.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, chmodSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { elanousConfigDir } from '../../paths.js';
import { openVaultValue, sealVaultValue } from './envelope.js';
import { defaultVaultEventSink, vaultEvent, type VaultEventSink } from './events.js';
import { createKeychainVaultKek, VaultKekUnavailableError, type VaultKekProvider } from './kek.js';
import {
  assertVaultItemId, modifyVaultMeta, normalizeVaultHost, readVaultMeta, sanitizeVaultItemMeta, writeFileAtomic0600,
  type VaultItemKind, type VaultItemMeta,
} from './meta.js';

export function defaultVaultDir(): string {
  return join(elanousConfigDir(), 'vault');
}

export function vaultEnvelopePath(vaultDir: string, id: string): string {
  assertVaultItemId(id);
  return join(vaultDir, 'items', `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`);
}

export interface VaultItemInput {
  readonly id: string;
  readonly kind: VaultItemKind;
  readonly provider: string;
  readonly ownerHost: string;
  readonly allowedHosts?: readonly string[];
  readonly expiresAt?: string;
  readonly rotateEveryDays?: number;
}

export interface VaultStoreDeps {
  readonly vaultDir?: string;
  readonly kek?: VaultKekProvider;
  readonly now?: () => Date;
  readonly emit?: VaultEventSink;
  /** HQ fence for writes. Default: `hqFenceDecision('ledger-cli')` (run, or bootstrap before any lease). */
  readonly writeAllowed?: () => Promise<boolean> | boolean;
}

async function defaultWriteAllowed(): Promise<boolean> {
  try {
    const { hqFenceDecision } = await import('../../../../hq/hq.js');
    const decision = hqFenceDecision('ledger-cli');
    return decision.run || decision.reason === 'no-lease';
  } catch { return false; }
}

export interface VaultStore {
  readonly vaultDir: string;
  list(): readonly VaultItemMeta[];
  /** Create or update metadata. Never touches the value; generation is preserved. */
  upsertMeta(input: VaultItemInput): Promise<VaultItemMeta>;
  /** Seal a static value under a new generation. OAuth items are refused (reference only). */
  putValue(id: string, value: string): Promise<VaultItemMeta>;
  getValue(id: string): Promise<string>;
  /** Record a use (lastUsedAt) without reading the value. */
  touch(id: string): Promise<VaultItemMeta>;
  remove(id: string): Promise<boolean>;
}

export function createVaultStore(deps: VaultStoreDeps = {}): VaultStore {
  const vaultDir = deps.vaultDir ?? defaultVaultDir();
  const now = deps.now ?? (() => new Date());
  const emit = deps.emit ?? defaultVaultEventSink;
  const kek = deps.kek ?? createKeychainVaultKek({ vaultDir });
  const writeAllowed = deps.writeAllowed ?? defaultWriteAllowed;

  async function fenced(action: string, itemId: string): Promise<void> {
    if (await writeAllowed()) return;
    emit(vaultEvent('write.refused', { itemId, reason: `hq-fence:${action}` }, now(), 'warn'));
    throw new Error('VAULT_WRITE_REFUSED_HQ_FENCE');
  }

  async function withKek<T>(create: boolean, itemId: string, run: (key: Buffer) => T): Promise<T> {
    let key: Buffer;
    try {
      if (create) {
        const result = await kek.getOrCreate();
        key = Buffer.from(result.kek);
        if (result.created) emit(vaultEvent('kek.create', {}, now()));
      } else key = Buffer.from(await kek.get());
    } catch (error) {
      const reason = error instanceof VaultKekUnavailableError ? error.reason : 'error';
      emit(vaultEvent('kek.unavailable', { itemId, reason }, now(), 'warn'));
      throw new Error(`VAULT_KEK_UNAVAILABLE:${reason}`);
    }
    // Zero our own copy only; the provider's buffer is not ours to clear.
    try { return run(key); } finally { key.fill(0); }
  }

  function find(id: string): VaultItemMeta | undefined {
    return readVaultMeta(vaultDir).items.find((item) => item.id === id);
  }

  return {
    vaultDir,
    list() { return readVaultMeta(vaultDir).items; },

    async upsertMeta(input) {
      assertVaultItemId(input.id);
      await fenced('meta', input.id);
      const at = now().toISOString();
      const { meta, created } = modifyVaultMeta(vaultDir, input.id, (current) => {
        if (current && current.kind !== input.kind) throw new Error('VAULT_META_KIND_IMMUTABLE');
        const next = sanitizeVaultItemMeta({
          id: input.id, kind: input.kind, provider: input.provider,
          ownerHost: normalizeVaultHost(input.ownerHost), allowedHosts: input.allowedHosts ?? current?.allowedHosts ?? [],
          expiresAt: input.expiresAt ?? current?.expiresAt,
          rotateEveryDays: input.rotateEveryDays ?? current?.rotateEveryDays,
          lastUsedAt: current?.lastUsedAt, rotatedAt: current?.rotatedAt,
          createdAt: current?.createdAt ?? at, updatedAt: at, generation: current?.generation ?? 0,
        });
        return { next, result: { meta: next, created: !current } };
      });
      emit(vaultEvent('meta.upsert', { itemId: meta.id, kind: meta.kind, provider: meta.provider, ownerHost: meta.ownerHost,
        allowedHostCount: meta.allowedHosts.length, generation: meta.generation, created }, now()));
      return meta;
    },

    async putValue(id, value) {
      assertVaultItemId(id);
      if (typeof value !== 'string' || value.length === 0) throw new Error('VAULT_VALUE_EMPTY');
      await fenced('store', id);
      const current = find(id);
      if (!current) throw new Error('VAULT_ITEM_UNKNOWN');
      if (current.kind !== 'static') throw new Error('VAULT_OAUTH_IS_REFERENCE_ONLY');
      return withKek(true, id, (key) => {
        const at = now().toISOString();
        const meta = modifyVaultMeta(vaultDir, id, (latest) => {
          if (!latest || latest.kind !== 'static') throw new Error('VAULT_ITEM_UNKNOWN');
          const generation = latest.generation + 1;
          const envelope = sealVaultValue(key, id, generation, value);
          const path = vaultEnvelopePath(vaultDir, id);
          const itemsDir = join(vaultDir, 'items');
          mkdirSync(itemsDir, { recursive: true, mode: 0o700 });
          chmodSync(itemsDir, 0o700);
          // Envelope first, index second: a crash in between leaves generation N+1 on disk
          // against index N, which reads as GENERATION_MISMATCH (fail-closed), never stale.
          writeFileAtomic0600(path, itemsDir, `${JSON.stringify(envelope)}\n`);
          const next = { ...latest, generation, rotatedAt: at, updatedAt: at };
          return { next, result: next };
        });
        emit(vaultEvent('store', { itemId: id, kind: meta.kind, provider: meta.provider, generation: meta.generation }, now()));
        return meta;
      });
    },

    async getValue(id) {
      const meta = find(id);
      if (!meta) throw new Error('VAULT_ITEM_UNKNOWN');
      if (meta.kind !== 'static') throw new Error('VAULT_OAUTH_IS_REFERENCE_ONLY');
      if (meta.generation === 0) throw new Error('VAULT_VALUE_ABSENT');
      const path = vaultEnvelopePath(vaultDir, id);
      if (!existsSync(path)) throw new Error('VAULT_ENVELOPE_MISSING');
      const envelope = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      return withKek(false, id, (key) => openVaultValue(key, envelope, { itemId: id, generation: meta.generation }));
    },

    async touch(id) {
      await fenced('touch', id);
      const at = now().toISOString();
      const meta = modifyVaultMeta(vaultDir, id, (current) => {
        if (!current) throw new Error('VAULT_ITEM_UNKNOWN');
        const next = { ...current, lastUsedAt: at };
        return { next, result: next };
      });
      emit(vaultEvent('meta.touch', { itemId: id, kind: meta.kind }, now()));
      return meta;
    },

    async remove(id) {
      assertVaultItemId(id);
      await fenced('remove', id);
      const removed = modifyVaultMeta(vaultDir, id, (current) => ({ next: null, result: current }));
      const path = vaultEnvelopePath(vaultDir, id);
      if (existsSync(path)) unlinkSync(path);
      if (removed) emit(vaultEvent('meta.remove', { itemId: id, kind: removed.kind, provider: removed.provider }, now()));
      return removed !== undefined;
    },
  };
}
