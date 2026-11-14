import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import sodium from 'libsodium-wrappers';
import { migrationStaticSlots } from './credentials-migration-bundle.js';
import { importSealedStaticMigration, sealStaticMigration, type AtomicSealedStaticBackend } from './credentials-migration-sealed.js';

const at = 1_800_000_000_000;
const fakeValue = 'synthetic-static-value-only';
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

class FakeAtomicBackend implements AtomicSealedStaticBackend {
  readonly atomicBatchAndMarker = true;
  readonly slots = new Map<string, string>();
  readonly markers = new Map<string, string>();

  async commitEmptyStaticBatch(input: { bundleId: string; envelopeSha256: string;
    staticSecrets: Readonly<Record<string, string>> }): Promise<'applied' | 'already-applied' | 'conflict'> {
    const marker = this.markers.get(input.bundleId);
    if (marker !== undefined) {
      if (marker !== input.envelopeSha256) return 'conflict';
      for (const [id, value] of Object.entries(input.staticSecrets)) {
        if ((migrationStaticSlots(id) ?? []).some((slot) => this.slots.get(slot) !== value)) return 'conflict';
      }
      return 'already-applied';
    }
    const slots = Object.keys(input.staticSecrets).flatMap((id) => migrationStaticSlots(id) ?? []);
    if (slots.some((slot) => this.slots.has(slot))) return 'conflict';
    // One fake transaction: no await or externally visible intermediate state.
    for (const [id, value] of Object.entries(input.staticSecrets)) {
      for (const slot of migrationStaticSlots(id) ?? []) this.slots.set(slot, value);
    }
    this.markers.set(input.bundleId, input.envelopeSha256);
    return 'applied';
  }
}

test('two fake machines: pinned receiver opens only its own sealed static bundle and replay is idempotent', async () => {
  await sodium.ready;
  const first = sodium.crypto_box_keypair();
  const second = sodium.crypto_box_keypair();
  const fingerprint = digest(first.publicKey);
  const serialized = await sealStaticMigration({ targetMachine: 'machine-a', targetKeyVersion: 1,
    targetPublicKey: first.publicKey, pinnedFingerprint: fingerprint, staticSecrets: { exa: fakeValue }, now: at });
  expect(serialized).not.toContain(fakeValue);
  expect(serialized).not.toContain('exa');
  const backend = new FakeAtomicBackend();
  const common = { serialized, targetMachine: 'machine-a', targetKeyVersion: 1,
    targetPublicKey: first.publicKey, targetPrivateKey: first.privateKey, pinnedFingerprint: fingerprint,
    approval: { mode: 'manual-untrusted' as const, envelopeSha256: digest(serialized),
      sourceConfirmedOutOfBand: true as const }, backend, now: at + 1 };
  await expect(importSealedStaticMigration({ ...common, targetMachine: 'machine-b' })).rejects.toThrow('SEALED_MIGRATION_REFUSED');
  await expect(importSealedStaticMigration({ ...common, targetPrivateKey: second.privateKey })).rejects.toThrow('SEALED_MIGRATION_REFUSED');
  await expect(importSealedStaticMigration({ ...common, targetPublicKey: second.publicKey,
    pinnedFingerprint: digest(second.publicKey) })).rejects.toThrow('SEALED_MIGRATION_REFUSED');
  const firstResult = await importSealedStaticMigration(common);
  expect(firstResult).toMatchObject({ staticCount: 1, status: 'applied' });
  expect(backend.slots.get(migrationStaticSlots('exa')![0]!)).toBe(fakeValue);
  expect((await importSealedStaticMigration(common)).status).toBe('already-applied');
  expect(backend.markers.size).toBe(1);
  expect(await backend.commitEmptyStaticBatch({ bundleId: firstResult.bundleId,
    envelopeSha256: digest('different-envelope'), staticSecrets: { exa: fakeValue } })).toBe('conflict');
  backend.slots.delete(migrationStaticSlots('exa')![0]!);
  await expect(importSealedStaticMigration(common)).rejects.toThrow('SEALED_MIGRATION_REFUSED');
  backend.slots.set(migrationStaticSlots('exa')![0]!, fakeValue);

  const reverse = await sealStaticMigration({ targetMachine: 'machine-b', targetKeyVersion: 4,
    targetPublicKey: second.publicKey, pinnedFingerprint: digest(second.publicKey),
    staticSecrets: { exa: 'second-synthetic-static-value' }, now: at });
  const secondBackend = new FakeAtomicBackend();
  const secondResult = await importSealedStaticMigration({ serialized: reverse, targetMachine: 'machine-b',
    targetKeyVersion: 4, targetPublicKey: second.publicKey, targetPrivateKey: second.privateKey,
    pinnedFingerprint: digest(second.publicKey), approval: { mode: 'manual-untrusted',
      envelopeSha256: digest(reverse), sourceConfirmedOutOfBand: true }, backend: secondBackend, now: at + 1 });
  expect(secondResult).toMatchObject({ staticCount: 1, status: 'applied' });
  expect(secondBackend.slots.get(migrationStaticSlots('exa')![0]!)).toBe('second-synthetic-static-value');
});

