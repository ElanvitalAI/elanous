import { expect, test, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { buildIntakeDigest, renderDigestMarkdown, renderDigestTelegram } from '../src/intake-plane/digest.js';
import { canonicalUrl } from '../src/intake-plane/items.js';
import { newsInterest, runIntakeNews } from './intake-news.js';

setDefaultTimeout(20000);
const NOW = new Date('2026-10-06T07:00:00.000Z');
const FEED = readFileSync(join(import.meta.dir, '__fixtures__/intake-news.xml'), 'utf8');
const sources = [{ name: 'AI타임스', rss: 'https://www.aitimes.com/rss/allArticle.xml' }];
const articleUrl = 'https://www.aitimes.com/news/articleView.html?idxno=215802';
const check = async () => ({ items: [{ fact: 'elanous는 `RRSI` 하니스 기능을 지원한다', verdict: '없음', current: '근거 없음', line: 'RRSI → 근거 없음 → 없음' }] });

function root(): string { return mkdtempSync(join(tmpdir(), 'intake-news-')); }
function response(url: string): Response {
  return new Response(url === sources[0]!.rss ? FEED : '<article><p>구글 RRSI는 하니스만 고쳐 에이전트 성능을 향상시켰다. 기존 모델 가중치는 바꾸지 않았다고 연구진이 밝혔다. 프롬프트와 도구 사용 방식을 반복적으로 고쳤다. 하위 에이전트와 메모리 관리도 수정 대상에 포함됐다. 연구진은 여러 벤치마크에서 성능이 올랐다고 설명했다. 코드는 아직 공개되지 않았다.</p></article>');
}

test('fixed RSS filters 24 hours and interest, writes five lines and shadow suggestion, rerun skips URL hash', async () => {
  const dir = root();
  const calls: string[] = [];
  try {
    const deps = { now: () => NOW, fetch: async (input: string | URL | Request) => { const url = String(input); calls.push(url); return response(url); }, check, classify: async () => false };
    expect(await runIntakeNews({ root: dir, sources, deps })).toEqual({ written: 1, failed: 0 });
    const file = join(dir, 'intake', 'outbox', 'lens', '2026-10-06.jsonl');
    const row = JSON.parse(readFileSync(file, 'utf8').trim());
    expect(row.url).toBe(articleUrl);
    expect(row.summary).toHaveLength(5);
    expect(row.summary.join(' ')).toContain('구글 RRSI');
    expect(row.summary.join(' ')).not.toContain('본문에서 추가로 확인된 내용 없음');
    expect(row.implication).toContain('RRSI → 근거 없음 → 없음');
    expect(row.suggestions).toHaveLength(1);
    expect(row.suggestions[0].status).toBe('제안');
    expect(row.suggestions[0].verdict).toBe('없음');
    expect(row.lensVerdict).toBe('보강');
    const digest = buildIntakeDigest(dir, '2026-10-06');
    expect(digest.shadowSuggestions).toHaveLength(1);
    expect(digest.news).toHaveLength(1);
    expect(renderDigestMarkdown(digest)).toContain('엘라누스 함의: RRSI → 근거 없음 → 없음');
    expect(renderDigestMarkdown(digest)).toContain('뉴스 칸 제안 — 그림자, 판 미등록');
    expect(renderDigestTelegram(digest)).toContain('뉴스 칸 제안 1건 (그림자·판 미등록)');
    expect(digest.goals).toEqual([]);
    expect(renderDigestMarkdown(buildIntakeDigest(dir, '2026-10-05'))).not.toContain('뉴스 칸 제안');
    expect(readFileSync(join(dir, 'intake', 'news-seen.jsonl'), 'utf8')).toMatch(/^[a-f0-9]{16}\n$/);
    expect(row.id).toBe(createHash('sha256').update(canonicalUrl(articleUrl)!).digest('hex').slice(0, 16));
    expect(await runIntakeNews({ root: dir, sources, deps })).toEqual({ written: 0, failed: 0 });
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(calls.filter((url) => url === articleUrl)).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('uncertain intake-check verdict stays uncertain while leaving a review-only suggestion', async () => {
  const dir = root();
  try {
    const result = await runIntakeNews({ root: dir, sources, deps: {
      now: () => NOW, fetch: async (input) => response(String(input)),
      classify: async () => false,
      check: async () => ({ items: [{ fact: 'elanous는 `RRSI` 하니스를 지원한다', line: 'RRSI → 문서만 있음 → 판단 필요', current: '문서만 있음', verdict: '판단 필요' }] }),
    } });
    expect(result).toEqual({ written: 1, failed: 0 });
    const row = JSON.parse(readFileSync(join(dir, 'intake', 'outbox', 'lens', '2026-10-06.jsonl'), 'utf8').trim());
    expect(row.suggestions).toEqual([{ kind: '칸 제안', fact: 'elanous는 `RRSI` 하니스를 지원한다', status: '제안', verdict: '판단 필요' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only ambiguous title/summary invokes classifier once; irrelevant articles never invoke it', async () => {
  const dir = root();
  let classifications = 0;
  try {
    const result = await runIntakeNews({ root: dir, sources, deps: {
      now: () => NOW, fetch: async (input) => response(String(input)), check,
      classify: async () => { classifications++; return false; },
    } });
    expect(result.written).toBe(1);
    expect(classifications).toBe(1);
    expect(newsInterest({ title: '농구 결승', description: '스포츠', url: '', published: '' })).toBe('no');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('network failure emits 못 모음 and does not block next source', async () => {
  const dir = root();
  const logs: string[] = [];
  try {
    const result = await runIntakeNews({ root: dir, sources: [{ name: 'broken', rss: 'https://broken.test/rss' }, ...sources], deps: {
      now: () => NOW, log: (message) => logs.push(message), classify: async () => false,
      fetch: async (input) => { if (String(input) === 'https://broken.test/rss') throw new Error('offline'); return response(String(input)); }, check,
    } });
    expect(result).toEqual({ written: 1, failed: 1 });
    expect(logs).toEqual(['못 모음: broken — offline']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('daily graph wires trend → news → ingest, including fail continuation and registered command', () => {
  const graph = parseYaml(readFileSync(join(import.meta.dir, '../graphs/intake/intake-daily.yaml'), 'utf8'));
  const recipes = parseYaml(readFileSync(join(import.meta.dir, '../graphs/intake/recipes.yaml'), 'utf8'));
  expect(graph.loop.trigger.cron).toBe('0 7 * * *');
  expect(graph.nodes.find((node: { node_id: string }) => node.node_id === 'news').recipe).toBe('cmd:intake-news');
  expect(graph.edges.find((edge: { from: string }) => edge.from === 'trend').map).toEqual({ ok: 'news', fail: 'news' });
  expect(graph.edges.find((edge: { from: string }) => edge.from === 'news').map).toEqual({ ok: 'ingest', fail: 'ingest' });
  expect(recipes['intake-news'].command).toContain('scripts/intake-news.ts');
  expect(parseYaml(readFileSync(join(import.meta.dir, '../graphs/intake/news-sources.yaml'), 'utf8')).sources).toEqual(sources);
});

test('the existing graph CLI accepts the daily graph and resolves the registered news recipe', () => {
  const result = spawnSync('bun', ['bin/elanous.mjs', '--test', 'graph', 'run', 'graphs/intake/intake-daily.yaml', '--dry-run'], {
    cwd: join(import.meta.dir, '..'), encoding: 'utf8', timeout: 30_000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('trend → news → ingest');
});

test('NEWS-INTAKE: one article is checked as up to three facts (title ⊕ two summary lines)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const seen: string[][] = [];
  const root = mkdtempSync(join(tmpdir(), 'news-facts-'));
  const r = await runIntakeNews({ root, sources: [{ name: 'AI타임스', rss: sources[0]!.rss }], deps: {
    now: () => NOW, fetch: async (input) => response(String(input)),
    check: async (facts) => { seen.push([...facts]); return { items: facts.map((fact) => ({ fact, line: `${fact} → 없음`, current: '근거 없음', verdict: '없음' })) }; },
    classify: async () => true,
  } });
  expect(r.written).toBeGreaterThan(0);
  expect(seen[0]).toHaveLength(3);
  expect(seen[0]![1]).toStartWith('elanous는 다음 일을 한다: ');
});

test('NEWS-INTAKE: typographic entities in article text are decoded (real AI타임스 body uses &lsquo;)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'news-ent-'));
  const body = '<article><p>모델을 둘러싼 &lsquo;하네스(harness)&rsquo;를 반복적으로 수정하는 방식으로 에이전트 성능을 높였다고 밝혔다.</p></article>';
  await runIntakeNews({ root, sources, deps: { now: () => NOW, fetch: async (input) => String(input) === sources[0]!.rss ? new Response(FEED) : new Response(body), check, classify: async () => true } });
  const row = JSON.parse(readFileSync(join(root, 'intake', 'outbox', 'lens', '2026-10-06.jsonl'), 'utf8').trim().split('\n')[0]!);
  expect(row.summary.join(' ')).toContain('‘하네스(harness)’');
  expect(row.summary.join(' ')).not.toContain('&lsquo;');
});

test('NEWS-INTAKE: a short article keeps only its real sentences — no invented lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-short-'));
  const body = '<article><p>구글 RRSI는 하니스만 고쳐 에이전트 성능을 향상시켰다고 발표했다.</p></article>';
  await runIntakeNews({ root: dir, sources, deps: { now: () => NOW, fetch: async (input) => String(input) === sources[0]!.rss ? new Response(FEED) : new Response(body), check, classify: async () => true } });
  const row = JSON.parse(readFileSync(join(dir, 'intake', 'outbox', 'lens', '2026-10-06.jsonl'), 'utf8').trim().split('\n')[0]!);
  expect(row.summary).toEqual(['구글 RRSI는 하니스만 고쳐 에이전트 성능을 향상시켰다고 발표했다.']);
});

test('NEWS-INTAKE: an article already in the lens file is not written again even if the seen-state write was lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-dedupe-'));
  const deps = { now: () => NOW, fetch: async (input: string | URL | Request) => response(String(input)), check, classify: async () => true };
  expect((await runIntakeNews({ root: dir, sources, deps })).written).toBeGreaterThan(0);
  rmSync(join(dir, 'intake', 'news-seen.jsonl'));
  expect((await runIntakeNews({ root: dir, sources, deps })).written).toBe(0);
});

