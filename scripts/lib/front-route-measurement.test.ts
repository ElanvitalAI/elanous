import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ResolveRoleProviderFn } from '../../src/intake-plane/runtime-callables.js';
import type { IntakeFrontRouteDecision, IntakeFrontRouteTrack } from '../../src/intake-plane/front-route-rules.js';
import { decideIntakeFrontRoute } from '../../src/intake-plane/front-route-rules.js';
import { formatFrontRouteReport, loadFrontRouteCorpus, measureFrontRoute } from './front-route-measurement.js';
import { frontRouteProviders, parseFrontRouteArgs } from '../measure-front-route-classifier.js';

const items = loadFrontRouteCorpus({ description: 'synthetic', items: [
  { id: 'a', text: 'private-content-absorb', expected: 'absorb' },
  { id: 't', text: 'private-content-tasks', expected: 'tasks' },
  { id: 'g', text: 'private-content-graph', expected: 'graph' },
  { id: 'h', text: 'private-content-human', expected: 'ask-human' },
] }).items;
const resolveA: ResolveRoleProviderFn = () => ({ provider: { name: 'A' } });
const resolveB: ResolveRoleProviderFn = () => ({ provider: { name: 'B' } });
const expectedByText = new Map(items.map((item) => [item.text, item.expected]));

const classify = async (text: string, deps?: { resolveRoleProvider?: ResolveRoleProviderFn }): Promise<IntakeFrontRouteDecision> => {
  const expected = expectedByText.get(text)!;
  const provider = deps?.resolveRoleProvider!('classify').provider.name;
  const track: IntakeFrontRouteTrack = provider === 'B'
    ? expected === 'graph' ? 'tasks' : expected === 'absorb' ? 'ask-human' : expected
    : expected;
  return { track, confidence: track === 'ask-human' && expected === 'absorb' ? 0.2 : 0.9,
    reason: track === 'ask-human' && expected === 'absorb' ? 'classifier-low-confidence:absorb' : 'ok', decidedBy: 'classifier' };
};

describe('front-route corpus', () => {
  test('rejects unknown track, empty text and duplicate id', () => {
    const good = { description: 'synthetic', items: [{ id: 'a', text: 'a', expected: 'absorb' }] };
    expect(() => loadFrontRouteCorpus({ ...good, items: [{ ...good.items[0], expected: 'alien' }] })).toThrow();
    expect(() => loadFrontRouteCorpus({ ...good, items: [{ ...good.items[0], text: '  ' }] })).toThrow();
    expect(() => loadFrontRouteCorpus({ ...good, items: [good.items[0], good.items[0]] })).toThrow();
  });

  test('sample is 12 distinct hand-written Korean rule-unknown items, three per track', () => {
    const sample = loadFrontRouteCorpus(readFileSync(resolve(import.meta.dir, '../fixtures/front-route-corpus.sample.json'), 'utf8'));
    expect(sample.items).toHaveLength(12);
    for (const track of ['absorb', 'tasks', 'graph', 'ask-human']) {
      expect(sample.items.filter((item) => item.expected === track)).toHaveLength(3);
    }
    for (const item of sample.items) {
      expect(item.text).toMatch(/[가-힣]/);
      expect(decideIntakeFrontRoute({ text: item.text, consent: 'route' }).reason).toBe('rule-unknown');
    }
  });
});

