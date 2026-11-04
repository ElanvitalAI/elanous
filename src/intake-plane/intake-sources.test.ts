import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSource, dueSources, listSources, removeSource, runDue, sourcesFile, syncBriefingTopicSource, syncStarterTopicRssSources } from './intake-sources.js';
import { readStarSnapshots } from './collect-github.js';
import { ingestIntakeItems, listIntakeItems, markIntakeItem } from './items.js';
import { loadIntakeLedger } from './items.js';
import { BriefItemsLedger, type AddBriefItem } from '../briefing/brief-items.js';

const now = new Date('2026-10-01T12:00:00.000Z');

test('configured briefing topic creates and updates one recurring RSS source without replacing other sources', fixture((root) => {
  const other = addSource({ id: 'existing', seat: 'OP', kind: 'rss', spec: 'https://example.com/op.xml', every: '1d' }, root);
  const topic = '2027 사업계획: 호르무즈·중간선거 이후 원가·환율·물류';
  const source = syncBriefingTopicSource(topic, root)!;
  expect(source).toMatchObject({ id: 'intake-briefing-topic-config', seat: 'user', kind: 'rss', every: '1d', why: 'intake.briefingTopic' });
  expect(decodeURIComponent(source.spec)).toContain('호르무즈 원가 OR 호르무즈 환율 OR 호르무즈 물류 OR 중간선거 원가 OR 중간선거 환율 OR 중간선거 물류');
  expect(decodeURIComponent(source.spec)).not.toContain('중간선거 중간선거');
  expect(syncBriefingTopicSource(topic, root)).toEqual(source);
  expect(syncBriefingTopicSource('다음 주제', root)?.spec).not.toBe(source.spec);
  expect(syncBriefingTopicSource(undefined, root)).toBeUndefined();
  expect(listSources({}, root).map(({ id }) => id)).toEqual(['existing']);
  expect(other.id).toBe('existing');
}));

test('RSS collection records distinct publishers from the fetched result for the briefing card', fixture(async (root) => {
  const source = syncBriefingTopicSource('토픽 하나', root)!;
  const feed = '<rss><channel><item><title>A</title><link>https://one.example/a</link><source>One News</source></item><item><title>B</title><link>https://two.example/b</link><source>Two News</source></item></channel></rss>';
  const result = await runDue({ now, seat: 'user', sourceId: source.id, deps: { stateDir: root, fetchFeed: async () => feed } });
  expect(result.ran).toEqual([{ id: source.id, items: 2 }]);
  expect(listSources({ seat: 'user' }, root).find((entry) => entry.id === source.id)).toMatchObject({ lastSourceCount: 2, briefingTopic: '토픽 하나' });
  expect(loadIntakeLedger(root).items.size).toBe(2);
}));

test('overlapping topic fetches preserve both topic memberships and never stamp old results onto new source', fixture(async (root) => {
  const source = syncBriefingTopicSource('이전 토픽', root)!;
  let releaseOld!: (xml: string) => void;
  const oldFeed = new Promise<string>((resolve) => { releaseOld = resolve; });
  const oldRun = runDue({ now, seat: 'user', sourceId: source.id, deps: { stateDir: root, fetchFeed: () => oldFeed } });
  syncBriefingTopicSource('새 토픽', root);
  const newRun = await runDue({ now: new Date(now.getTime() + 1_000), seat: 'user', sourceId: source.id, deps: { stateDir: root,
    fetchFeed: async () => '<rss><channel><item><title>공통 자료</title><link>https://shared.example/a</link><source>Shared News</source></item></channel></rss>' } });
  releaseOld('<rss><channel><item><title>공통 자료</title><link>https://shared.example/a</link><source>Shared News</source></item></channel></rss>');
  await oldRun;
  expect(newRun.ran[0]).toMatchObject({ id: source.id, items: 1 });
  const current = listSources({ seat: 'user' }, root).find((entry) => entry.id === source.id)!;
  expect(current).toMatchObject({ briefingTopic: '새 토픽', lastRunAt: new Date(now.getTime() + 1_000).toISOString() });
  const item = [...loadIntakeLedger(root).items.values()].find((entry) => entry.url === 'https://shared.example/a');
  expect(item?.briefingTopics).toEqual(['새 토픽', '이전 토픽']);
}));

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

