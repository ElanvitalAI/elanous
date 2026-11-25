// SEARCH-BENCH focused tests — gold loader · metric math · folding · every strategy family on the tiny fixture corpus ·
// deterministic output · replay arm · LLM arm (fake fetch, no network). Expectations are independent literals.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureCorpus, thawCorpus } from './corpus.js';
import { FIXTURE_DECOYS, FIXTURE_FILES, FIXTURE_GOLD } from './fixture.js';
import { goldPath, loadGold, parseGold } from './gold.js';
import { CorpusContext, foldOutput, SearchKit } from './kit.js';
import { aggregate, firstRank, recallAt, scoreQuery } from './metrics.js';
import { queryTerms, termGroups } from './plan.js';
import { loadStrategies, selectStrategies } from './registry.js';
import { compareRuns, deterministicView, runBench, scorecardTable } from './runner.js';
import { exposureTools, llmStrategy, replayStrategy } from './agent-arm.js';
import type { SearchStrategy } from './types.js';
import { resolveRefRepos, resolveRepoSource } from './sources.js';
import { mkdirSync } from 'node:fs';

const tmp = mkdtempSync(join(tmpdir(), 'search-bench-test-'));
afterAll(() => { ctx.dispose(); thawCorpus(tmp); rmSync(tmp, { recursive: true, force: true }); });
const corpus = fixtureCorpus(join(tmp, 'corpus'), FIXTURE_FILES, FIXTURE_DECOYS);
const ctx = new CorpusContext(corpus.root);
let all: SearchStrategy[] = [];
const strategies = async () => (all.length ? all : (all = await loadStrategies()));
async function ranksOf(id: string): Promise<Record<string, number | null>> {
  const [s] = selectStrategies(await strategies(), id);
  const out: Record<string, number | null> = {};
  for (const it of FIXTURE_GOLD.items) out[it.id] = firstRank(await s!.run(it.query, new SearchKit(ctx)), it.expected);
  return out;
}

test('gold loader: both checked-in gold sets parse, are balanced, and include the two strategy docs', () => {
  const { gold } = loadGold(goldPath('elanous'));
  expect([gold.corpus, gold.items.length]).toEqual(['elanous', 32]);
  expect([gold.items.filter((i) => i.domain === 'code').length, gold.items.filter((i) => i.domain === 'docs').length]).toEqual([16, 16]);
  const targets = gold.items.flatMap((i) => i.expected);
  expect(targets).toContain('docs/conductor/FEATURE-SHIP-ACCELERATION.md');
  expect(targets).toContain('docs/conductor/JUDGE-LOAD-REDUCTION.md');
  expect(gold.items.find((i) => i.id === 'd05')!.query).toBe('판정국 부하 줄이기');
  const ref = loadGold(goldPath('ref')).gold;
  expect([ref.corpus, ref.items.length, ref.repos!.length]).toEqual(['ref', 21, 8]);
});

test('gold loader rejects duplicate ids, unknown categories and absolute paths', () => {
  const base = { schema: 'search-bench.gold/1', corpus: 'elanous', version: 1, pinnedSha: 'x' };
  const row = { id: 'a', domain: 'docs', category: 'filename', query: 'q', expected: ['docs/a.md'] };
  expect(() => parseGold({ ...base, items: [row, row] })).toThrow('duplicate id a');
  expect(() => parseGold({ ...base, items: [{ ...row, category: 'vibes' }] })).toThrow('unknown category vibes');
  expect(() => parseGold({ ...base, items: [{ ...row, expected: ['/etc/passwd'] }] })).toThrow('expected must be non-empty relative paths');
  expect(parseGold({ ...base, items: [row] }).items[0]!.expected).toEqual(['docs/a.md']);
});

