import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { prefetchSources, prefetchTopics, type PrefetchCell } from './ref-prefetch.js';

const twoVersions: PrefetchCell[] = [
  { id: 'g1', title: 'UniqueGreen already shipped', status: 'green', until: '2026-10-20' },
  { id: 'g2', title: 'UniqueGreen still green', status: 'green', until: '2026-10-20' },
  { id: 'g3', title: 'UniqueGreen on the later board', status: 'green', until: '2026-10-27' },
  { id: 'y1', title: 'Wire LangGraph checkpoint', status: 'yellow', until: '2026-10-20' },
  { id: 'y2', title: 'Resume LangGraph runs', status: 'yellow', until: '2026-10-27' },
  {
    id: 'y3',
    title: 'Index `checkpointer` notes',
    status: 'yellow',
    until: '2026-10-20',
    refs: ['docs/RFC-harness-full-journey-as-graph-2026-10-08.md#§4g'],
  },
];

test('shared token across two versions ranks first, green cells drop, why carries cell ids', () => {
  const topics = prefetchTopics(twoVersions);
  expect(topics[0]?.topic).toBe('LangGraph');
  expect(topics[0]?.cellIds).toEqual(['y1', 'y2']);
  expect(topics[0]?.until).toBe('2026-10-27');
  expect(topics.map((row) => row.topic)).not.toContain('UniqueGreen');
  expect(topics.some((row) => row.cellIds.includes('g1') || row.cellIds.includes('g2') || row.cellIds.includes('g3'))).toBe(false);
  expect(topics.map((row) => row.topic)).toContain('checkpointer');
  expect(topics.map((row) => row.topic)).toContain('RFC-harness-full-journey-as-graph');

  const sources = prefetchSources(topics, 'MK', new Date('2026-10-11T12:00:00.000Z'));
  expect(sources[0]).toMatchObject({
    kind: 'github-query',
    spec: 'LangGraph',
    every: '1d',
    until: '2026-10-27',
    seat: 'MK',
    why: 'REF-PREFETCH ⊕ y1 y2',
  });
  expect(sources[0]?.why).toContain('y1');
  expect(sources[0]?.why).toContain('y2');
  expect(sources.every((source) => source.kind === 'github-query' && source.every === '1d')).toBe(true);
});

test('opts.max defaults to 5 and caps the ranked list', () => {
  const cells: PrefetchCell[] = [
    { id: 'a', title: 'AlphaOne', status: 'yellow' },
    { id: 'b', title: 'BetaTwo', status: 'yellow' },
    { id: 'c', title: 'GammaThree', status: 'yellow' },
    { id: 'd', title: 'DeltaFour', status: 'yellow' },
    { id: 'e', title: 'EpsilonFive', status: 'yellow' },
    { id: 'f', title: 'ZetaSix', status: 'yellow' },
  ];
  expect(prefetchTopics(cells)).toHaveLength(5);
  expect(prefetchTopics(cells, { max: 2 }).map((row) => row.topic)).toEqual(['AlphaOne', 'BetaTwo']);
});

test('prefetchSources leaves until unset when the board date is unknown (no already-expired proposal)', () => {
  const now = new Date('2026-10-11T12:00:00.000Z');
  const [source] = prefetchSources([{ topic: 'crewAI', cellIds: ['cell-1'] }], 'OP', now);
  expect(source).toMatchObject({
    id: 'ref-prefetch-crewAI',
    seat: 'OP',
    kind: 'github-query',
    spec: 'crewAI',
    every: '1d',
    why: 'REF-PREFETCH ⊕ cell-1',
  });
  expect(source).not.toHaveProperty('until');
});

test('ref-prefetch only proposes: no value import of intake-sources and no addSource call', () => {
  const src = readFileSync(new URL('./ref-prefetch.ts', import.meta.url), 'utf8');
  expect(src).not.toMatch(/\baddSource\s*\(/);
  expect(src).not.toMatch(/^import\s+(?!type\b)[^;]*intake-sources/m);
});