test('starter topics reconcile to stable RSS sources idempotently and remove only managed entries', fixture((root) => {
  addSource({ id: 'manual', seat: 'MK', kind: 'rss', spec: 'https://example.com/feed', every: '1h' }, root);
  const first = syncStarterTopicRssSources(['agents', 'bun', 'agents', '  '], root);
  expect(first).toHaveLength(2);
  expect(first[0]).toMatchObject({ id: expect.stringMatching(/^starter-rss-/), seat: 'user', kind: 'rss', every: '1d', why: 'starter.topics', managedBy: 'starter.topics' });
  expect(new URL(first[0]!.spec).searchParams.get('q')).toBe('agents');
  const afterFirst = readFileSync(sourcesFile(root), 'utf8');
  syncStarterTopicRssSources(['agents', 'bun'], root);
  expect(readFileSync(sourcesFile(root), 'utf8')).toBe(afterFirst);
  expect(listSources({}, root)).toHaveLength(3);
  syncStarterTopicRssSources(['bun'], root);
  expect(listSources({}, root).map(source => source.id)).toEqual(['manual', first[1]!.id]);
}));

test('starter RSS reconciliation preserves a manual ID collision and dry-run leaves the registry unchanged', fixture((root) => {
  const managed = syncStarterTopicRssSources(['agents'], root)[0]!;
  removeSource(managed.id, root);
  const manual = addSource({ id: managed.id, seat: 'MK', kind: 'rss', spec: 'https://example.com/manual', every: '1h', why: 'starter.topics' }, root);
  const before = readFileSync(sourcesFile(root), 'utf8');
  const planned = syncStarterTopicRssSources(['agents'], root, { dryRun: true });
  expect(planned[0]!.id).not.toBe(manual.id);
  expect(listSources({}, root)).toEqual([manual]);
  expect(readFileSync(sourcesFile(root), 'utf8')).toBe(before);
  syncStarterTopicRssSources([], root);
  expect(listSources({}, root)).toEqual([manual]);
}));

test('starter RSS sync never claims an unmarked source, even when its legacy shape matches', fixture((root) => {
  const topic = 'legacy topic';
  const id = `starter-rss-${createHash('sha256').update(topic).digest('hex').slice(0, 12)}`;
  const feed = new URL('https://news.google.com/rss/search');
  feed.searchParams.set('q', topic);
  feed.searchParams.set('hl', 'en-US');
  feed.searchParams.set('gl', 'US');
  feed.searchParams.set('ceid', 'US:en');
  addSource({ id, seat: 'user', kind: 'rss', spec: feed.toString(), every: '1d', why: 'starter.topics' }, root);
  addSource({ id: 'manual', seat: 'user', kind: 'rss', spec: 'https://example.com/feed', every: '1d', why: 'starter.topics' }, root);
  const planned = syncStarterTopicRssSources([topic], root);
  expect(planned[0]).toMatchObject({ managedBy: 'starter.topics' });
  expect(planned[0]!.id).not.toBe(id);
  expect(listSources({}, root).map(source => source.id)).toEqual([id, 'manual', planned[0]!.id]);
  syncStarterTopicRssSources([], root);
  expect(listSources({}, root).map(source => source.id)).toEqual([id, 'manual']);
}));

test('starter RSS sync replaces only the legacy watch GitHub rows that main actually generated', fixture((root) => {
  const topic = 'agents';
  const watchId = `watch-${createHash('sha256').update(topic).digest('hex').slice(0, 12)}`;
  addSource({ id: watchId, seat: 'user', kind: 'github-query', spec: topic, every: '1d', why: 'starter.topics' }, root);
  const manual = addSource({ id: 'manual-rss', seat: 'user', kind: 'rss', spec: 'https://example.com/feed', every: '1d', why: 'starter.topics' }, root);
  const rss = syncStarterTopicRssSources([topic], root)[0]!;
  expect(listSources({}, root)).toEqual([manual, rss]);
  syncStarterTopicRssSources([], root);
  expect(listSources({}, root)).toEqual([manual]);
}));

