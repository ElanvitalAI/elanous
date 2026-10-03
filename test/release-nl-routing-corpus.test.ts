import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { assertGradableItems, classifyRouting, selectCorpusItems, unavailableExpectedToolIds } from '../scripts/lib/nl-routing-measurement.js';
import { main as measureCorpus, resolveCorpusRunSafety } from '../scripts/measure-nl-routing-corpus.js';
import type { EvalPromptResult } from '../src/eval-prompt-cli.js';

const corpusPath = resolve(import.meta.dir, 'fixtures/release-nl-routing-corpus.json');
interface Item { id: string; tier: string; prompt: string; accept: string[]; reject?: string[] }
interface Corpus { description: string; surface: string; tiers: Record<string, string>; items: Item[] }
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as Corpus;

function assertUniqueRouting(items: readonly Item[]): void {
  const seen = new Map<string, Item>();
  for (const item of items) {
    const prompt = item.prompt.replace(/\s+/g, ' ').trim();
    const prior = seen.get(prompt);
    if (prior) {
      const routing = (entry: Item) => JSON.stringify({
        accept: [...entry.accept].sort(), reject: [...(entry.reject ?? [])].sort(),
      });
      if (routing(prior) !== routing(item)) {
        throw new Error(`Conflicting release NL routing for "${prompt}": ${prior.id} vs ${item.id}`);
      }
      throw new Error(`Duplicate release NL prompt: "${prompt}" (${prior.id}, ${item.id})`);
    }
    seen.set(prompt, item);
  }
}

