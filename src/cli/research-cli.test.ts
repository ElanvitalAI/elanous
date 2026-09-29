import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerResearchCommand } from './research-cli.js';
import { _resetWebSearchProvidersForTests, addWebSearchProvider, type WebSearchProvider } from '../web-search/index.js';
import { resetLiveDetailCacheForTesting, writeLiveDetail, liveDetailPath, readLiveDetail } from '../live/detail-switch.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
afterEach(() => {
  _resetWebSearchProvidersForTests();
  resetLiveDetailCacheForTesting();
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
  process.exitCode = 0;
});

function provider(id: string, calls: Array<{ id: string; query: string; limit?: number }>, error?: string): WebSearchProvider {
  return {
    id, displayName: id, available: () => true,
    search: async q => {
      calls.push({ id, query: q.query, limit: q.limit });
      if (error) throw new Error(error);
      return { providerName: id, durationMs: 1, hits: [{ url: `https://${id}.example/a`, title: `${id} title`, snippet: `${id} excerpt` }] };
    },
  };
}

function cli(maxDetailOn: () => boolean) {
  const output: string[] = [];
  const errors: string[] = [];
  const events: Array<{ category: string; event: string; data: any }> = [];
  const command = new Command().exitOverride();
  registerResearchCommand(command, {
    out: { log: line => output.push(line), error: line => errors.push(line) },
    maxDetailOn,
    log: (category, event, data) => { events.push({ category, event, data }); },
  });
  return {
    output, errors, events,
    run: (...args: string[]) => command.parseAsync(['node', 'elanous', 'research', ...args]),
  };
}

test('registry fan-out, --engines, --limit and human / JSON rendering', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: Array<{ id: string; query: string; limit?: number }> = [];
  addWebSearchProvider(provider('alpha', calls));
  addWebSearchProvider(provider('beta', calls));
  const c = cli(() => false);
  await c.run('hello', 'world', '--engines', 'BETA', '--limit', '3');
  expect(calls).toEqual([{ id: 'beta', query: 'hello world', limit: 3 }]);
  expect(c.output[0]).toContain('[beta title](https://beta.example/a)');
  await c.run('second', '--json');
  expect(calls.slice(1).map(v => v.id)).toEqual(['alpha', 'beta']);
  expect(JSON.parse(c.output[1]!)).toMatchObject({ query: 'second', metadata: { totalHits: 2, perEngine: { alpha: { hits: 1 }, beta: { hits: 1 } } } });
  expect(c.events.filter(e => e.category === 'research.query').map(e => e.data.engine)).toEqual(['beta', 'alpha', 'beta']);
  expect(c.events.filter(e => e.category === 'research.result').map(e => e.data.engine)).toEqual(['beta', 'alpha', 'beta']);
  expect(c.events.some(e => e.category === 'research.source')).toBe(false);
});

test('MAX-only per-source events use the live detail switch; summaries remain outside MAX', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: Array<{ id: string; query: string; limit?: number }> = [];
  addWebSearchProvider(provider('alpha', calls));
  const dir = mkdtempSync(join(tmpdir(), 'research-cli-'));
  dirs.push(dir);
  const path = liveDetailPath(dir);
  const c = cli(() => readLiveDetail({ path }) !== null);
  await c.run('before');
  expect(c.events.map(e => e.category)).toEqual(['research.query', 'research.result']);
  writeLiveDetail({ ttlMin: 1 }, { path });
  await c.run('during', '--json');
  expect(c.events.filter(e => e.category === 'research.source').map(e => e.data)).toEqual([
    { url: 'https://alpha.example/a', title: 'alpha title', engine: 'alpha', dedup: false },
  ]);
  writeLiveDetail({ ttlMin: 0 }, { path });
  await c.run('after');
  expect(c.events.filter(e => e.category === 'research.source')).toHaveLength(1);
  expect(c.events.filter(e => e.category === 'research.result')).toHaveLength(3);
});

test('MAX source events flag duplicate URLs across providers', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: Array<{ id: string; query: string; limit?: number }> = [];
  addWebSearchProvider(provider('alpha', calls));
  addWebSearchProvider({ ...provider('beta', calls), search: async q => {
    calls.push({ id: 'beta', query: q.query, limit: q.limit });
    return { providerName: 'beta', durationMs: 1, hits: [{ url: 'https://alpha.example/a', title: 'same URL', snippet: '' }] };
  } });
  const c = cli(() => true);
  await c.run('topic');
  expect(c.events.filter(e => e.category === 'research.source').map(e => e.data.dedup)).toEqual([false, true]);
});

test('provider failures stay visible in result events without failing other engines', async () => {
  _resetWebSearchProvidersForTests(false);
  const calls: Array<{ id: string; query: string; limit?: number }> = [];
  addWebSearchProvider(provider('broken', calls, 'rate limited'));
  addWebSearchProvider(provider('working', calls));
  const c = cli(() => false);
  await c.run('test', '--json');
  expect(JSON.parse(c.output[0]!).metadata).toMatchObject({ totalHits: 1, perEngine: { broken: { hits: 0, error: 'rate limited' }, working: { hits: 1 } } });
  expect(c.events.filter(e => e.category === 'research.result').map(e => e.data.hits)).toEqual([0, 1]);
});

test('invalid engine and limit do not dispatch; unavailable registry reports zero hits', async () => {
  _resetWebSearchProvidersForTests(false);
  const c = cli(() => false);
  await c.run('topic', '--engines', 'not-registered');
  expect(process.exitCode).toBe(2);
  expect(c.errors[0]).toContain('not-registered');
  process.exitCode = 0;
  await c.run('topic', '--limit', '0');
  expect(process.exitCode).toBe(2);
  process.exitCode = 0;
  await c.run('topic', '--json');
  expect(JSON.parse(c.output[0]!).metadata.totalHits).toBe(0);
  expect(c.events.filter(e => e.category === 'research.result')).toHaveLength(1);
});
