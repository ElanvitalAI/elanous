// HQ-VAULT V1 · `eln secret inventory` CLI — fake fs, fake clock, captured events; canary never printed.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSecretInventoryCommand } from './secret-inventory-cli.js';
import type { InventoryFs, InventoryStat } from '../nexus/config/secrets/vault/inventory.js';
import type { VaultEvent } from '../nexus/config/secrets/vault/events.js';

const CANARY = 'CANARY-vault-v1-cli-DO-NOT-LEAK-41d2';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'elanous-vault-v1-cli-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function file(mode: number): InventoryStat {
  return { mode, uid: 501, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
}

async function run(args: string[], vaultDir: string, fs: InventoryFs) {
  const lines: string[] = [];
  const errors: string[] = [];
  const events: VaultEvent[] = [];
  let code: number | undefined;
  const program = new Command().exitOverride();
  const secret = program.command('secret');
  registerSecretInventoryCommand(secret, {
    home: '/home/fake', configDir: '/home/fake/.elanous', vaultDir, fs, uid: 501, host: 'mshq',
    now: () => new Date('2026-11-17T00:00:00.000Z'),
    emit: (event) => events.push(event),
    output: { log: (line) => lines.push(line), error: (line) => errors.push(line) },
    setExitCode: (value) => { code = value; },
  });
  await program.parseAsync(['node', 'eln', 'secret', 'inventory', ...args]);
  return { lines, errors, events, code };
}

const fs: InventoryFs = {
  lstat: (path) => (path === '/home/fake/.cache/demo_api_key' ? file(0o100644) : undefined),
  readdir: (path) => { if (path === '/home/fake/.cache') return ['demo_api_key']; throw new Error('ENOENT'); },
};

test('--json lists vault metadata and external stats, emits secret/inventory with counts only', async () => {
  const vaultDir = join(root, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  writeFileSync(join(vaultDir, 'index.json'), JSON.stringify({ version: 1, items: [
    { id: 'cred:demo.api_key', kind: 'static', provider: 'demo', ownerHost: 'mshq', allowedHosts: ['node-b'], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', generation: 0 },
  ] }));
  const result = await run(['--json'], vaultDir, fs);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.lines.join('\n'));
  expect(parsed.items[0]).toMatchObject({ id: 'cred:demo.api_key', presence: 'empty', allowedHosts: ['node-b'] });
  expect(parsed.external[0]).toMatchObject({ path: '~/.cache/demo_api_key', mode: '0644', flags: ['plaintext-file', 'world-readable', 'group-readable'] });
  expect(result.events).toEqual([{ ts: '2026-11-17T00:00:00.000Z', category: 'secret', event: 'inventory', level: 'warn',
    data: { items: 1, external: 1, risky: 1, flags: { 'plaintext-file': 1, 'world-readable': 1, 'group-readable': 1 } } }]);
});

test('text output carries no value even when the vault directory holds a canary-bearing stray file', async () => {
  const vaultDir = join(root, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  writeFileSync(join(vaultDir, 'stray-vault-v1.txt'), CANARY);
  const result = await run([], vaultDir, fs);
  expect(result.code).toBe(0);
  expect(result.lines[0]).toContain('values=0');
  expect([...result.lines, ...result.errors, JSON.stringify(result.events)].join('\n')).not.toContain(CANARY);
});

test('unreadable metadata fails with a code, not file contents', async () => {
  const vaultDir = join(root, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  writeFileSync(join(vaultDir, 'index.json'), `not json ${CANARY}`);
  const result = await run([], vaultDir, fs);
  expect(result.code).toBe(1);
  expect(result.errors.join('\n')).toContain('VAULT_META_UNREADABLE');
  expect([...result.lines, ...result.errors, JSON.stringify(result.events)].join('\n')).not.toContain(CANARY);
});
