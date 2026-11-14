import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { Command } from 'commander';
import sodium from 'libsodium-wrappers';
import { migrationStaticSlots } from './credentials-migration-bundle.js';
import { registerSealedMoveCommand, type SealedMoveCliDeps } from './credentials-migration-sealed-move.js';
import type { AtomicSealedStaticBackend } from './credentials-migration-sealed.js';
import { registerSecretCommands } from './secret-cli.js';

const synthetic = 'synthetic-only-static-value';
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

class FakeAtomicBackend implements AtomicSealedStaticBackend {
  readonly atomicBatchAndMarker = true;
  readonly slots = new Map<string, string>();
  readonly markers = new Map<string, string>();
  async commitEmptyStaticBatch(input: { bundleId: string; envelopeSha256: string;
    staticSecrets: Readonly<Record<string, string>> }): Promise<'applied' | 'already-applied' | 'conflict'> {
    const marker = this.markers.get(input.bundleId);
    const entries = Object.entries(input.staticSecrets).flatMap(([id, value]) =>
      (migrationStaticSlots(id) ?? []).map((slot) => [slot, value] as const));
    if (marker !== undefined) {
      if (marker !== input.envelopeSha256 || entries.some(([slot, value]) => this.slots.get(slot) !== value)) return 'conflict';
      return 'already-applied';
    }
    if (entries.some(([slot]) => this.slots.has(slot))) return 'conflict';
    for (const [slot, value] of entries) this.slots.set(slot, value);
    this.markers.set(input.bundleId, input.envelopeSha256);
    return 'applied';
  }
}

