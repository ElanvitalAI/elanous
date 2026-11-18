// HQ-VAULT V1 — metadata · encryption at rest · KEK via fixed keychain backend · inventory.
// Fake keychain runner, fake fs (inventory), fake clock. Only synthetic canary values.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliOpts, RunCli } from '../cli-helper.js';
import { createKeychainBackend } from '../keychain-backend.js';
import { openVaultValue, sealVaultValue } from './envelope.js';
import type { VaultEvent } from './events.js';
import { collectSecretInventory, renderSecretInventory, type InventoryFs, type InventoryStat } from './inventory.js';
import { createKeychainVaultKek, VAULT_KEK_SERVICE } from './kek.js';
import { readVaultMeta, sanitizeVaultItemMeta, vaultIndexPath } from './meta.js';
import { createVaultStore, vaultEnvelopePath } from './store.js';

const CANARY = 'CANARY-vault-v1-DO-NOT-LEAK-7f3a9c';
const CANARY_HEX = Buffer.from(CANARY, 'utf-8').toString('hex');

interface FakeKeychain { run: RunCli; argv: string[][]; stdin: string[]; items: Map<string, string> }

/** Fake `security`: `-i` takes `add-generic-password … -s <id> -X <hex>` on stdin; find/delete use argv. */
function fakeKeychain(opts: { failWrite?: boolean; echoStdinToStderr?: boolean } = {}): FakeKeychain {
  const argv: string[][] = [];
  const stdin: string[] = [];
  const items = new Map<string, string>();
  const run: RunCli = async (cmd: string[], cliOpts?: CliOpts) => {
    argv.push([...cmd]);
    if (cliOpts?.stdin !== undefined) stdin.push(cliOpts.stdin);
    if (cmd[1] === '-h') return { stdout: '', stderr: '', exitCode: 0 };
    if (cmd[1] === '-i') {
      const line = cliOpts?.stdin ?? '';
      const match = /^add-generic-password -U -a elanous -s (\S+) -X ([0-9a-f]+)\n$/.exec(line);
      if (!match || opts.failWrite) return { stdout: '', stderr: opts.echoStdinToStderr ? `bad: ${line}` : 'bad', exitCode: 0 };
      items.set(match[1]!, Buffer.from(match[2]!, 'hex').toString('utf-8'));
      return { stdout: 'security> ', stderr: '', exitCode: 0 };
    }
    const id = cmd[cmd.indexOf('-s') + 1] ?? '';
    if (cmd[1] === 'find-generic-password') {
      const value = items.get(id);
      return value === undefined ? { stdout: '', stderr: 'not found', exitCode: 44 } : { stdout: `${value}\n`, stderr: '', exitCode: 0 };
    }
    if (cmd[1] === 'delete-generic-password') return { stdout: '', stderr: '', exitCode: items.delete(id) ? 0 : 44 };
    return { stdout: '', stderr: 'unexpected', exitCode: 1 };
  };
  return { run, argv, stdin, items };
}

function fakeClock(start = '2026-11-17T00:00:00.000Z') {
  let t = Date.parse(start);
  return { now: () => new Date(t), advanceDays: (d: number) => { t += d * 86_400_000; } };
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'elanous-vault-v1-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function allFileBytes(dir: string): string {
  let out = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out += allFileBytes(path);
    else if (entry.isFile()) out += readFileSync(path, 'latin1');
  }
  return out;
}