test('two providers on the same items and labels count agreement, confusion, fallback and latency', async () => {
  let tick = 0;
  const [a, b] = await measureFrontRoute(items, {
    providers: [{ label: 'A', resolve: resolveA }, { label: 'B', resolve: resolveB }],
    runs: 2, classify, now: () => tick++,
  });
  expect(a!.runs).toBe(8);
  expect(a!.agreement).toBe(1);
  expect(a!.askHuman).toBe(0);
  expect(b!.runs).toBe(8);
  expect(b!.agree).toBe(4);
  expect(b!.agreement).toBe(0.5);
  expect(b!.confusion.graph.tasks).toBe(2);
  expect(b!.confusion.absorb['ask-human']).toBe(2);
  expect(b!.askHuman).toBe(2);
  expect(a!.wilson).not.toBeNull();
  expect(b!.wilson).not.toBeNull();
  expect(b!.meanLatencyMs).toBe(1);
  expect(b!.perItem.find((item) => item.id === 'g')?.got).toEqual(['tasks', 'tasks']);
  const report = formatFrontRouteReport([a!, b!]);
  expect(report).toContain('95% Wilson');
  expect(report).toContain('Confusion (B)');
  for (const item of items) expect(report).not.toContain(item.text);
  expect(JSON.stringify([a, b])).not.toContain('private-content');
});

test('a corpus id equal to its text never exposes that text through the JSON result or report', async () => {
  const secret = '개인정보가 담긴 본문';
  const sensitive = loadFrontRouteCorpus({ description: 'synthetic', items: [
    { id: secret, text: secret, expected: 'graph' },
    { id: 'item-1', text: '다른 합성 문장', expected: 'tasks' },
  ] }).items;
  const [result] = await measureFrontRoute(sensitive, {
    providers: [{ label: 'A', resolve: resolveA }], runs: 1,
    classify: async (text) => ({ track: text === secret ? 'graph' : 'tasks', confidence: 0.9,
      reason: 'ok', decidedBy: 'classifier' }),
  });
  expect(result!.perItem[0]!.id).not.toBe(secret);
  expect(result!.perItem[0]!.id).not.toBe(result!.perItem[1]!.id);
  expect(result!.perItem[1]!.id).toBe('item-1');
  expect(result!.agreement).toBe(1);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(formatFrontRouteReport([result!])).not.toContain(secret);

  const [crossItem] = await measureFrontRoute([
    { id: 'safe', text: '다른 본문', expected: 'graph' },
    { id: '다른 본문', text: secret, expected: 'graph' },
  ], { providers: [{ label: 'A', resolve: resolveA }], runs: 1,
    classify: async () => ({ track: 'graph', confidence: 0.9, reason: 'ok', decidedBy: 'classifier' }) });
  expect(JSON.stringify(crossItem)).not.toContain('다른 본문');
  expect(JSON.stringify(crossItem)).not.toContain(secret);
});

test('a thrown classification is an ask-human failure in the measured denominator', async () => {
  const [result] = await measureFrontRoute(items.slice(0, 1), {
    providers: [{ label: 'A', resolve: resolveA }], runs: 2,
    classify: async () => { throw new Error('sensitive prompt'); }, now: () => 1,
  });
  expect(result!.runs).toBe(2);
  expect(result!.confusion.absorb['ask-human']).toBe(2);
  expect(result!.askHuman).toBe(2);
  expect(JSON.stringify(result)).not.toContain('sensitive prompt');
});

test('runner parses repeated provider specs and injects registered provider plus model', () => {
  expect(parseFrontRouteArgs(['--provider', 'local/model-x', '--provider', 'codex', '--runs', '2', '--json']))
    .toEqual({ providers: ['local/model-x', 'codex'], runs: 2, json: true });
  expect(parseFrontRouteArgs([])).toEqual({ providers: [], runs: 1, json: false });
  for (const args of [['--runs', '0'], ['--runs', '1.5'], ['--provider'], ['--provider', 'bad/'], ['--other']]) {
    expect(() => parseFrontRouteArgs(args)).toThrow();
  }
  const provider = { name: 'local', defaultModel: 'default-model' };
  const registry = { local: provider } as unknown as Parameters<typeof frontRouteProviders>[1];
  const [explicit, fallback] = frontRouteProviders(['local/model-x', 'local'], registry);
  expect(explicit!.resolve('classify')).toMatchObject({ provider, model: 'model-x' });
  expect(fallback!.resolve('classify')).toMatchObject({ provider, model: 'default-model' });
  expect(() => frontRouteProviders(['not-a-provider'], registry)).toThrow('Unknown provider');
});
