import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { buildIntakeDigest, renderDigestMarkdown } from '../src/intake-plane/digest.js';
import { parseCommunityReport, parseOmniCrawlPayload, runIntakeSocial } from './intake-social.js';

// INTAKE-SOCIAL(0.2.31) 판정선: 하루 커뮤니티 동향 N건이 흡수 요약에 흐른다.
// grok-community 엔진을 실제로 부르지 않고(시험은 몸 주입) 같은 길 — lens 줄 → buildIntakeDigest → renderDigestMarkdown — 을 증명한다.

setDefaultTimeout(20_000);

const NOW = new Date('2026-10-06T07:00:00.000Z');
const REDDIT = 'https://www.reddit.com/r/LocalLLaMA/comments/1abc/harness-talk';
const XPOST = 'https://x.com/foo/status/12345';
// «링크만 있는 줄» 전용 URL — 앞선 줄과 같은 URL 이면 중복 제거가 내용 검사를 가린다(GOODHART).
// 고유 URL 이어야 그 줄이 흡수되지 않는 이유가 내용 검사 탓임이 드러난다.
const LINKONLY = 'https://x.com/bar/status/99999';
const REPORT = [
  '## 최근 24시간 커뮤니티 동향',
  `- 로컬 LLM 하니스 튜닝 결과 공유가 r/LocalLLaMA에서 화제다. ${REDDIT}`,
  `- **Claude Code 대 Gemini CLI** 비교 스레드가 많은 반응을 얻었다. [스레드](${XPOST})`,
  '- 출처 링크가 없는 줄은 흡수하지 않는다.',
  `- 링크만 있는 줄 ${LINKONLY}`,
].join('\n');
const check = async (facts: readonly string[]) => ({
  items: facts.map((fact) => ({ fact, line: `${fact} → 외부 동향 → 없음`, current: '외부 동향', verdict: '없음' })),
});

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'intake-social-'));
}