describe('keychain backend: value never on argv (HQ-VAULT V1 fix)', () => {
  test('set sends the value hex-encoded over stdin and confirms by read-back', async () => {
    const kc = fakeKeychain();
    const backend = createKeychainBackend({ runCliImpl: kc.run, indexPath: join(root, 'kc.json'), platformOverride: 'darwin' });
    await backend.set('cred:demo.api_key', CANARY);
    expect(await backend.get('cred:demo.api_key')).toBe(CANARY);
    const flatArgv = kc.argv.flat().join('\u0000');
    expect(flatArgv).not.toContain(CANARY);
    expect(flatArgv.toLowerCase()).not.toContain(CANARY_HEX);
    expect(kc.argv.some((cmd) => cmd.includes('-w') && cmd[1] === 'add-generic-password')).toBe(false);
    expect(kc.stdin.join('')).not.toContain(CANARY);
    expect(kc.stdin.join('')).toContain(CANARY_HEX);
  });

  test('failed write throws without echoing the value (raw or hex)', async () => {
    const kc = fakeKeychain({ failWrite: true, echoStdinToStderr: true });
    const backend = createKeychainBackend({ runCliImpl: kc.run, indexPath: join(root, 'kc.json'), platformOverride: 'darwin' });
    let message = '';
    try { await backend.set('cred:demo.api_key', CANARY); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/keychain set failed/);
    expect(message).not.toContain(CANARY);
    expect(message.toLowerCase()).not.toContain(CANARY_HEX);
  });

  test('ids that would need quoting on the stdin command line are refused before spawn', async () => {
    const kc = fakeKeychain();
    const backend = createKeychainBackend({ runCliImpl: kc.run, indexPath: join(root, 'kc.json'), platformOverride: 'darwin' });
    await expect(backend.set('bad id -X 00', CANARY)).rejects.toThrow(/not stdin-safe/);
    expect(kc.argv).toHaveLength(0);
  });
});

