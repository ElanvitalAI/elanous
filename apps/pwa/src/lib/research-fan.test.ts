import { describe, expect, test } from 'bun:test';
import type { LogRow } from '@/nexus/client';
import { researchSessions } from './research-fan';

const t0 = Date.parse('2026-09-28T02:40:00.000Z');
const r = (s: number, event: string, data: Record<string, unknown>, category = 'research'): LogRow => ({ ts: new Date(t0 + s * 1000).toISOString(), category, event, data });

describe('research fan (가짜 이벤트 — 착지 전 모양)', () => {
  test('query → engines fan; results fill hits/ms/error; sources give the share (merged not counted)', () => {
    const rows = [
      r(0, 'research.query', { question: 'bun sqlite WAL', engines: ['grok', 'firecrawl', 'tavily'], runId: 'run-x' }),
      r(1, 'research.result', { id: 'grok', hits: 3, ms: 900, runId: 'run-x' }),
      r(2, 'research.result', { id: 'firecrawl', hits: 0, ms: 1200, error: 'rate limited', runId: 'run-x' }),
      r(2, 'research.source', { url: 'https://www.bun.sh/docs/api/sqlite', engine: 'grok', runId: 'run-x' }),
      r(3, 'research.source', { url: 'https://bun.sh/docs/api/sqlite', engine: 'tavily', merged: true, runId: 'run-x' }),
      r(3, 'result', { id: 'tavily', hits: 5, ms: 700, runId: 'run-x' }),
      r(4, 'plan', { runId: 'run-x' }, 'dev-pipeline'),
    ];
    const [s] = researchSessions(rows);
    expect(s!.question).toBe('bun sqlite WAL');
    expect(s!.engines).toEqual([
      { id: 'grok', hits: 3, ms: 900, error: null, done: true },
      { id: 'firecrawl', hits: 0, ms: 1200, error: 'rate limited', done: true },
      { id: 'tavily', hits: 5, ms: 700, error: null, done: true },
    ]);
    expect(s!.sources.map((x) => x.host)).toEqual(['bun.sh', 'bun.sh']);
    expect(s!.share).toEqual({ grok: 1 });
  });

  test('newest session first; results without runId attach to the latest query', () => {
    const rows = [
      r(0, 'query', { question: 'a', engines: ['grok'] }),
      r(10, 'query', { question: 'b', engines: ['firecrawl'] }),
      r(11, 'result', { id: 'firecrawl', hits: 2, ms: 300 }),
    ];
    const s = researchSessions(rows);
    expect(s.map((x) => x.question)).toEqual(['b', 'a']);
    expect(s[0]!.engines[0]).toMatchObject({ hits: 2, done: true });
    expect(s[1]!.engines[0]!.done).toBe(false);
  });

  test('stage fields: tier, credits, title/cited/scraped, and the decision «why» that follows the research', () => {
    const rows = [
      r(0, 'research.query', { question: 'q', engines: ['grok', 'firecrawl'], tier: 'full', runId: 'run-y' }),
      r(1, 'research.result', { id: 'firecrawl', hits: 2, ms: 800, credits: 5, runId: 'run-y' }),
      r(2, 'research.source', { url: 'https://a.dev/x', engine: 'firecrawl', title: 'A 문서', scraped: true, cited: true, runId: 'run-y' }),
      r(3, 'decision', { kind: 'PLAN', what: 'WAL 로 간다', reason: 'A 문서가 동시 쓰기를 막는다고 한다', runId: 'run-y' }, 'harness.decision'),
      r(4, 'decision', { kind: 'PLAN', what: '다른 런', reason: 'x', runId: 'run-z' }, 'harness.decision'),
    ];
    const [s] = researchSessions(rows);
    expect(s!.tier).toBe('full');
    expect(s!.engines.find((e) => e.id === 'firecrawl')!.credits).toBe(5);
    expect(s!.sources[0]).toMatchObject({ title: 'A 문서', cited: true, scraped: true });
    expect(s!.why).toBe('A 문서가 동시 쓰기를 막는다고 한다');
    expect(researchSessions(rows)).toHaveLength(1);
  });
});