test('metric math: recall@k over min(|expected|, k), first rank, MRR aggregate', () => {
  expect(recallAt(['x', 'b', 'c'], ['b'], 1)).toBe(0);
  expect(recallAt(['x', 'b', 'c'], ['b'], 5)).toBe(1);
  expect(recallAt(['a', 'x'], ['a', 'b', 'c'], 1)).toBe(1);
  expect(recallAt(['a', 'b', 'x', 'y', 'z', 'c'], ['a', 'b', 'c'], 5)).toBeCloseTo(2 / 3, 5);
  expect([firstRank(['x', 'y', 'b'], ['b']), firstRank(['x'], ['b'])]).toEqual([3, null]);
  const item = FIXTURE_GOLD.items[0]!;
  const r1 = scoreQuery('s', item, ['docs/conductor/JUDGE-LOAD-REDUCTION.md'], [{ tool: 'Glob', args: 'p', bytes: 100, ms: 1, hits: 1 }], 5);
  const r2 = scoreQuery('s', item, ['x', 'docs/conductor/JUDGE-LOAD-REDUCTION.md'], [{ tool: 'Grep', args: 'p', bytes: 300, ms: 1, hits: 2 }, { tool: 'Read', args: 'x', bytes: 100, ms: 1, hits: 1 }], 7);
  const r3 = scoreQuery('s', item, ['node_modules/@decoy/pkg/docs/conductor/JUDGE-LOAD-REDUCTION.md'], [], 0);
  expect(aggregate([r1, r2, r3])).toEqual({ n: 3, recall1: 0.333, recall5: 0.667, mrr: 0.5, calls: 1, bytes: 167, ms: 4, decoy5: 0.33 });
});

test('folding: RunShell keeps a 200 000-byte head and returns the structured result; head/tail and line caps', () => {
  const big = 'a'.repeat(250_000);
  const rs = foldOutput({ kind: 'runshell' }, big, '', 0);
  expect([rs.visible.length, rs.truncated]).toEqual([200_000, true]);
  expect(rs.bytes).toBe(200_000 + JSON.stringify({ output: 'exit 0', exitCode: 0, outcome: 'exit', elapsedMs: 0, stdout: '', stderr: '', truncated: true }).length);
  const ht = foldOutput({ kind: 'headtail', bytes: 10 }, '0123456789ABCDEFGHIJ', '', 0);
  expect(ht.visible).toBe('01234\n…[truncated]…\nFGHIJ');
  const keep = 'aaaa\nbb'.split('\n').length; // keep the first two lines, cut each at three chars
  expect(foldOutput({ kind: 'lines', lines: keep, lineChars: 'aaa'.length }, 'aaaa\nbb\ncc\n', '', 0)).toEqual({ visible: 'aaa...\nbb', bytes: 9, truncated: true });
});

test('query plan: particles stripped, stopwords dropped, dotted keys split, ko↔en expansion from the glossary', () => {
  expect(queryTerms('SMART-MERGE-V2 칸을 만든 문서')).toEqual(['SMART-MERGE-V2', '칸']);
  expect(queryTerms('where is the docs search refresh file cap implemented')).toEqual(['docs', 'search', 'refresh', 'file', 'cap']);
  expect(termGroups('knowledge.docsRoots', false)).toEqual([['knowledge.docsRoots', 'docsRoots']]);
  expect(termGroups('판정국 부하', true)).toEqual([['판정국', 'judge'], ['부하', 'load']]);
});

test('registry loads every strategy file with unique ids across all tracks', async () => {
  const s = await strategies();
  expect(new Set(s.map((x) => x.track))).toEqual(new Set(['N', 'I', 'I+N', 'E', 'X']));
  expect(s.length).toBe(60);
  expect(selectStrategies(s, 'X-*').map((x) => x.id)).toEqual(['X-claude-code', 'X-codex', 'X-grok-cli', 'X-grok-build', 'X-hermes', 'X-openclaw']);
  expect(() => selectStrategies(s, 'nope')).toThrow('unknown strategy: nope');
});

