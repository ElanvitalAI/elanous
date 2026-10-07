import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSource, dueSources, listSources, removeSource, runDue, sourcesFile } from './intake-sources.js';
import { readStarSnapshots } from './collect-github.js';
import { ingestIntakeItems, listIntakeItems, markIntakeItem } from './items.js';

const now = new Date('2026-10-01T12:00:00.000Z');
function fixture(fn: (root: string) => Promise<void> | void) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'seat-intake-'));
    try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };
}

test('registry persists canonical seat, 0600 file, removal and due/expiration boundary', fixture((root) => {
  const mk = addSource({ id: 'mk', seat: 'T', kind: 'rss', spec: 'https://example.com/feed', every: '1h' }, root);
  expect(mk.seat).toBe('MK');
  expect(listSources({ seat: 'T' }, root)).toEqual([mk]);
  expect(statSync(sourcesFile(root)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(sourcesFile(root), 'utf8'))).toEqual([mk]);
  expect(dueSources(now, root).map((s) => s.id)).toEqual(['mk']);
  addSource({ id: 'expired', seat: 'UX', kind: 'rss', spec: 'https://example.com/feed', every: '1d', until: '2026-09-30' }, root);
  expect(dueSources(now, root).map((s) => s.id)).toEqual(['mk']);
  addSource({ id: 'boundary', seat: 'UX', kind: 'rss', spec: 'https://example.com/feed', every: '1d', until: '2026-10-02' }, root);
  expect(dueSources(new Date('2026-10-01T23:59:59Z'), root).map((s) => s.id)).toEqual(['mk', 'boundary']);
  expect(dueSources(new Date('2026-10-02T00:00:00Z'), root).map((s) => s.id)).toEqual(['mk']);
  expect(removeSource('mk', root)).toBe(true);
  expect(removeSource('mk', root)).toBe(false);
}));

test('one failed command does not stamp itself or prevent two other due sources; seat-filtered ledger excludes legacy', fixture(async (root) => {
  addSource({ id: 'bad', seat: 'MK', kind: 'command', spec: 'elanous fail-source', every: '1h' }, root);
  addSource({ id: 'good', seat: 'T', kind: 'command', spec: 'elanous intake items --json', every: '1h' }, root);
  addSource({ id: 'feed', seat: 'UX', kind: 'rss', spec: 'https://example.com/rss', every: '1h' }, root);
  const result = await runDue({ now, deps: {
    stateDir: root,
    runCommand: async (command) => { if (command === 'elanous fail-source') throw new Error('fake failure'); return '{"url":"https://example.com/mk","title":"MK"}\n'; },
    fetchFeed: async () => '<rss><channel><item><title>UX</title><link>https://example.com/ux</link><description>Body</description></item></channel></rss>',
  } });
  expect(result.ran).toEqual([{ id: 'bad', items: 0, error: 'fake failure' }, { id: 'good', items: 1 }, { id: 'feed', items: 1 }]);
  const saved = listSources({}, root);
  expect(saved.find((s) => s.id === 'bad')?.lastRunAt).toBeUndefined();
  expect(saved.filter((s) => s.id !== 'bad').map((s) => s.lastRunAt)).toEqual([now.toISOString(), now.toISOString()]);
  expect(listIntakeItems(root, { seat: 'MK' }).map((item) => item.url)).toEqual(['https://example.com/mk']);
  expect(listIntakeItems(root, { seat: 'UX' }).map((item) => ({ url: item.url, kind: item.kind }))).toEqual([{ url: 'https://example.com/ux', kind: 'rss' }]);
  ingestIntakeItems(root, 'memo', [{ text: 'legacy' }], now.toISOString(), () => {});
  expect(listIntakeItems(root)).toHaveLength(3);
  expect(listIntakeItems(root, { seat: 'MK' })).toHaveLength(1);
  expect(dueSources(new Date(now.getTime() + 3599_999), root).map((s) => s.id)).toEqual(['bad']);
  expect(dueSources(new Date(now.getTime() + 3600_000), root).map((s) => s.id)).toEqual(['bad', 'good', 'feed']);
}));