async function run(args: string[], deps: SealedMoveCliDeps): Promise<{ logs: string[]; errors: string[]; exits: number[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const program = new Command('eln');
  registerSealedMoveCommand(program.command('secret'), { ...deps,
    output: { log: (line) => logs.push(line), error: (line) => errors.push(line) },
    setExitCode: (code) => exits.push(code) });
  await program.parseAsync(['secret', 'move', ...args], { from: 'user' });
  return { logs, errors, exits };
}

const exportArgs = (machine: string, fingerprint: string) => ['--to', machine, '--out', '/synthetic/sealed.bundle',
  '--public-key', '/synthetic/public.key', '--fingerprint', fingerprint, '--key-version', '1'];
const importArgs = (machine: string, fingerprint: string, envelopeSha: string) => ['--to', machine,
  '--in', '/synthetic/sealed.bundle', '--public-key', '/synthetic/public.key', '--private-key', '/synthetic/private.key',
  '--fingerprint', fingerprint, '--key-version', '1', '--approve-sha256', envelopeSha];

test('two fake machine universes export and import sealed static values with typed confirmation', async () => {
  await sodium.ready;
  const worlds = [sodium.crypto_box_keypair(), sodium.crypto_box_keypair()];
  for (const [index, receiver] of worlds.entries()) {
    const machine = `fake-machine-${index + 1}`;
    const fingerprint = digest(receiver.publicKey);
    let artifact = '';
    let readValue = 0;
    const exported = await run(exportArgs(machine, fingerprint), {
      isInteractive: () => true, initializeBackend: () => {},
      readPublicKey: () => receiver.publicKey,
      listSecrets: async () => ['exa', 'ELANOUS_TELEGRAM_BOT_TOKEN'],
      getSecret: async (id) => { readValue++; return id === 'exa' ? synthetic : undefined; },
      confirm: async () => machine,
      writeBundle: (_path, serialized) => { artifact = serialized; },
    });
    expect(exported.exits).toEqual([0]);
    expect(exported.errors).toEqual([]);
    expect(readValue).toBe(1);
    expect(artifact).not.toContain(synthetic);
    expect(artifact).not.toContain('exa');
    const backend = new FakeAtomicBackend();
    const imported = await run(importArgs(machine, fingerprint, digest(artifact)), {
      isInteractive: () => true, readPublicKey: () => receiver.publicKey,
      readPrivateKey: () => receiver.privateKey, readBundle: () => artifact,
      backend: () => backend, confirm: async () => digest(artifact),
    });
    expect(imported.exits).toEqual([0]);
    expect(imported.errors).toEqual([]);
    expect(backend.slots.get(migrationStaticSlots('exa')![0]!)).toBe(synthetic);
    expect((await run(importArgs(machine, fingerprint, digest(artifact)), {
      isInteractive: () => true, readPublicKey: () => receiver.publicKey,
      readPrivateKey: () => receiver.privateKey, readBundle: () => artifact,
      backend: () => backend, confirm: async () => digest(artifact),
    })).logs[0]).toContain('already-applied');
    expect([...exported.logs, ...imported.logs].join(' ')).not.toContain(synthetic);
  }
});

test('manual refusal, wrong target and missing atomic backend do not read or write secret values', async () => {
  await sodium.ready;
  const receiver = sodium.crypto_box_keypair();
  const fingerprint = digest(receiver.publicKey);
  let valueReads = 0;
  const declined = await run(exportArgs('fake-machine', fingerprint), {
    isInteractive: () => true, initializeBackend: () => {},
    readPublicKey: () => receiver.publicKey, listSecrets: async () => ['exa'],
    getSecret: async () => { valueReads++; return synthetic; }, confirm: async () => 'wrong-machine',
    writeBundle: () => { throw new Error('must not write'); },
  });
  expect(declined.exits).toEqual([1]);
  expect(valueReads).toBe(0);
  let artifact = '';
  await run(exportArgs('fake-machine', fingerprint), {
    isInteractive: () => true, initializeBackend: () => {}, readPublicKey: () => receiver.publicKey,
    listSecrets: async () => ['exa'], getSecret: async () => synthetic, confirm: async () => 'fake-machine',
    writeBundle: (_path, serialized) => { artifact = serialized; },
  });
  const unsupported = await run(importArgs('fake-machine', fingerprint, digest(artifact)), {
    isInteractive: () => true, readPublicKey: () => receiver.publicKey,
    readPrivateKey: () => receiver.privateKey, readBundle: () => artifact,
    backend: () => undefined, confirm: async () => digest(artifact),
  });
  expect(unsupported.exits).toEqual([1]);
  const wrongTarget = await run(importArgs('other-machine', fingerprint, digest(artifact)), {
    isInteractive: () => true, readPublicKey: () => receiver.publicKey,
    readPrivateKey: () => receiver.privateKey, readBundle: () => artifact,
    backend: () => new FakeAtomicBackend(), confirm: async () => digest(artifact),
  });
  expect(wrongTarget.exits).toEqual([1]);
  expect([...declined.errors, ...unsupported.errors, ...wrongTarget.errors].join(' ')).not.toContain(synthetic);
});

test('root secret registrar exposes the move command exactly once', () => {
  const program = new Command('eln');
  registerSecretCommands(program);
  const secret = program.commands.find((command) => command.name() === 'secret');
  expect(secret?.commands.filter((command) => command.name() === 'move')).toHaveLength(1);
});

test('synthetic file path uses exclusive 0600 bundle and private receiver key', async () => {
  await sodium.ready;
  const receiver = sodium.crypto_box_keypair();
  const fingerprint = digest(receiver.publicKey);
  const root = mkdtempSync(join(tmpdir(), 'sealed-move-fake-'));
  try {
    const publicPath = join(root, 'public.key');
    const privatePath = join(root, 'private.key');
    const bundlePath = join(root, 'sealed.bundle');
    writeFileSync(publicPath, Buffer.from(receiver.publicKey).toString('base64'), { mode: 0o644 });
    writeFileSync(privatePath, Buffer.from(receiver.privateKey).toString('base64'), { mode: 0o600 });
    const exportOptions = ['--to', 'fake-file-machine', '--out', bundlePath,
      '--public-key', publicPath, '--fingerprint', fingerprint, '--key-version', '1'];
    const exported = await run(exportOptions, { isInteractive: () => true, initializeBackend: () => {},
      listSecrets: async () => ['exa'], getSecret: async () => synthetic, confirm: async () => 'fake-file-machine' });
    expect(exported.exits).toEqual([0]);
    expect(statSync(bundlePath).mode & 0o777).toBe(0o600);
    const artifact = readFileSync(bundlePath, 'utf8');
    expect(artifact).not.toContain(synthetic);
    const backend = new FakeAtomicBackend();
    const importOptions = ['--to', 'fake-file-machine', '--in', bundlePath, '--public-key', publicPath,
      '--private-key', privatePath, '--fingerprint', fingerprint, '--key-version', '1',
      '--approve-sha256', digest(artifact)];
    const imported = await run(importOptions, { isInteractive: () => true,
      backend: () => backend, confirm: async () => digest(artifact) });
    expect(imported.exits).toEqual([0]);
    expect(backend.slots.get(migrationStaticSlots('exa')![0]!)).toBe(synthetic);
    const again = await run(exportOptions, { isInteractive: () => true, initializeBackend: () => {},
      listSecrets: async () => ['exa'], getSecret: async () => synthetic, confirm: async () => 'fake-file-machine' });
    expect(again.exits).toEqual([1]);
    expect(readFileSync(bundlePath, 'utf8')).toBe(artifact);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