test('topic-search runs the research bridge seam, keeps parent Linear UUID in subscription/intake/brief, and stamps success', fixture(async (root) => {
  const linearIssueId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const source = addSource({ id: 'topic-linear', seat: 'MK', kind: 'topic-search', spec: 'battery storage', every: '1d',
    scheduleCron: '0 8 * * *', linearIssueId }, root);
  expect(listSources({}, root)[0]).toMatchObject({ kind: 'topic-search', linearIssueId });
  const briefInputs: AddBriefItem[] = [];
  const projected: Array<{ id: string; items: number }> = [];
  const result = await runDue({ now, seat: 'MK', deps: {
    stateDir: root,
    searchTopic: async (topic) => {
      expect(topic).toBe('battery storage');
      return Array.from({ length: 5 }, (_, index) => ({ url: `https://example.com/storage-${index + 1}`,
        title: `Storage outlook ${index + 1}`, text: 'Demand rising', kind: 'article' as const }));
    },
    addBriefItem: (input) => briefInputs.push(input),
    projectTopicBriefing: async (registered, items) => { projected.push({ id: registered.id, items: items.length }); },
  } });
  expect(result.ran).toEqual([{ id: source.id, items: 5 }]);
  expect([...loadIntakeLedger(root).items.values()]).toHaveLength(5);
  expect([...loadIntakeLedger(root).items.values()][0]).toMatchObject({ source: 'topic-search', linearIssueId, seat: 'MK' });
  expect(briefInputs).toHaveLength(5);
  expect(briefInputs[0]).toMatchObject({ domain: '흡수', source: 'intake.topic-search:topic-linear', linearIssueId,
    evidence: 'https://example.com/storage-1' });
  // Test addBriefItem is a sink-only seam; production ledger projections are exercised with the concrete ledger below.
  expect(projected).toEqual([]);
  expect(listSources({}, root)[0]?.lastRunAt).toBe(now.toISOString());
}));

test('topic-search only accepts parent Linear UUID metadata', fixture((root) => {
  expect(() => addSource({ id: 'bad-id', seat: 'MK', kind: 'topic-search', spec: 'topic', every: '1d', scheduleCron: '0 8 * * *', linearIssueId: 'ENG-123' }, root))
    .toThrow('부모 Linear issue UUID');
  expect(() => addSource({ id: 'wrong-kind', seat: 'MK', kind: 'rss', spec: 'https://example.com/feed', every: '1d',
    linearIssueId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }, root)).toThrow('부모 Linear issue UUID');
  expect(listSources({}, root)).toEqual([]);
}));

test('topic-search projects the persisted issue-linked briefing items after each scheduled source run', fixture(async (root) => {
  const linearIssueId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  addSource({ id: 'topic-project', seat: 'MK', kind: 'topic-search', spec: 'HBM', every: '1w',
    scheduleCron: '0 8 * * 1', linearIssueId }, root);
  let projected: import('../briefing/brief-items.js').BriefItem[] = [];
  const result = await runDue({ now, sourceId: 'topic-project', deps: { stateDir: root,
    searchTopic: async () => [{ url: 'https://example.com/hbm', title: 'HBM order cut', text: 'Order cut announced' }],
    projectTopicBriefing: async (_source, items) => { projected = [...items]; },
  } });
  expect(result.ran).toEqual([{ id: 'topic-project', items: 1 }]);
  expect(projected).toHaveLength(1);
  expect(projected[0]).toMatchObject({ linearIssueId, evidence: 'https://example.com/hbm', text: '새 토픽 자료: HBM order cut' });
}));