test('manual trust, tamper, occupied alias, and missing atomic backend refuse without value output', async () => {
  await sodium.ready;
  const first = sodium.crypto_box_keypair();
  const fingerprint = digest(first.publicKey);
  const serialized = await sealStaticMigration({ targetMachine: 'machine-a', targetKeyVersion: 2,
    targetPublicKey: first.publicKey, pinnedFingerprint: fingerprint, staticSecrets: { exa: fakeValue }, now: at });
  const backend = new FakeAtomicBackend();
  const input = { serialized, targetMachine: 'machine-a', targetKeyVersion: 2,
    targetPublicKey: first.publicKey, targetPrivateKey: first.privateKey, pinnedFingerprint: fingerprint,
    approval: { mode: 'manual-untrusted' as const, envelopeSha256: digest(serialized),
      sourceConfirmedOutOfBand: true as const }, backend, now: at + 1 };
  await expect(importSealedStaticMigration({ ...input, backend: undefined })).rejects.toThrow('SEALED_MIGRATION_REFUSED');
  await expect(importSealedStaticMigration({ ...input, approval: { ...input.approval,
    sourceConfirmedOutOfBand: false as never } })).rejects.toThrow('SEALED_MIGRATION_REFUSED');
  await expect(importSealedStaticMigration({ ...input, serialized: serialized.replace('machine-a', 'machine-b') }))
    .rejects.toThrow('SEALED_MIGRATION_REFUSED');
  backend.slots.set(migrationStaticSlots('EXA_API_KEY')![0]!, 'existing-synthetic-value');
  await expect(importSealedStaticMigration(input)).rejects.toThrow('SEALED_MIGRATION_REFUSED');
  expect(backend.markers.size).toBe(0);
  expect(backend.slots.size).toBe(1);
  await expect(sealStaticMigration({ targetMachine: 'machine-a', targetKeyVersion: 2,
    targetPublicKey: first.publicKey, pinnedFingerprint: digest(sodium.crypto_box_keypair().publicKey),
    staticSecrets: { exa: fakeValue }, now: at })).rejects.toThrow('SEALED_MIGRATION_REFUSED');
  await expect(sealStaticMigration({ targetMachine: 'machine-a', targetKeyVersion: 2,
    targetPublicKey: first.publicKey, pinnedFingerprint: fingerprint,
    staticSecrets: { 'openai-codex': fakeValue }, now: at })).rejects.toThrow('SEALED_MIGRATION_REFUSED');
  await expect(sealStaticMigration({ targetMachine: 'machine-a', targetKeyVersion: 2,
    targetPublicKey: first.publicKey, pinnedFingerprint: fingerprint,
    staticSecrets: { ELANOUS_TELEGRAM_BOT_TOKEN: fakeValue }, now: at })).rejects.toThrow('SEALED_MIGRATION_REFUSED');
  const leakingBackend = { atomicBatchAndMarker: true as const,
    async commitEmptyStaticBatch(): Promise<'applied'> { throw new Error(fakeValue); } };
  try { await importSealedStaticMigration({ ...input, backend: leakingBackend });
    throw new Error('expected refusal');
  } catch (error) {
    expect(String(error)).toContain('SEALED_MIGRATION_REFUSED');
    expect(String(error)).not.toContain(fakeValue);
  }
});