test('same URL keeps separate seat identities, same-seat sightings merge and legacy remains unassigned', fixture(async (root) => {
  const url = 'https://example.com/shared';
  const at = now.toISOString();
  ingestIntakeItems(root, 'rss', [{ url, title: 'Legacy' }], at, () => {});
  ingestIntakeItems(root, 'command', [{ url, seat: 'MK', title: 'First' }], at, () => {});
  ingestIntakeItems(root, 'rss', [{ url, seat: 'UX', title: 'Second' }], at, () => {});
  const secondMk = ingestIntakeItems(root, 'rss', [{ url, seat: 'MK', signals: { score: 7 } }], at, () => {});
  expect(secondMk.merged).toBe(1);
  const all = listIntakeItems(root);
  expect(all).toHaveLength(3);
  expect(new Set(all.map((item) => item.id)).size).toBe(3);
  expect(listIntakeItems(root, { seat: 'MK' })).toMatchObject([{
    seat: 'MK', title: 'First', sources: ['command', 'rss'], signals: { 'rss.score': 7 },
  }]);
  expect(listIntakeItems(root, { seat: 'UX' })).toMatchObject([{ seat: 'UX', title: 'Second', sources: ['rss'] }]);
  expect(all.filter((item) => !item.seat)).toMatchObject([{ title: 'Legacy', sources: ['rss'] }]);
  const mkId = listIntakeItems(root, { seat: 'MK' })[0]!.id;
  expect(markIntakeItem(root, mkId, { status: 'absorbed' }, at)).toBe(true);
  expect(listIntakeItems(root, { seat: 'MK' })[0]?.status).toBe('absorbed');
  expect(listIntakeItems(root, { seat: 'UX' })[0]?.status).toBe('new');
}));

test('ingest canonicalizes raw seat aliases before ID and merge, and rejects unknown seats without writing', fixture((root) => {
  const url = 'https://example.com/alias';
  const at = now.toISOString();
  const first = ingestIntakeItems(root, 'github', [{ seat: 'T', url, title: 'First' }], at, () => {});
  expect(first.added).toBe(1);
  const second = ingestIntakeItems(root, 'rss', [{ seat: 'MK', url, signals: { score: 3 } }], at, () => {});
  expect(second.merged).toBe(1);
  expect(listIntakeItems(root, { seat: 'MK' })).toMatchObject([{ seat: 'MK', title: 'First', sources: ['github', 'rss'] }]);
  expect(listIntakeItems(root)).toHaveLength(1);
  const before = readFileSync(join(root, 'intake', 'items.jsonl'), 'utf8');
  expect(() => ingestIntakeItems(root, 'rss', [{ seat: 'NOT-A-SEAT', url }], at, () => {})).toThrow('알 수 없는 자리');
  expect(readFileSync(join(root, 'intake', 'items.jsonl'), 'utf8')).toBe(before);
}));

test('user watch github query runs through runDue with user identity, not MK', fixture(async (root) => {
  addSource({ id: 'watch-agent', seat: 'user', kind: 'github-query', spec: 'topic:agent', every: '1d' }, root);
  addSource({ id: 'mk-agent', seat: 'MK', kind: 'github-query', spec: 'topic:marketing', every: '1d' }, root);
  const queries: string[] = [];
  const result = await runDue({ now, seat: 'user', deps: { stateDir: root, searchGithub: async (query) => {
    queries.push(query);
    return [{ fullName: 'example/agent', url: 'https://github.com/example/agent', description: 'Agent', stars: 7, createdAt: now.toISOString(), pushedAt: now.toISOString() }];
  } } });
  expect(result.ran).toEqual([{ id: 'watch-agent', items: 1 }]);
  expect(queries).toHaveLength(1);
  expect(listIntakeItems(root, { seat: 'user' })).toHaveLength(1);
  expect(listIntakeItems(root, { seat: 'MK' })).toHaveLength(0);
}));

test('github-query invokes exactly its own query, ingests the repo with its seat', fixture(async (root) => {
  addSource({ id: 'gh', seat: 'TC', kind: 'github-query', spec: 'topic:agent', every: '1w' }, root);
  const queries: string[] = [];
  const result = await runDue({ now, deps: { stateDir: root, searchGithub: async (query) => {
    queries.push(query);
    return [{ fullName: 'example/agent', url: 'https://github.com/example/agent', description: 'Agent', stars: 7, createdAt: now.toISOString(), pushedAt: now.toISOString() }];
  } } });
  expect(queries).toEqual(['topic:agent created:>=2026-09-01']);
  expect(result.ran).toEqual([{ id: 'gh', items: 1 }]);
  expect(listIntakeItems(root, { seat: 'TC' })[0]).toMatchObject({ seat: 'TC', kind: 'repo', signals: { 'github.stars': 7 } });
  expect(readStarSnapshots(root)).toEqual([{ day: '2026-10-01', repo: 'example/agent', stars: 7 }]);
}));