test('weekly topic-search retries an undelivered deduped item and does not lose it after a failed projection', fixture(async (root) => {
  const linearIssueId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  addSource({ id: 'topic-weekly-dedupe', seat: 'MK', kind: 'topic-search', spec: 'HBM', every: '1w',
    scheduleCron: '0 8 * * 1', linearIssueId }, root);
  const projected: string[][] = [];
  let failProjection = true;
  const runAt = async (at: Date) => runDue({ now: at, sourceId: 'topic-weekly-dedupe', deps: {
    stateDir: root,
    searchTopic: async () => [{ url: 'https://example.com/hbm', title: 'HBM order update' }],
    projectTopicBriefing: async (_source, items) => {
      if (failProjection) { failProjection = false; throw new Error('temporary Linear outage'); }
      if (items.length) projected.push(items.map(item => item.evidence ?? ''));
    },
  } });
  const failed = await runAt(now);
  expect(failed.ran).toEqual([{ id: 'topic-weekly-dedupe', items: 0, error: 'temporary Linear outage' }]);
  expect(listSources({}, root)[0]?.lastRunAt).toBeUndefined();
  await runAt(new Date(now.getTime() + 7 * 86_400_000));
  expect(projected).toEqual([['https://example.com/hbm']]);
  const afterRetry = new BriefItemsLedger({ stateDir: root });
  expect(afterRetry.list().filter(item => item.linearIssueId === linearIssueId)).toHaveLength(1);
  await runAt(new Date(now.getTime() + 14 * 86_400_000));
  expect(projected).toEqual([['https://example.com/hbm'], ['https://example.com/hbm']]);
  const ledger = new BriefItemsLedger({ stateDir: root });
  expect(ledger.list().filter(item => item.linearIssueId === linearIssueId)).toHaveLength(2);
}));

test('source-id runDue scopes a scheduled fire and does not double-gate it on the source cadence', fixture(async (root) => {
  const idA = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const idB = 'b47ac10b-58cc-4372-a567-0e02b2c3d479';
  addSource({ id: 'topic-a', seat: 'MK', kind: 'topic-search', spec: 'A', every: '1d', scheduleCron: '0 8 * * *', linearIssueId: idA }, root);
  addSource({ id: 'topic-b', seat: 'MK', kind: 'topic-search', spec: 'B', every: '1d', scheduleCron: '0 9 * * *', linearIssueId: idB }, root);
  const searched: string[] = [];
  const result = await runDue({ now, sourceId: 'topic-b', deps: { stateDir: root,
    searchTopic: async (topic) => { searched.push(topic); return [{ url: `https://example.test/${topic}`, title: topic }]; },
    projectTopicBriefing: async () => {},
    addBriefItem: () => undefined,
  } });
  expect(result.ran).toEqual([{ id: 'topic-b', items: 1 }]);
  expect(searched).toEqual(['B']);
  const scheduledFire = await runDue({ now: new Date(now.getTime() + 60 * 60_000), sourceId: 'topic-b', deps: { stateDir: root,
    searchTopic: async (topic) => { searched.push(`${topic}-scheduled`); return []; }, addBriefItem: () => undefined,
    projectTopicBriefing: async () => {},
  } });
  expect(scheduledFire.ran).toEqual([{ id: 'topic-b', items: 0 }]);
  expect(searched).toEqual(['B', 'B-scheduled']);
}));

test('the shared intake-daily run skips per-topic sources unless their issue projector is enabled', fixture(async (root) => {
  addSource({ id: 'topic-owned-schedule', seat: 'MK', kind: 'topic-search', spec: 'HBM', every: '1d',
    scheduleCron: '0 8 * * *', linearIssueId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }, root);
  let searches = 0;
  const result = await runDue({ now, deps: { stateDir: root,
    searchTopic: async () => { searches++; return [{ url: 'https://example.test/hbm' }]; },
  } });
  expect(result.ran).toEqual([]);
  expect(searches).toBe(0);
  expect(listSources({}, root)[0]?.lastRunAt).toBeUndefined();
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
