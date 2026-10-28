import { describe, expect, test } from 'bun:test';
import type { ReferenceCard } from './ref-index.js';
import {
  DEFAULT_MAX_PER_INDEX,
  proactiveReferences,
  type ProactiveReferenceSources,
  type ReferenceHit,
} from './proactive-ground.js';

/** A query function that records how many times it was asked, and with what. */
function index(hits: ReferenceHit[]): { query: (request: string) => ReferenceHit[]; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    query: (request: string) => {
      calls.push(request);
      return hits;
    },
  };
}

const card = (id: string): ReferenceCard => ({
  id,
  kind: 'local-repo',
  name: id,
  oneLine: '',
  directories: [],
  titles: [],
  commands: [],
  truncated: false,
  orchestrationId: `grounding:local-repo:${id}`,
});

describe('proactiveReferences', () => {
  test('asks all three indexes once, with the request, and merges what came back', () => {
    const ours = index([{ ref: 'elanous:src/self-dev/graph-journey-nodes.ts', title: 'Journey nodes resume', score: 9 }]);
    const others = index([{ ref: 'langgraph:docs/checkpointer.md', title: 'Checkpointer', score: 7 }]);
    const failed = index([{ ref: 'run:26022', title: 'Retargeted bench base', score: 4 }]);
    const sources: ProactiveReferenceSources = { ours: ours.query, others: others.query, failed: failed.query };

    const result = proactiveReferences('에이전트 체크포인트·재개', sources);

    expect(ours.calls).toEqual(['에이전트 체크포인트·재개']);
    expect(others.calls).toEqual(['에이전트 체크포인트·재개']);
    expect(failed.calls).toEqual(['에이전트 체크포인트·재개']);
    expect(result.silent).toBe(false);
    expect(result.refs.map((r) => [r.index, r.ref])).toEqual([
      ['ours', 'elanous:src/self-dev/graph-journey-nodes.ts'],
      ['others', 'langgraph:docs/checkpointer.md'],
      ['failed', 'run:26022'],
    ]);
    expect(result.refs[0]?.title).toBe('Journey nodes resume');
    expect(result.refs[1]?.score).toBe(7);
  });

  test('drops hits with no ref (source id ⊕ file path) and keeps the rest', () => {
    const ours = index([
      { ref: 'elanous:docs/RFC-harness-full-journey-as-graph-2026-10-08.md', title: 'RFC §4g', score: 8 },
      { title: 'no ref at all', score: 99 },
      { ref: '', title: 'empty ref', score: 99 },
      { ref: '   ', title: 'blank ref', score: 99 },
    ]);
    const result = proactiveReferences('재개', { ours: ours.query, others: index([]).query, failed: index([]).query });

    expect(result.refs.map((r) => r.ref)).toEqual(['elanous:docs/RFC-harness-full-journey-as-graph-2026-10-08.md']);
    expect(result.silent).toBe(false);
  });

  test('drops hits under opts.minScore and keeps the boundary score', () => {
    const ours = index([
      { ref: 'high', title: 'high', score: 5 },
      { ref: 'boundary', title: 'boundary', score: 3 },
      { ref: 'low', title: 'low', score: 2.9 },
    ]);
    const result = proactiveReferences('체크포인트', { ours: ours.query, others: index([]).query, failed: index([]).query }, { minScore: 3 });

    expect(result.refs.map((r) => r.ref)).toEqual(['high', 'boundary']);
  });

  test('barely scored hits survive the default floor', () => {
    const ours = index([
      { ref: 'zero', title: 'zero', score: 0 },
      { ref: 'negative', title: 'negative', score: -1 },
    ]);
    const result = proactiveReferences('재개', { ours: ours.query, others: index([]).query, failed: index([]).query });

    expect(result.refs.map((r) => r.ref)).toEqual(['zero']);
  });

  test('keeps at most two hits per index by default, strongest first', () => {
    expect(DEFAULT_MAX_PER_INDEX).toBe(2);
    const ours = index([
      { ref: 'third', title: 'third', score: 1 },
      { ref: 'first', title: 'first', score: 9 },
      { ref: 'second', title: 'second', score: 5 },
    ]);
    const others = index([{ ref: 'only', title: 'only', score: 2 }]);

    const result = proactiveReferences('재개', { ours: ours.query, others: others.query, failed: index([]).query });

    expect(result.refs.map((r) => [r.index, r.ref])).toEqual([
      ['ours', 'first'],
      ['ours', 'second'],
      ['others', 'only'],
    ]);
  });

  test('opts.perIndex overrides the per-index cap', () => {
    const hits: ReferenceHit[] = [
      { ref: 'a', title: 'a', score: 3 },
      { ref: 'b', title: 'b', score: 2 },
      { ref: 'c', title: 'c', score: 1 },
    ];
    const sources: ProactiveReferenceSources = { ours: index(hits).query, others: index([]).query, failed: index([]).query };

    expect(proactiveReferences('재개', sources, { perIndex: 1 }).refs.map((r) => r.ref)).toEqual(['a']);
    expect(proactiveReferences('재개', sources, { perIndex: 3 }).refs.map((r) => r.ref)).toEqual(['a', 'b', 'c']);
  });

  test('is silent when every index came back empty — and when everything was filtered out', () => {
    const empty = proactiveReferences('그냥 배포 스크립트 정리', {
      ours: index([]).query,
      others: index([]).query,
      failed: index([]).query,
    });
    expect(empty).toEqual({ refs: [], silent: true });

    const filtered = proactiveReferences('재개', {
      ours: index([{ ref: 'elow', title: 'elow', score: 1 }, { title: 'no ref', score: 9 }]).query,
      others: index([]).query,
      failed: index([]).query,
    }, { minScore: 2 });
    expect(filtered).toEqual({ refs: [], silent: true });
  });

  test('a requirement unrelated to the indexes grounds nothing (RFC §4g: 0 refs)', () => {
    const ours = index([]);
    const others = index([]);
    const failed = index([]);

    const result = proactiveReferences('웹훅 타임아웃 상수를 30초로 바꾼다', {
      ours: ours.query,
      others: others.query,
      failed: failed.query,
    });

    expect(result.refs).toEqual([]);
    expect(result.silent).toBe(true);
    expect(ours.calls.length + others.calls.length + failed.calls.length).toBe(3);
  });

  test('a checkpoint/resume requirement keeps its linked reference (RFC §4g: 1+ with a link)', () => {
    const result = proactiveReferences('에이전트 체크포인트·재개를 구현한다', {
      ours: index([]).query,
      others: index([{ ref: 'langgraph:docs/checkpointer.md', title: 'Checkpointer', score: 6 }]).query,
      failed: index([]).query,
    });

    expect(result.silent).toBe(false);
    expect(result.refs).toHaveLength(1);
    expect(result.refs[0]?.ref).toBe('langgraph:docs/checkpointer.md');
  });

  test('carries the reference card identity through when the index supplied one, without touching the input', () => {
    const alpha = card('alpha');
    const hits: ReferenceHit[] = [{ ref: 'alpha:docs/intro.md', title: 'Intro', score: 4, card: alpha }];
    const sources: ProactiveReferenceSources = { ours: index(hits).query, others: index([]).query, failed: index([]).query };

    const result = proactiveReferences('재개', sources, { perIndex: 1 });

    expect(result.refs[0]?.card).toEqual(alpha);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ ref: 'alpha:docs/intro.md', title: 'Intro', score: 4, card: alpha });
  });
});