test('Track N on the fixture: Grep alone misses the Korean title doc by name, Glob→Grep→Read+def finds all six at rank 1', async () => {
  // Product Grep lists the DEFINING file first for an identifier: the symbol query (f3) reaches rank 1, the call-site
  // query (f4) drops to 2 behind the definition (Grep cannot see caller intent; N4's call-site boost restores it).
  expect(await ranksOf('N2-glob')).toEqual({ f1: 1, f2: 1, f3: 1, f4: 2, f5: 1, f6: 1 });
  expect(await ranksOf('N4-best')).toEqual({ f1: 1, f2: 1, f3: 1, f4: 1, f5: 1, f6: 1 });
});

test('Track I on the fixture: stage 0 never indexed docs/conductor, stage 1 does; docs search cannot see code', async () => {
  expect(await ranksOf('I0-docs-s0')).toEqual({ f1: null, f2: null, f3: null, f4: null, f5: null, f6: null });
  expect(await ranksOf('I1-docs-s1')).toEqual({ f1: 1, f2: 1, f3: null, f4: null, f5: 1, f6: null });
  expect((await ranksOf('I3-code-bm25')).f3).toBe(2);
});

test('Track E on the fixture: BSD grep walks the ignored decoy dir, rg and git grep do not; ast-grep finds the definition', async () => {
  const [bsd] = selectStrategies(await strategies(), 'E2-bsd-grep');
  const ranked = await bsd!.run('dispatchGlob', new SearchKit(ctx));
  expect(ranked.slice(0, 2)).toEqual(['node_modules/@decoy/pkg/src/tools/glob.ts', 'src/tools/glob.ts']);
  const [rg] = selectStrategies(await strategies(), 'E1-rg');
  expect((await rg!.run('dispatchGlob', new SearchKit(ctx))).some((p) => p.startsWith('node_modules/'))).toBe(false);
  expect(await ranksOf('E5-astgrep-rg')).toEqual({ f1: 1, f2: 1, f3: 1, f4: 1, f5: 1, f6: 1 });
});

test('Track X on the fixture: each external emulation runs through its own tool label', async () => {
  for (const id of ['X-claude-code', 'X-codex', 'X-grok-cli', 'X-grok-build', 'X-hermes', 'X-openclaw']) {
    const [s] = selectStrategies(await strategies(), id);
    const kit = new SearchKit(ctx);
    const ranked = await s!.run('dispatchGlob', kit);
    expect([id, ranked.includes('src/tools/glob.ts'), kit.trace.every((t) => t.tool.startsWith('X:') || t.tool.startsWith('RunShell:'))]).toEqual([id, true, true]);
  }
});

test('deterministic output: two runs over the same corpus and gold are equal apart from wall-clock fields', async () => {
  const pick = selectStrategies(await strategies(), 'N3-cc,I1-docs-s1,E1-rg,X-codex,C1-docs-then-native-weak');
  const run = () => runBench({ ctx, gold: FIXTURE_GOLD, goldSha256: 'g', corpusSha: corpus.sha, corpusFiles: corpus.files, strategies: pick, host: 'h' });
  const [a, b] = [await run(), await run()];
  expect(deterministicView(a)).toEqual(deterministicView(b));
  expect(scorecardTable(a)[1]).toBe('track | strategy | code r@5 | docs r@5 | r@1 | r@5 | MRR | calls | KB | ms | decoy@5');
  // KB is left out: product Grep/Glob print absolute paths, so bytes depend on the temp-dir length of the host.
  expect(compareRuns(a, b).find((l) => l.startsWith('N3-cc '))).toStartWith('N3-cc | v1→v1 | 1.00 → 1.00 (+0.00) | 0.92 → 0.92 | ');
});

test('replay arm re-executes recorded tool calls for cost and scores the recorded answer', async () => {
  const path = join(tmp, 'transcript.json');
  writeFileSync(path, JSON.stringify({ schema: 'search-bench.transcript/1', agent: 'opus', queries: [
    { query: 'dispatchGlob', calls: [{ tool: 'Grep', args: { pattern: 'dispatchGlob' } }, { tool: 'Read', args: { file_path: 'src/tools/glob.ts' } }], answer: ['src/tools/glob.ts'] }] }));
  const s = replayStrategy(path);
  const kit = new SearchKit(ctx);
  expect([s.id, await s.run('dispatchGlob', kit), kit.trace.map((t) => t.tool)]).toEqual(['A-replay-opus', ['src/tools/glob.ts'], ['Grep', 'Read']]);
});