describe('release NL-routing corpus', () => {
  test('all ten prompts have valid measurement shape and each prompt has one consistent routing', () => {
    expect(corpus.description.length).toBeGreaterThan(0);
    expect(corpus.surface).toBe('webterm');
    expect(corpus.items.map((item) => item.id)).toEqual([
      'release-status-01', 'release-status-02', 'release-change-01',
      'release-contrast-status-01', 'release-contrast-change-01',
      'rel-status', 'rel-admin', 'rel-change', 'rel-weather', 'rel-logs',
    ]);
    expect(corpus.items.map((item) => item.prompt)).toEqual([
      '이번 릴리스 일정과 체크리스트 상태 알려줘',
      '지금 릴리스 체크리스트에서 빨간 항목이 뭐야?',
      '릴리스 체크리스트의 빌드 검증 항목을 green으로 변경해줘',
      '릴리스 일정과 체크리스트 상태를 확인하는 방법만 설명해줘. 지금 상태는 조회하지 마.',
      '릴리스 체크리스트의 빌드 검증 항목을 green으로 바꾸려면 어떤 절차가 필요한지만 설명해줘. 실제로 변경하지 마.',
      '0.2.10 어디까지 왔어', '행정 뭐 남았어', '0.2.11 에 ○○ 칸 추가해줘',
      '오늘 날씨 어때', '로그 보여줘',
    ]);
    expect(() => assertUniqueRouting(corpus.items)).not.toThrow();
    expect(Object.keys(corpus.tiers).sort()).toEqual(['contrast', 'positive-change', 'positive-status', 'release']);
    expect(() => assertGradableItems(corpus.items)).not.toThrow();
    expect(selectCorpusItems(corpus.items, {})).toHaveLength(10);
    expect(unavailableExpectedToolIds(corpus.items, ['release_status', 'release_change', 'coo_admin'])).toEqual([]);
    for (const item of corpus.items) {
      expect(item.prompt.trim()).toBe(item.prompt);
      expect(item.prompt.length).toBeGreaterThan(0);
      expect(corpus.tiers[item.tier]).toBeTruthy();
    }
    expect(corpus.items.map(({ accept, reject }) => ({ accept, reject: reject ?? [] }))).toEqual([
      { accept: ['release_status'], reject: [] },
      { accept: ['release_status'], reject: [] },
      { accept: ['release_change'], reject: [] },
      { accept: [], reject: ['release_status', 'release_change'] },
      { accept: [], reject: ['release_status', 'release_change'] },
      { accept: ['release_status'], reject: ['release_change', 'coo_admin'] },
      { accept: ['coo_admin'], reject: ['release_status'] },
      { accept: ['release_change'], reject: ['release_status'] },
      { accept: [], reject: ['release_status', 'release_change'] },
      { accept: [], reject: ['release_status', 'release_change'] },
    ]);
    for (const item of corpus.items) {
      expect(classifyRouting(item.accept, item.accept, item.reject)).toBe('pass');
      for (const forbidden of item.reject ?? []) {
        expect(classifyRouting([forbidden], item.accept, item.reject)).toBe('rejected-tool');
      }
      if (item.accept.length > 0) expect(classifyRouting([], item.accept, item.reject)).toBe('no-fire');
    }
  });

  test('measurement entrypoint loads the shared corpus and evaluates rel-* on webterm', async () => {
    const outDir = mkdtempSync(resolve(tmpdir(), 'release-nl-routing-'));
    const out = resolve(outDir, 'measurement.json');
    const previousEnv = { ...process.env };
    const previousArgv = process.argv;
    const previousLog = console.log;
    const seen: Array<{ prompt: string; tools: string }> = [];
    try {
      process.argv = process.argv.slice(0, 2);
      process.env.CORPUS_CWD = outDir;
      process.env.CORPUS_PATH = corpusPath;
      process.env.CORPUS_OUT = out;
      process.env.CORPUS_IDS = 'rel-status,rel-admin,rel-change,rel-weather,rel-logs';
      process.env.CORPUS_REPEATS = '1';
      process.env.CORPUS_BUDGETS = '1';
      process.env.CORPUS_CONCURRENCY = '1';
      delete process.env.CORPUS_SURFACE;
      delete process.env.CORPUS_TIERS;
      console.log = (() => undefined) as typeof console.log;
      await measureCorpus(
        undefined,
        async ({ prompt, tools }): Promise<EvalPromptResult> => {
          seen.push({ prompt, tools: tools! });
          return {
            text: '', modelFamily: 'test', modelId: 'test', turnCount: 1, toolCallCount: 0,
            toolBreakdown: {}, toolSurface: tools!, surfaceToolNames: ['release_status', 'release_change', 'coo_admin'],
            surfaceToolCount: 3, durationMs: 0, logPath: null, eventCounts: {}, assertions: [],
          };
        },
        () => resolveCorpusRunSafety({}, { enabled: true, source: 'flag' }, ['release_status', 'release_change', 'coo_admin']),
        () => ['release_status', 'release_change', 'coo_admin'],
      );
      const output = JSON.parse(readFileSync(out, 'utf8')) as { surface: string; records: Array<{ id: string }> };
      const relItems = corpus.items.filter((item) => item.id.startsWith('rel-'));
      expect(seen).toEqual(relItems.map(({ prompt }) => ({ prompt, tools: 'webterm' })));
      expect(output.surface).toBe('webterm');
      expect(output.records.map(({ id }) => id)).toEqual(relItems.map(({ id }) => id));
    } finally {
      console.log = previousLog;
      process.argv = previousArgv;
      for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
      Object.assign(process.env, previousEnv);
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('a whitespace-equivalent prompt with conflicting routing fails and names the prompt', () => {
    const original = corpus.items[0]!;
    const conflicting = { ...original, id: 'conflicting', prompt: `  ${original.prompt.replace(' ', '  ')}  `, accept: ['release_change'] };
    expect(() => assertUniqueRouting([original, conflicting])).toThrow(`Conflicting release NL routing for "${original.prompt}"`);
    expect(() => assertUniqueRouting([original, { ...conflicting, accept: original.accept }])).toThrow(`Duplicate release NL prompt: "${original.prompt}"`);
  });

  test('a removed contrast rejection is not silently treated as gradable', () => {
    const control = corpus.items.find((item) => item.id === 'release-contrast-status-01')!;
    expect(() => assertGradableItems([{ ...control, reject: [] }])).toThrow('release-contrast-status-01');
  });
});
