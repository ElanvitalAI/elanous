import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { currentBackendId, useBackend, getSecretAsync, listCredentialSlotsAsync } from '../nexus/config/secrets/index.js';
import { readFirecrawlKey } from '../agent/firecrawl-plugin.js';
import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { configureFirecrawlKey, readStoredFirecrawlKey } from './firecrawl-key.js';
import { registerSetupCommand } from '../cli/setup-cli.js';

const KEY = 'synthetic-private-firecrawl-key';
test('masked setup writes only canonical secret id and prints no key or prefix', async () => {
  const output: string[] = [];
  const writes: string[][] = [];
  const result = await configureFirecrawlKey({ promptSecret: async () => KEY, print: x => output.push(x), setSecret: async (id, value) => { writes.push([id, value]); } });
  expect(result).toBe('saved');
  expect(writes).toEqual([['cred:firecrawl.api_key', KEY]]);
  expect(output.join('\n')).not.toContain(KEY);
  expect(output.join('\n')).not.toContain(KEY.slice(0, 4));
});
test('Enter skips without writing and points to resumable setup', async () => {
  const output: string[] = [];
  const result = await configureFirecrawlKey({ promptSecret: async () => '', print: x => output.push(x), setSecret: async () => { throw new Error('must not write'); } });
  expect(result).toBe('skipped');
  expect(output.join('\n')).toContain('elanous setup firecrawl');
});
test('backend rejection never prints its sensitive exception', async () => {
  const output: string[] = [];
  expect(await configureFirecrawlKey({ promptSecret: async () => KEY, print: x => output.push(x), setSecret: async () => { throw new Error(KEY); } })).toBe('failed');
  expect(output.join('\n')).not.toContain(KEY);
});
test('setup firecrawl command uses secret prompt, no ordinary prompt or config writes', async () => {
  const output: string[] = [];
  const writes: string[][] = [];
  const exits: number[] = [];
  const program = new Command();
  registerSetupCommand(program, {
    isStdinTty: () => true,
    prompt: async () => { throw new Error('ordinary prompt forbidden'); },
    promptSecret: async () => KEY,
    setCredentialSlotAsync: async (id, value) => { writes.push([id, value]); },
    saveUserConfig: () => { throw new Error('plaintext forbidden'); },
    out: { log: x => output.push(x), error: x => output.push(x) }, setExitCode: x => exits.push(x),
  });
  await program.parseAsync(['setup', 'firecrawl'], { from: 'user' });
  expect(exits).toEqual([0]);
  expect(writes).toEqual([['cred:firecrawl.api_key', KEY]]);
  expect(output.join('\n')).not.toContain(KEY);
});
test('setup firecrawl refuses piped input before prompt or secret access', async () => {
  const exits: number[] = [];
  const program = new Command();
  registerSetupCommand(program, {
    isStdinTty: () => false,
    promptSecret: async () => { throw new Error('must not prompt'); },
    setCredentialSlotAsync: async () => { throw new Error('must not write'); },
    out: { log: () => undefined, error: () => undefined }, setExitCode: x => exits.push(x),
  });
  await program.parseAsync(['setup', 'firecrawl'], { from: 'user' });
  expect(exits).toEqual([1]);
});

test('canonical Firecrawl storage wins and legacy storage is read only fallback', async () => {
  const reads: string[] = [];
  expect(await readStoredFirecrawlKey(async id => { reads.push(id); return id.startsWith('cred:') ? 'synthetic-canonical' : 'synthetic-legacy'; }))
    .toBe('synthetic-canonical');
  expect(reads).toEqual(['cred:firecrawl.api_key']);
  expect(await readStoredFirecrawlKey(async id => id === 'FIRECRAWL_API_KEY' ? 'synthetic-legacy' : undefined)).toBe('synthetic-legacy');
  await expect(readStoredFirecrawlKey(async () => { throw new Error('backend-unavailable'); })).rejects.toThrow('backend-unavailable');
});

test('default setup uses typed slot writer and runtime reads it without creating the legacy slot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'firecrawl-typed-slot-'));
  const prior = currentBackendId();
  const output: string[] = [];
  try {
    setElanousConfigDir(root); useBackend('file');
    expect(await configureFirecrawlKey({ promptSecret: async () => KEY, print: x => output.push(x) })).toBe('saved');
    expect(await getSecretAsync('cred:firecrawl.api_key')).toBe(KEY);
    expect(await getSecretAsync('FIRECRAWL_API_KEY')).toBeUndefined();
    expect(await readFirecrawlKey()).toBe(KEY);
    expect((await listCredentialSlotsAsync()).find(x => x.id === 'cred:firecrawl.api_key')?.present).toBe(true);
    expect(output.join('\n')).not.toContain(KEY);
  } finally { useBackend(prior); resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});