test('LLM arm (fake OpenRouter): deferred exposure loads tools, executes the call, parses the answer; first tool recorded', async () => {
  expect(exposureTools('D-ops-ui-deferred', 'D2-short').immediate.map((t) => t.name)).toEqual(['RunShell', 'LoadTools']);
  expect(exposureTools('B-docs-first', 'D1-current').immediate.map((t) => t.name)).toEqual(['DocsSearch', 'Grep', 'Glob', 'Read', 'RunShell']);
  const replies = [
    { tool_calls: [{ id: 't1', function: { name: 'LoadTools', arguments: '{"names":["Grep"]}' } }] },
    { tool_calls: [{ id: 't2', function: { name: 'Grep', arguments: '{"pattern":"dispatchGlob"}' } }] },
    { content: '["src/tools/glob.ts"]' },
  ];
  const sent: string[][] = [];
  const fakeFetch = (async (_url: unknown, init?: { body?: string }) => {
    sent.push((JSON.parse(init!.body!) as { tools: Array<{ function: { name: string } }> }).tools.map((t) => t.function.name));
    return new Response(JSON.stringify({ choices: [{ message: replies[sent.length - 1] }] }));
  }) as unknown as typeof fetch;
  const s = llmStrategy({ model: 'm', exposure: 'D-ops-ui-deferred', descriptions: 'D2-short', apiKey: 'k', fetchImpl: fakeFetch });
  const kit = new SearchKit(ctx);
  expect(await s.run('dispatchGlob', kit)).toEqual(['src/tools/glob.ts']);
  expect(sent).toEqual([['RunShell', 'LoadTools'], ['RunShell', 'LoadTools', 'Grep'], ['RunShell', 'LoadTools', 'Grep']]);
  expect(kit.trace.map((t) => t.tool)).toEqual(['LoadTools', 'Grep']);
});

test('stage 1b: the product DocsSearch tool (resolver sources · index ⊕ fallback) finds the conductor doc stage 0 missed', async () => {
  expect(await ranksOf('I1b-docs-tool')).toEqual({ f1: 1, f2: 1, f3: null, f4: null, f5: 1, f6: null });
  const kit = new SearchKit(ctx);
  await kit.docsTool('판정국 로드', 'both');
  expect(kit.trace.map((t) => [t.tool, t.args])).toEqual([['DocsSearch@1b', '판정국 로드 [both]']]);
});

test('corpus sources come from the product resolver: ids from ELANOUS_SOURCES, custom paths otherwise; ref repos found inside a source', () => {
  const refRoot = join(tmp, 'ref');
  for (const r of ['alpha', 'beta']) mkdirSync(join(refRoot, r), { recursive: true });
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV, ELANOUS_SOURCES: JSON.stringify([{ id: 'main', type: 'repo', path: corpus.root }, { id: 'refs', type: 'ref', path: refRoot }]) };
  expect(resolveRepoSource({}, { env })).toEqual({ id: 'main', type: 'repo', path: corpus.root });
  expect(resolveRepoSource({ repo: refRoot }, { env })).toEqual({ id: 'custom1', type: 'custom', path: refRoot });
  const r = resolveRefRepos(['alpha', 'beta'], {}, { env });
  expect(r.repos).toEqual([{ repo: 'alpha', path: join(refRoot, 'alpha'), sourceId: 'refs' }, { repo: 'beta', path: join(refRoot, 'beta'), sourceId: 'refs' }]);
  expect(() => resolveRefRepos(['gamma'], {}, { env })).toThrow('ref repos not found');
  expect(() => resolveRepoSource({ repoSource: 'nope' }, { env })).toThrow('unknown source id: nope');
});