test('user-private command output fails without writing or stamping the source', fixture(async (root) => {
  addSource({ id: 'private-output', seat: 'MK', kind: 'command', spec: 'elanous emit-private', every: '1d' }, root);
  const result = await runDue({ now, deps: { stateDir: root, runCommand: async () => '{"text":"private","privacy":"user-private"}\n' } });
  expect(result.ran[0]?.error).toContain('user-private');
  expect(listSources({}, root)[0]?.lastRunAt).toBeUndefined();
  expect(listIntakeItems(root)).toEqual([]);
}));

test('real command executes argv without shell expansion and ingests JSONL with a seat', fixture(async (root) => {
  // The allow-list keys on the program name, so the real-exec fixture is a program named «elanous».
  const script = join(root, 'elanous');
  writeFileSync(script, '#!/bin/sh\nprintf "{\\"url\\":\\"https://example.com/executed\\"}\\n"\n');
  chmodSync(script, 0o700);
  addSource({ id: 'real', seat: 'MK', kind: 'command', spec: script, every: '1h' }, root);
  const result = await runDue({ now, deps: { stateDir: root } });
  expect(result.ran).toEqual([{ id: 'real', items: 1 }]);
  expect(listIntakeItems(root, { seat: 'MK' })).toMatchObject([{ seat: 'MK', url: 'https://example.com/executed' }]);
}));

test('private saved-message collector commands cannot be registered or executed through shell quoting', fixture(async (root) => {
  for (const spec of ['elanous intake collect-telegram-saved', "elanous intake collect-telegram-'saved'", 'sh -c collect-telegram-saved', 'bun scripts/private.ts', 'echo ok | elanous intake collect-telegram-saved']) {
    expect(() => addSource({ id: 'private', seat: 'MK', kind: 'command', spec, every: '1d' }, root)).toThrow();
  }
  expect(listSources({}, root)).toEqual([]);
  addSource({ id: 'safe', seat: 'MK', kind: 'command', spec: 'elanous emit-data', every: '1d' }, root);
  const file = sourcesFile(root);
  const sources = JSON.parse(readFileSync(file, 'utf8'));
  sources[0].spec = "elanous intake collect-telegram-'saved'";
  writeFileSync(file, JSON.stringify(sources));
  let invoked = false;
  const result = await runDue({ now, deps: { stateDir: root, runCommand: async () => { invoked = true; return ''; } } });
  expect(invoked).toBe(false);
  expect(result.ran[0]?.error).toBeTruthy();
  expect(listSources({}, root)[0]?.lastRunAt).toBeUndefined();
}));

test('only the elanous CLI can be a command source — other programs are refused at registration', fixture(async (root) => {
  for (const spec of ['nodejs scripts/private.ts', 'printf data', '/usr/bin/env elanous intake items', 'python3 -m collector']) {
    expect(() => addSource({ id: 'other', seat: 'MK', kind: 'command', spec, every: '1d' }, root)).toThrow('elanous CLI');
  }
  expect(listSources({}, root)).toEqual([]);
}));

test('an RSS answer that is not a feed fails and does not stamp the source', fixture(async (root) => {
  addSource({ id: 'login', seat: 'UX', kind: 'rss', spec: 'https://example.com/rss', every: '1h' }, root);
  const result = await runDue({ now, deps: { stateDir: root, fetchFeed: async () => '<!doctype html><html><body>Sign in</body></html>' } });
  expect(result.ran[0]?.error).toContain('RSS/Atom');
  expect(listSources({}, root)[0]?.lastRunAt).toBeUndefined();
  const atom = await runDue({ now, deps: { stateDir: root, fetchFeed: async () => '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><link href="https://example.com/a"/></entry></feed>' } });
  expect(atom.ran).toEqual([{ id: 'login', items: 1 }]);
}));