describe('vault envelope', () => {
  const kek = Buffer.alloc(32, 7);

  test('round-trips and keeps no plaintext in the envelope', () => {
    const env = sealVaultValue(kek, 'cred:demo.api_key', 1, CANARY);
    const text = JSON.stringify(env);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(Buffer.from(CANARY).toString('base64'));
    expect(openVaultValue(kek, env, { itemId: 'cred:demo.api_key', generation: 1 })).toBe(CANARY);
  });

  test('tampering, item swap, generation rollback and a wrong KEK are refused', () => {
    const env = sealVaultValue(kek, 'cred:a.api_key', 2, CANARY);
    const flipped = { ...env, ciphertext: Buffer.from(Buffer.from(env.ciphertext, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64') };
    expect(() => openVaultValue(kek, flipped, { itemId: 'cred:a.api_key', generation: 2 })).toThrow('VAULT_ENVELOPE_AUTH_FAILED');
    expect(() => openVaultValue(kek, env, { itemId: 'cred:b.api_key', generation: 2 })).toThrow('VAULT_ENVELOPE_ITEM_MISMATCH');
    expect(() => openVaultValue(kek, { ...env, itemId: 'cred:b.api_key' }, { itemId: 'cred:b.api_key', generation: 2 })).toThrow('VAULT_ENVELOPE_AUTH_FAILED');
    expect(() => openVaultValue(kek, env, { itemId: 'cred:a.api_key', generation: 3 })).toThrow('VAULT_ENVELOPE_GENERATION_MISMATCH');
    expect(() => openVaultValue(Buffer.alloc(32, 9), env, { itemId: 'cred:a.api_key', generation: 2 })).toThrow('VAULT_ENVELOPE_AUTH_FAILED');
  });
});

describe('vault store', () => {
  function setup(opts: { writeAllowed?: boolean; platform?: string } = {}) {
    const kc = fakeKeychain();
    const clock = fakeClock();
    const events: VaultEvent[] = [];
    const vaultDir = join(root, 'vault');
    const kek = createKeychainVaultKek({ vaultDir, runCliImpl: kc.run, platformOverride: opts.platform ?? 'darwin' });
    const store = createVaultStore({ vaultDir, kek, now: clock.now, emit: (e) => events.push(e), writeAllowed: () => opts.writeAllowed ?? true });
    return { kc, clock, events, vaultDir, store };
  }

  test('canary: never in metadata file, on-disk bytes, events or keychain argv; modes are 0700/0600', async () => {
    const { kc, events, vaultDir, store, clock } = setup();
    await store.upsertMeta({ id: 'cred:demo.api_key', kind: 'static', provider: 'demo', ownerHost: 'MSHQ.local', allowedHosts: ['node-b', 'node-c', 'node-b'], rotateEveryDays: 30 });
    clock.advanceDays(1);
    const meta = await store.putValue('cred:demo.api_key', CANARY);
    expect(meta.generation).toBe(1);
    expect(meta.ownerHost).toBe('mshq');
    expect(meta.allowedHosts).toEqual(['node-c', 'node-b']);
    expect(meta.rotatedAt).toBe('2026-11-18T00:00:00.000Z');
    expect(await store.getValue('cred:demo.api_key')).toBe(CANARY);

    expect(readFileSync(vaultIndexPath(vaultDir), 'utf-8')).not.toContain(CANARY);
    const disk = allFileBytes(vaultDir);
    expect(disk).not.toContain(CANARY);
    expect(disk.toLowerCase()).not.toContain(CANARY_HEX);
    expect(JSON.stringify(events)).not.toContain(CANARY);
    const flatArgv = kc.argv.flat().join('\u0000');
    expect(flatArgv).not.toContain(CANARY);
    // The KEK itself lives only in the (fake) keychain and never rides argv either.
    const kekValue = kc.items.get(VAULT_KEK_SERVICE)!;
    expect(kekValue).toBeDefined();
    expect(flatArgv).not.toContain(kekValue);
    expect(disk).not.toContain(kekValue);

    expect(statSync(vaultDir).mode & 0o777).toBe(0o700);
    expect(statSync(vaultIndexPath(vaultDir)).mode & 0o777).toBe(0o600);
    expect(statSync(vaultEnvelopePath(vaultDir, 'cred:demo.api_key')).mode & 0o777).toBe(0o600);
    expect(events.map((e) => e.event)).toEqual(['meta.upsert', 'kek.create', 'store']);
    expect(events.every((e) => e.category === 'secret')).toBe(true);
  });

  test('rolled-back envelope (older generation copied back) is refused', async () => {
    const { vaultDir, store } = setup();
    await store.upsertMeta({ id: 'cred:demo.api_key', kind: 'static', provider: 'demo', ownerHost: 'mshq' });
    await store.putValue('cred:demo.api_key', `${CANARY}-1`);
    const path = vaultEnvelopePath(vaultDir, 'cred:demo.api_key');
    copyFileSync(path, join(root, 'old-envelope-vault-v1.json'));
    await store.putValue('cred:demo.api_key', `${CANARY}-2`);
    copyFileSync(join(root, 'old-envelope-vault-v1.json'), path);
    await expect(store.getValue('cred:demo.api_key')).rejects.toThrow('VAULT_ENVELOPE_GENERATION_MISMATCH');
  });

  test('HQ fence refuses writes and emits write.refused', async () => {
    const { events, store, vaultDir } = setup({ writeAllowed: false });
    await expect(store.upsertMeta({ id: 'cred:demo.api_key', kind: 'static', provider: 'demo', ownerHost: 'mshq' })).rejects.toThrow('VAULT_WRITE_REFUSED_HQ_FENCE');
    expect(readVaultMeta(vaultDir).items).toEqual([]);
    expect(events.map((e) => e.event)).toEqual(['write.refused']);
  });

  test('OAuth items are reference-only: metadata yes, value no', async () => {
    const { store } = setup();
    await store.upsertMeta({ id: 'oauth:codex:team', kind: 'oauth', provider: 'codex', ownerHost: 'mshq', allowedHosts: ['node-b'] });
    await expect(store.putValue('oauth:codex:team', CANARY)).rejects.toThrow('VAULT_OAUTH_IS_REFERENCE_ONLY');
    await expect(store.getValue('oauth:codex:team')).rejects.toThrow('VAULT_OAUTH_IS_REFERENCE_ONLY');
  });

  test('fail-closed off macOS: no value written, kek.unavailable emitted without detail', async () => {
    const { events, store, vaultDir } = setup({ platform: 'linux' });
    await store.upsertMeta({ id: 'cred:demo.api_key', kind: 'static', provider: 'demo', ownerHost: 'mshq' });
    await expect(store.putValue('cred:demo.api_key', CANARY)).rejects.toThrow('VAULT_KEK_UNAVAILABLE:keychain-unavailable');
    expect(readVaultMeta(vaultDir).items[0]!.generation).toBe(0);
    expect(allFileBytes(vaultDir)).not.toContain(CANARY);
    expect(events.at(-1)).toMatchObject({ event: 'kek.unavailable', level: 'warn', data: { reason: 'keychain-unavailable' } });
  });

  test('touch records lastUsedAt from the fake clock; remove deletes envelope and metadata', async () => {
    const { store, clock, vaultDir } = setup();
    await store.upsertMeta({ id: 'cred:demo.api_key', kind: 'static', provider: 'demo', ownerHost: 'mshq' });
    await store.putValue('cred:demo.api_key', CANARY);
    clock.advanceDays(3);
    expect((await store.touch('cred:demo.api_key')).lastUsedAt).toBe('2026-11-20T00:00:00.000Z');
    expect(await store.remove('cred:demo.api_key')).toBe(true);
    expect(readVaultMeta(vaultDir).items).toEqual([]);
    expect(() => statSync(vaultEnvelopePath(vaultDir, 'cred:demo.api_key'))).toThrow();
  });

  test('metadata sanitizer drops any field outside the closed list (a smuggled value never persists)', () => {
    const clean = sanitizeVaultItemMeta({ id: 'cred:demo.api_key', kind: 'static', provider: 'demo', ownerHost: 'mshq', allowedHosts: [],
      createdAt: '2026-11-17T00:00:00Z', value: CANARY, token: CANARY } as unknown);
    expect(JSON.stringify(clean)).not.toContain(CANARY);
  });
});

describe('inventory (fake fs: stat/readdir only)', () => {
  const HOME = '/home/fake';
  const CONFIG = '/home/fake/.elanous';
  const VAULT = '/home/fake/.elanous/vault';

  function stat(kind: 'file' | 'dir' | 'link', mode: number, uid = 501): InventoryStat {
    return { mode, uid, isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' };
  }

  function fakeFs(entries: Record<string, InventoryStat>, dirs: Record<string, string[]>) {
    const calls: string[] = [];
    const fs: InventoryFs & Record<string, unknown> = {
      lstat: (path) => { calls.push(`lstat:${path}`); return entries[path]; },
      readdir: (path) => { calls.push(`readdir:${path}`); const list = dirs[path]; if (!list) throw new Error('ENOENT'); return list; },
    };
    // Any attempt to open contents would need a method the seam does not have.
    for (const forbidden of ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream']) {
      Object.defineProperty(fs, forbidden, { get() { throw new Error(`inventory touched ${forbidden}`); } });
    }
    return { fs, calls };
  }

  test('flags plaintext, world/group readable, foreign owner, symlink, duplicate, expiry and rotation; no values', () => {
    const clock = fakeClock('2026-11-17T00:00:00.000Z');
    const envelope = (id: string) => vaultEnvelopePath(VAULT, id);
    const { fs, calls } = fakeFs({
      [`${HOME}/.cache/openai_api_key`]: stat('file', 0o100644),
      [`${HOME}/.cache/firecrawl_api_key`]: stat('file', 0o100600),
      [`${HOME}/.codex-team/auth.json`]: stat('file', 0o100640),
      [`${HOME}/.aws/credentials`]: stat('file', 0o100600, 0),
      [`${HOME}/.config/gh/hosts.yml`]: stat('link', 0o120777),
      [`${CONFIG}/secrets.json`]: stat('file', 0o100600),
      [envelope('cred:openai.api_key')]: stat('file', 0o100600),
    }, {
      [`${HOME}/.cache`]: ['openai_api_key', 'firecrawl_api_key', 'unrelated.txt'],
      [HOME]: ['.codex-team', '.cache', '.aws'],
    });
    const items = [
      { id: 'cred:openai.api_key', kind: 'static' as const, provider: 'openai', ownerHost: 'mshq', allowedHosts: ['node-b'], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', generation: 1, rotateEveryDays: 30 },
      { id: 'cred:gone.api_key', kind: 'static' as const, provider: 'gone', ownerHost: 'mshq', allowedHosts: [], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', generation: 2, expiresAt: '2026-11-10T00:00:00.000Z' },
      { id: 'oauth:codex:team', kind: 'oauth' as const, provider: 'codex', ownerHost: 'mshq', allowedHosts: ['node-b'], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', generation: 0, expiresAt: '2026-11-20T00:00:00.000Z' },
    ];
    const inv = collectSecretInventory({ home: HOME, configDir: CONFIG, vaultDir: VAULT, items, envelopePath: envelope, fs, now: clock.now(), uid: 501, host: 'mshq' });

    const ext = Object.fromEntries(inv.external.map((row) => [row.path, row]));
    expect(ext['~/.cache/openai_api_key']!.flags).toEqual(['plaintext-file', 'world-readable', 'group-readable', 'duplicate']);
    expect(ext['~/.cache/firecrawl_api_key']!.flags).toEqual(['plaintext-file']);
    expect(ext['~/.codex-team/auth.json']!).toMatchObject({ kind: 'oauth', provider: 'codex', mode: '0640', flags: ['plaintext-file', 'group-readable'] });
    expect(ext['~/.aws/credentials']!.flags).toEqual(['plaintext-file', 'not-owned-by-user']);
    expect(ext['~/.config/gh/hosts.yml']!.type).toBe('symlink');
    expect(ext['~/.elanous/secrets.json']!.location).toBe('elanous-file-backend');

    const vault = Object.fromEntries(inv.items.map((row) => [row.id, row]));
    expect(vault['cred:openai.api_key']!).toMatchObject({ presence: 'sealed', mode: '0600', flags: ['rotation-due', 'duplicate'] });
    expect(vault['cred:gone.api_key']!).toMatchObject({ presence: 'missing', flags: ['envelope-missing', 'expired'] });
    expect(vault['oauth:codex:team']!).toMatchObject({ presence: 'reference', flags: ['expiring'] });
    expect(inv.summary).toMatchObject({ items: 3, risky: 9 });

    expect(calls.every((call) => call.startsWith('lstat:') || call.startsWith('readdir:'))).toBe(true);
    const rendered = renderSecretInventory(inv).join('\n') + JSON.stringify(inv);
    expect(rendered).not.toContain(CANARY);
  });

  test('real files under a fake HOME: canary contents never appear in the inventory', () => {
    const home = join(root, 'home');
    const vaultDir = join(home, '.elanous', 'vault');
    const nodeFs: InventoryFs = {
      lstat: (path) => { try { return statSync(path); } catch { return undefined; } },
      readdir: (path) => readdirSync(path),
    };
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, '.cache'), { recursive: true });
    writeFileSync(join(home, '.cache', 'demo_api_key'), CANARY, { mode: 0o600 });
    chmodSync(join(home, '.cache', 'demo_api_key'), 0o604);
    const inv = collectSecretInventory({ home, configDir: join(home, '.elanous'), vaultDir, items: [], envelopePath: (id) => vaultEnvelopePath(vaultDir, id), fs: nodeFs, now: new Date(), uid: process.getuid?.() ?? -1, host: 'mshq' });
    expect(inv.external.map((row) => row.path)).toEqual(['~/.cache/demo_api_key']);
    expect(inv.external[0]!.flags).toContain('world-readable');
    expect(JSON.stringify(inv) + renderSecretInventory(inv).join('\n')).not.toContain(CANARY);
  });
});