test('INTAKE-SOCIAL: grok-community 동향 점이 흡수 요약(관심 뉴스 절) 줄로 흐른다 · 재실행은 본 것을 건너뛴다', async () => {
  const dir = tempRoot();
  const crawl = async () => parseCommunityReport(REPORT);
  try {
    expect(await runIntakeSocial({ root: dir, deps: { now: () => NOW, crawl, check } })).toEqual({ written: 2, failed: 0 });
    const file = join(dir, 'intake', 'outbox', 'lens', '2026-10-06.jsonl');
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.url)).not.toContain(LINKONLY);
    expect(rows[0].source).toBe('grok-community');
    expect(rows[0].url).toBe(REDDIT);
    expect(rows[0].summary.join(' ')).toContain('하니스');
    expect(rows[0].implication[0]).toContain('커뮤니티 동향 참고:');
    expect(rows[0].suggestions).toEqual([]);
    expect(rows[0].lensVerdict).toBe('참고');
    expect(rows[0].why).not.toContain('엘라누스 대조');
    expect(rows[1].title).toContain('Claude Code 대 Gemini CLI');
    expect(rows[1].title).not.toContain('https://');
    const digest = buildIntakeDigest(dir, '2026-10-06');
    const digestNews = digest.news ?? [];
    expect(digestNews).toHaveLength(2);
    expect(digestNews.map((row) => row.url)).toContain(REDDIT);
    const markdown = renderDigestMarkdown(digest);
    expect(markdown).toContain('관심 뉴스');
    expect(markdown).toContain('Claude Code 대 Gemini CLI');
    expect(markdown).not.toContain('링크만 있는 줄');
    expect(await runIntakeSocial({ root: dir, deps: { now: () => NOW, crawl, check } })).toEqual({ written: 0, failed: 0 });
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTAKE-SOCIAL: 실제 intake check 에 커뮤니티 동향을 보내도 lens 에 제품 결손을 쓰지 않는다', async () => {
  const dir = tempRoot();
  const text = '로컬 LLM 하니스 튜닝 결과 공유가 r/LocalLLaMA에서 화제다.';
  try {
    expect(await runIntakeSocial({ root: dir, deps: {
      now: () => NOW, crawl: async () => [{ title: text, text, url: REDDIT }],
    } })).toEqual({ written: 1, failed: 0 });
    const rows = readFileSync(join(dir, 'intake', 'outbox', 'lens', '2026-10-06.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toEqual([text]);
    expect(rows[0].implication).toEqual([`커뮤니티 동향 참고: ${text}`]);
    expect(rows[0].suggestions).toEqual([]);
    expect(rows[0].lensVerdict).toBe('참고');
    expect(renderDigestMarkdown(buildIntakeDigest(dir, '2026-10-06'))).not.toContain('뉴스 칸 제안');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

test('INTAKE-SOCIAL: omni-crawl 제목만의 명시적인 elanous 기능 주장도 대조해 칸을 제안한다', async () => {
  const dir = tempRoot();
  const fact = 'elanous는 로컬 모델 추론을 지원한다.';
  const trend = '로컬 LLM 하니스 튜닝 결과 공유가 커뮤니티에서 화제다.';
  const received: string[][] = [];
  const crawl = async () => parseOmniCrawlPayload({ results: [{ items: [
    { url: XPOST, title: fact, text: trend },
  ] }] });
  try {
    expect(await runIntakeSocial({ root: dir, deps: {
      now: () => NOW, crawl,
      check: async (facts) => {
        received.push([...facts]);
        return { items: facts.map((item) => ({
          fact: item, line: `${item} → 없음`, current: '없음', verdict: '없음',
        })) };
      },
    } })).toEqual({ written: 1, failed: 0 });
    expect(received).toEqual([[trend, fact]]);
    const row = JSON.parse(readFileSync(join(dir, 'intake', 'outbox', 'lens', '2026-10-06.jsonl'), 'utf8').trim());
    expect(row.title).toBe(fact);
    expect(row.summary).toEqual([trend]);
    expect(row.implication).toEqual([`커뮤니티 동향 참고: ${trend}`, `${fact} → 없음`]);
    expect(row.suggestions).toEqual([{ kind: '칸 제안', fact, status: '제안', verdict: '없음' }]);
    expect(row.lensVerdict).toBe('보강');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTAKE-SOCIAL: 엔진 실패는 «못 모음» 한 줄로 판을 막지 않는다', async () => {
  const dir = tempRoot();
  const logs: string[] = [];
  try {
    const result = await runIntakeSocial({
      root: dir,
      deps: { now: () => NOW, crawl: async () => { throw new Error('XAI 쿼터 소진'); }, check, log: (message) => logs.push(message) },
    });
    expect(result).toEqual({ written: 0, failed: 1 });
    expect(logs).toEqual(['못 모음: grok-community — XAI 쿼터 소진']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTAKE-SOCIAL: omni-crawl JSON 몸(items ⊕ rawText 요약)을 합치고 URL 로 중복을 뺀다', () => {
  const payload = {
    results: [
      { engine: 'grok-community', totalItems: 2, summary: REPORT, items: [] },
      { engine: 'grok-community', totalItems: 1, summary: null, items: [
        { url: REDDIT, title: '중복: 같은 링크의 하니스 토론', text: '같은 링크' },
        { url: 'notaurl', title: '깨진 항목', text: '무시' },
      ] },
    ],
  };
  const points = parseOmniCrawlPayload(payload);
  expect(points).toHaveLength(2);
  expect(points[0].url).toBe(REDDIT);
  expect(points.map((point) => point.url)).not.toContain('notaurl');
});

test('INTAKE-SOCIAL: 하루 상한(8점)을 넘는 동향은 상한까지만 쓴다', async () => {
  const dir = tempRoot();
  const crawl = async () => Array.from({ length: 12 }, (_, index) => ({
    title: `커뮤니티 화제 ${index}`,
    url: `https://x.com/thread/${index}`,
    text: `AI 에이전트 커뮤니티 반응 ${index}번째 화제다.`,
  }));
  try {
    expect(await runIntakeSocial({ root: dir, deps: { now: () => NOW, crawl, check } })).toEqual({ written: 8, failed: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INTAKE-SOCIAL: daily graph 는 news → social → registered sources → ingest 로 배선하고 등록된 명령을 쓴다', () => {
  const graph = parseYaml(readFileSync(join(import.meta.dir, '../graphs/intake/intake-daily.yaml'), 'utf8'));
  const recipes = parseYaml(readFileSync(join(import.meta.dir, '../graphs/intake/recipes.yaml'), 'utf8'));
  expect(graph.nodes.find((node: { node_id: string }) => node.node_id === 'social').recipe).toBe('cmd:intake-social');
  expect(graph.edges.find((edge: { from: string }) => edge.from === 'news').map).toEqual({ ok: 'social', fail: 'social' });
  expect(graph.edges.find((edge: { from: string }) => edge.from === 'social').map).toEqual({ ok: 'registered-sources', fail: 'registered-sources' });
  expect(graph.edges.find((edge: { from: string }) => edge.from === 'registered-sources').map).toEqual({ ok: 'ingest', fail: 'ingest' });
  expect(recipes['intake-social'].command).toContain('scripts/intake-social.ts');
});
