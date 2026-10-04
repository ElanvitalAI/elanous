import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import type { DecisionEntry } from '../decisions/decision-ledger.js';
import { runContextCondense } from './condense.js';
import type { CoordEvent } from './coord-events.js';
import { condenseContextDay, condenseContextWindowWithReport, type MemorySource } from './long-term-memory.js';

const day = '2026-10-02';
const now = new Date('2026-10-03T00:00:00.000Z');
const event = (n: number, seat = 'TC', kind = '보고'): CoordEvent => ({
  id: `event-${n}`, at: `${day}T${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00.000Z`,
  kind, text: `project-alpha/topic-${n}/on`, summary: `project-alpha/topic-${n}/on`,
  refs: { seat, recipients: [], all: false, kind, slot: null, deadline: null, url: `https://example.test/${n}` },
});
const summarize = async (source: MemorySource) => {
  const [project, topic, value] = source.text.split('/');
  return { project: project!, topic: topic!, summary: `${topic} is ${value}`, claim: { key: topic!, value: value! } };
};

test('five sources keep two memories and count each unusable source; an all-unusable window still reports skips', async () => {
  const logs: Array<{ event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'context.condense') logs.push({ event, data });
  });
  try {
    const events = [
      { ...event(0), summary: 'alpha/first/on' },
      { ...event(1), summary: 'alpha/second/on' },
      { ...event(2), summary: 'alpha/missing/on', refs: { ...event(2).refs, seat: undefined } },
      { ...event(3), summary: 'alpha/file/on', refs: { ...event(3).refs, url: '/tmp/source.txt' } },
      { ...event(4), summary: 'alpha/broken/on' },
    ] as CoordEvent[];
    const deps = { events: () => events, decisions: () => [], summarize: async (source: MemorySource) => {
      if (source.text === 'alpha/broken/on') throw new Error('invalid memory summary: raw source text must not be logged');
      return summarize(source);
    } };
    const since = `${day}T00:00:00.000Z`;
    const until = '2026-10-03T00:00:00.000Z';
    const result = await condenseContextWindowWithReport(since, until, [], deps, now);
    expect(result.cards.map(card => card.topic)).toEqual(['first', 'second']);
    expect(result.skipped).toEqual({ 'no-seat': 1, 'bad-link': 1, 'summarize-failed': 1 });
    expect(result.funnel.read.total - result.funnel.sources.total).toBe(result.funnel.sources.noSeat.total);
    expect(result.funnel.sources.noSeat).toEqual({ total: 1, bySeat: { '(unknown)': 1 } });
    expect(result.funnel.sources.total - result.funnel.summarized.total).toBe(1);
    expect(result.funnel.summarized.summarizeFailed).toEqual({ total: 1, bySeat: { TC: 1 } });
    expect(logs.filter(entry => entry.event === 'source-skipped')).toHaveLength(3);
    expect(logs.filter(entry => entry.event === 'source-skipped').map(entry => entry.data)).toEqual([
      { reason: 'no-seat', kind: 'event', at: event(2).at },
      { reason: 'bad-link', kind: 'event', at: event(3).at },
      { reason: 'summarize-failed', kind: 'event', at: event(4).at },
    ]);
    expect(logs.at(-1)).toEqual({ event: 'funnel', data: result.funnel });
    expect(logs.at(-2)).toEqual({ event: 'window', data: { sources: 5, kept: 2, skipped: result.skipped } });
    expect(JSON.stringify(logs)).not.toContain('raw source text');
    logs.length = 0;
    const empty = await condenseContextWindowWithReport(since, until, [], { ...deps, events: () => [events[2]!] }, now);
    expect(empty).toEqual({ cards: [], skipped: { 'no-seat': 1 }, folded: 0, droppedHarnessChild: 0,
      funnel: { read: { total: 1, bySeat: { '(unknown)': 1 }, bySurface: { '(unknown)': 1 } },
        sources: { total: 0, bySeat: {}, folded: { total: 0, bySeat: {} },
          droppedHarnessChild: { total: 0, bySeat: {} }, noSeat: { total: 1, bySeat: { '(unknown)': 1 } } },
        summarized: { total: 0, bySeat: {}, accepted: { total: 0, bySeat: {} },
          summarizeFailed: { total: 0, bySeat: {} }, skipped: { 'no-seat': { total: 1, bySeat: { '(unknown)': 1 } } } },
        collapsed: { total: 0, bySeat: {} }, cards: { total: 0, bySeat: {}, carried: { total: 0, bySeat: {} }, supersededByPrevious: { total: 0, bySeat: {} } } } });
    expect(logs.at(-2)).toEqual({ event: 'window', data: { sources: 1, kept: 0, skipped: { 'no-seat': 1 } } });
  } finally { log.mockRestore(); }
});

test('per-seat funnel reconciles read, child drop, no-claim, key collapses and cards', async () => {
  const events = [
    ...[0, 1, 2].map(n => ({ ...event(n, 'OP'), summary: `alpha/release/${n}`,
      surface: 'coord:channel' })),
    { ...event(3, 'TC'), summary: 'alpha/mention/on', surface: 'coord:channel' },
    ...[4, 5].map(n => ({ ...event(n, 'MK'), summary: `alpha/mk-${n}/on`,
      surface: 'coord:channel' })),
    { ...event(6, 'harness-child', 'finished'), surface: 'context:external' },
  ];
  const report = await condenseContextWindowWithReport(`${day}T00:00:00.000Z`,
    '2026-10-03T00:00:00.000Z', [], { events: () => events, decisions: () => [],
      summarize: async source => {
        const [project, topic, value] = source.text.split('/');
        return { project: project!, topic: topic!, summary: source.text,
          ...(source.seat === 'TC' ? {} : { claim: { key: topic!, value: value! } }) };
      } }, now);
  const { read, sources, summarized, collapsed, cards } = report.funnel;
  expect(read).toEqual({ total: 7, bySeat: { OP: 3, TC: 1, MK: 2, 'harness-child': 1 },
    bySurface: { 'coord:channel': 6, 'context:external': 1 } });
  expect(sources).toEqual({ total: 6, bySeat: { OP: 3, TC: 1, MK: 2 },
    folded: { total: 0, bySeat: {} }, droppedHarnessChild: { total: 1, bySeat: { 'harness-child': 1 } },
    noSeat: { total: 0, bySeat: {} } });
  expect(summarized).toEqual({ total: 6, bySeat: { OP: 3, TC: 1, MK: 2 },
    accepted: { total: 5, bySeat: { OP: 3, MK: 2 } },
    summarizeFailed: { total: 0, bySeat: {} }, skipped: { 'no-claim': { total: 1, bySeat: { TC: 1 } } } });
  expect(collapsed).toEqual({ total: 2, bySeat: { OP: 2 } });
  expect(cards).toEqual({ total: 3, bySeat: { OP: 1, MK: 2 }, carried: { total: 0, bySeat: {} },
    supersededByPrevious: { total: 0, bySeat: {} } });
  expect(report.skipped).toEqual({ 'no-claim': 1 });
  expect(report.droppedHarnessChild).toBe(1);
  expect(read.total - sources.total).toBe(sources.folded.total + sources.droppedHarnessChild.total + sources.noSeat.total);
  expect(sources.total - summarized.total).toBe(summarized.summarizeFailed.total);
  expect(summarized.total - summarized.accepted.total).toBe(summarized.skipped['no-claim']!.total);
  expect(summarized.accepted.total - cards.total).toBe(collapsed.total);
});

test('previous snapshot cards remain visible without being counted as new candidates', async () => {
  const previous = [
    { project: 'alpha', seat: 'TC', topic: 'release', summary: 'newer', source: 'https://example.test/newer',
      updatedAt: `${day}T01:00:00.000Z`, status: 'active' as const },
    { project: 'alpha', seat: 'UX', topic: 'carry', summary: 'kept', source: 'https://example.test/carry',
      updatedAt: `${day}T01:00:00.000Z`, status: 'active' as const },
  ];
  const report = await condenseContextWindowWithReport(`${day}T00:00:00.000Z`,
    '2026-10-03T00:00:00.000Z', previous, { events: () => [{ ...event(0), summary: 'alpha/release/old' }],
      decisions: () => [], summarize }, now);
  expect(report.cards).toHaveLength(2);
  expect(report.cards.find(card => card.seat === 'TC')?.summary).toBe('newer');
  const { read, sources, summarized, collapsed, cards } = report.funnel;
  expect(cards).toEqual({ total: 2, bySeat: { TC: 1, UX: 1 },
    carried: { total: 1, bySeat: { UX: 1 } }, supersededByPrevious: { total: 1, bySeat: { TC: 1 } } });
  expect(read.total - sources.total).toBe(sources.folded.total + sources.droppedHarnessChild.total + sources.noSeat.total);
  expect(sources.total - summarized.total).toBe(summarized.summarizeFailed.total);
  expect(summarized.accepted.total - collapsed.total + cards.carried.total).toBe(cards.total);
  expect(cards.supersededByPrevious.total).toBe(1);
});

test('six lifecycle, report and decision events fold to five summarizer calls before skips', async () => {
  const runA = 'elanous://harness/run-A/pty-A';
  const runB = 'elanous://harness/run-B/pty-B';
  const at = (n: number) => `${day}T00:${String(n).padStart(2, '0')}:00.000Z`;
  const lifecycle = (n: number, run: string, kind: string, summary: string): CoordEvent => ({
    ...event(n, 'TC', kind), at: at(n), summary,
    refs: { ...event(n).refs, seat: 'TC', source: run, url: null },
  });
  const events = [lifecycle(1, runA, 'started', 'Harness child started'),
    lifecycle(4, runA, 'finished', 'Harness child finished: success'),
    lifecycle(2, runB, 'started', 'Harness child started'),
    { ...event(3, 'MK'), at: at(3), summary: 'MK report' },
    { ...event(5), at: at(5), summary: 'unassigned' }];
  const decision = { id: 'D-fold', title: 'release', status: 'decided', decidedAt: at(6),
    raisedBy: { agent: 'OP', track: 'OP' }, choice: 'a', options: [{ key: 'a', label: 'go', consequence: 'ship' }],
    scqa: { s: 'release', c: 'choice' } } as DecisionEntry;
  const calls: MemorySource[] = [];
  const logs: Array<{ event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, name, data) => {
    if (category === 'context.condense') logs.push({ event: name, data });
  });
  try {
    const report = await condenseContextWindowWithReport(`${day}T00:00:00.000Z`,
      '2026-10-03T00:00:00.000Z', [], {
        events: () => events, decisions: () => [decision], summarize: async source => {
          calls.push(source);
          return { project: source.text === 'unassigned' ? '' : 'alpha', topic: source.source,
            summary: source.text, claim: { key: source.source, value: source.text } };
        },
      }, now);
    expect(calls).toHaveLength(5);
    expect(calls.map(source => source.source)).toEqual([runB, 'https://example.test/3', runA,
      'https://example.test/5', 'elanous://decisions/D-fold']);
    expect(calls.find(source => source.source === runA)?.text).toBe(`${runA} success · 3m 0s`);
    expect(calls.find(source => source.source === runB)?.text).toBe(`${runB} 진행 중 · 알 수 없음`);
    expect(report.cards.find(card => card.source === runA)).toMatchObject({
      seat: 'TC', updatedAt: at(4), summary: `${runA} success · 3m 0s`,
    });
    expect(report.cards.filter(card => card.source === runA)).toHaveLength(1);
    expect(report.folded).toBe(1);
    expect(report.funnel).toMatchObject({ read: { total: 6, bySeat: { TC: 4, MK: 1, OP: 1 } },
      sources: { total: 5, folded: { total: 1, bySeat: { TC: 1 } } },
      summarized: { total: 5, accepted: { total: 4 },
        skipped: { 'no-project': { total: 1, bySeat: { TC: 1 } } } },
      collapsed: { total: 0 }, cards: { total: 4 } });
    expect(report.skipped).toEqual({ 'no-project': 1 });
    expect(logs.find(entry => entry.event === 'folded')).toEqual({ event: 'folded',
      data: { harnessEvents: 3, kept: 2, droppedHarnessChild: 0 } });
    const cliReport = await runContextCondense({ hours: 24, now, apply: false }, {
      events: () => events, decisions: () => [decision], summarize: async source => ({
        project: source.text === 'unassigned' ? '' : 'alpha', topic: source.source, summary: source.text,
        claim: { key: source.source, value: source.text },
      }),
    });
    expect(cliReport).toMatchObject({ skipped: { 'no-project': 1 }, folded: 1 });
    expect(JSON.parse(JSON.stringify({ skipped: cliReport.skipped, folded: cliReport.folded })))
      .toEqual({ skipped: { 'no-project': 1 }, folded: 1 });
  } finally { log.mockRestore(); }
});

test('lifecycle kind folds across source and URL while unrelated events and window edges stay separate', async () => {
  const run = 'https://example.test/run';
  const started = { ...event(1, 'MK', 'started'), refs: { ...event(1).refs, seat: 'MK', source: run, url: null } };
  const finished = { ...event(4, 'MK', 'finished'), summary: 'done',
    refs: { ...event(4).refs, seat: 'MK', url: run } };
  const unrelated = { ...event(2, 'MK'), summary: 'report', refs: { ...event(2).refs, url: run } };
  const outside = { ...event(5, 'harness-child', 'started'), at: '2026-10-03T00:00:00.000Z' };
  const calls: MemorySource[] = [];
  const report = await condenseContextWindowWithReport(`${day}T00:00:00.000Z`,
    '2026-10-03T00:00:00.000Z', [], {
      events: () => [finished, outside, unrelated, started], decisions: () => [],
      summarize: async source => { calls.push(source); return { project: 'alpha', topic: source.text,
        summary: source.text, claim: { key: source.text, value: source.text } }; },
    }, now);
  expect(calls).toHaveLength(2);
  expect(calls.map(source => source.text)).toEqual(['report', `${run} done · 3m 0s`]);
  expect(report.folded).toBe(1);
  expect(report.skipped).toEqual({});
  expect(report.cards).toHaveLength(2);
  expect(report.cards.find(card => card.topic === `${run} done · 3m 0s`)).toMatchObject({
    source: run, updatedAt: finished.at, seat: 'MK',
  });
});

test('a finish without seat inherits the matching start seat and produces a memory', async () => {
  const run = 'elanous://harness/missing-finish-seat';
  const started = { ...event(1, 'TC', 'started'),
    refs: { ...event(1).refs, seat: 'TC', source: run, url: null } };
  const finished = { ...event(4, 'TC', 'finished'), summary: 'Harness child finished: success',
    refs: { ...event(4).refs, seat: undefined, source: run, url: null } } as unknown as CoordEvent;
  const calls: MemorySource[] = [];
  const report = await condenseContextWindowWithReport(`${day}T00:00:00.000Z`,
    '2026-10-03T00:00:00.000Z', [], {
      events: () => [finished, started], decisions: () => [],
      summarize: async source => {
        calls.push(source);
        return { project: 'alpha', topic: 'run outcome', summary: source.text,
          claim: { key: 'run outcome', value: source.text } };
      },
    }, now);
  expect(calls).toEqual([{ kind: 'event', at: finished.at, seat: 'TC', source: run,
    text: `${run} success · 3m 0s` }]);
  expect(report.cards).toMatchObject([{ seat: 'TC', source: run, updatedAt: finished.at,
    summary: `${run} success · 3m 0s` }]);
  expect(report).toMatchObject({ folded: 1, skipped: {} });
});

test('a start just before the window supplies elapsed time without becoming a source or a fold', async () => {
  const run = 'elanous://harness/cross-window';
  const since = `${day}T00:02:00.000Z`;
  const before = { ...event(1, 'TC', 'started'), summary: 'Harness child started',
    at: `${day}T00:01:00.000Z`, refs: { ...event(1).refs, seat: 'TC', source: run, url: null } };
  const finish = { ...event(4, 'TC', 'finished'), summary: 'Harness child finished: success',
    at: `${day}T00:04:00.000Z`, refs: { ...event(4).refs, seat: 'TC', source: run, url: null } };
  const otherStart = { ...event(0, 'harness-child', 'started'), at: `${day}T00:00:00.000Z`,
    refs: { ...event(0).refs, seat: 'harness-child', source: 'elanous://harness/other', url: null } };
  const calls: MemorySource[] = [];
  let requestedSince = '';
  const report = await condenseContextWindowWithReport(since, '2026-10-03T00:00:00.000Z', [], {
    events: from => { requestedSince = from; return [finish, otherStart, before]; }, decisions: () => [],
    summarize: async source => { calls.push(source); return { project: 'alpha', topic: 'outcome', summary: source.text,
      claim: { key: 'outcome', value: source.text } }; },
  }, now);
  expect(requestedSince).toBe('2026-10-01T00:02:00.000Z');
  expect(calls).toEqual([{ kind: 'event', at: finish.at, seat: 'TC', source: run,
    text: `${run} success · 3m 0s` }]);
  expect(report.cards).toMatchObject([{ source: run, updatedAt: finish.at, summary: `${run} success · 3m 0s` }]);
  expect(report.folded).toBe(0);
  expect(report.skipped).toEqual({});
});

test('a shared URL folds different outer-run source links while harness-child reports retain their original text', async () => {
  const url = 'https://example.test/run-shared';
  const started = { ...event(1, 'TC', 'started'), summary: 'Harness child started',
    refs: { ...event(1).refs, seat: 'TC', source: 'elanous://harness/start', url } };
  const finished = { ...event(4, 'TC', 'finished'), summary: 'Harness child finished: success',
    refs: { ...event(4).refs, seat: 'TC', source: 'elanous://harness/finish', url } };
  const reportEvent = { ...event(2, 'harness-child'), summary: 'MK/report/on',
    refs: { ...event(2).refs, seat: 'harness-child', url } };
  const calls: MemorySource[] = [];
  const report = await condenseContextWindowWithReport(`${day}T00:00:00.000Z`,
    '2026-10-03T00:00:00.000Z', [], {
      events: () => [finished, reportEvent, started], decisions: () => [],
      summarize: async source => { calls.push(source); return { project: 'alpha', topic: source.text,
        summary: source.text, claim: { key: source.text, value: source.text } }; },
    }, now);
  expect(calls).toHaveLength(2);
  expect(calls.find(source => source.text === 'MK/report/on')).toEqual({
    kind: 'event', at: reportEvent.at, seat: 'harness-child', text: 'MK/report/on', source: url,
  });
  expect(calls.find(source => source.text !== 'MK/report/on')).toEqual({
    kind: 'event', at: finished.at, seat: 'TC',
    text: `${url} success · 3m 0s`, source: url,
  });
  expect(report.folded).toBe(1);
  expect(report.cards).toHaveLength(2);
  expect(report.cards.find(card => card.topic === 'MK/report/on')).toMatchObject({
    summary: 'MK/report/on', updatedAt: reportEvent.at,
  });
});

test('harness-child report with no lifecycle is summarized without a fabricated progress state but claimless result is skipped', async () => {
  const source = event(1, 'harness-child');
  const calls: MemorySource[] = [];
  const report = await condenseContextWindowWithReport(`${day}T00:00:00.000Z`,
    '2026-10-03T00:00:00.000Z', [], {
      events: () => [source], decisions: () => [], summarize: async item => {
        calls.push(item);
        return { project: 'alpha', topic: 'status', summary: item.text };
      },
    }, now);
  expect(calls).toEqual([{ kind: 'event', at: source.at, seat: 'harness-child',
    text: source.summary, source: source.refs.url! }]);
  expect(report).toMatchObject({ folded: 0, skipped: { 'no-claim': 1 }, cards: [] });
});

test('dry-run report exposes skip counts in JSON and Markdown without writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'condense-skips-'));
  try {
    const report = await runContextCondense({ hours: 24, now: new Date('2026-10-04T00:30:00.000Z'), root, apply: false }, {
      events: () => [{ ...event(0), at: '2026-10-03T12:00:00.000Z', refs: { ...event(0).refs, seat: undefined } } as unknown as CoordEvent],
      decisions: () => [], summarize,
    });
    expect(report.cards).toEqual([]);
    expect(report.skipped).toEqual({ 'no-seat': 1 });
    expect(JSON.parse(JSON.stringify(report)).skipped).toEqual({ 'no-seat': 1 });
    expect(report.markdown).toContain('Skipped: {"no-seat":1}');
    expect(report.applied).toBeUndefined();
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('each malformed summary field and claim is counted without blocking later sources', async () => {
  const events = Array.from({ length: 6 }, (_, n) => event(n));
  const result = await condenseContextWindowWithReport(`${day}T00:00:00.000Z`, '2026-10-03T00:00:00.000Z', [], {
    events: () => events, decisions: () => [], summarize: async source => {
      const n = Number(source.source.split('/').at(-1));
      if (n === 0) return { project: '', topic: 'x', summary: 'x' };
      if (n === 1) return { project: 'alpha', topic: '', summary: 'x' };
      if (n === 2) return { project: 'alpha', topic: 'x', summary: '' };
      if (n === 3) return { project: 'alpha', topic: 'x', summary: 'x', claim: { key: '', value: 'on' } };
      if (n === 4) return { project: 'alpha', topic: 'x', summary: 'x', claim: { key: 'x', value: '' } };
      return { project: 'alpha', topic: 'valid', summary: 'kept', claim: { key: 'valid', value: 'kept' } };
    },
  }, now);
  expect(result.cards).toMatchObject([{ topic: 'valid', summary: 'kept' }]);
  expect(result.skipped).toEqual({ 'no-project': 1, 'no-topic': 1, 'no-summary': 1, 'bad-claim': 2 });
});

test('claimless channel mentions are skipped while concrete channel values and a claimless decision become cards', async () => {
  const summaries = [
    'MK가 OP · TC · 보고 · K10을 언급함',
    'LOOP-CHECK1 #23657을 언급했다',
    'K10e 착지: #23507',
    '결정론 env 확인 건수: 6건',
  ];
  const events = summaries.map((summary, n) => ({ ...event(n, 'MK'), summary }));
  const decision = { id: 'D-no-claim', title: '착지 경로', status: 'decided',
    decidedAt: `${day}T00:04:00.000Z`, raisedBy: { agent: 'OP', track: 'OP' },
    choice: 'a', options: [{ key: 'a', label: '유지', consequence: '유지' }],
    scqa: { s: '착지', c: '경로 선택' } } as DecisionEntry;
  const logs: Array<{ event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, name, data) => {
    if (category === 'context.condense') logs.push({ event: name, data });
  });
  try {
    const report = await condenseContextWindowWithReport(`${day}T00:00:00.000Z`,
      '2026-10-03T00:00:00.000Z', [], {
        events: () => events, decisions: () => [decision],
        summarize: async source => ({ project: 'alpha', topic: source.text, summary: source.text,
          ...(source.text === summaries[2] ? { claim: { key: 'K10e 착지', value: '#23507' } } : {}),
          ...(source.text === summaries[3] ? { claim: { key: '결정론 env 확인 건수', value: '6건' } } : {}),
        }),
      }, now);
    expect(report.cards.map(card => card.source)).toEqual([
      'https://example.test/2', 'https://example.test/3', 'elanous://decisions/D-no-claim',
    ]);
    expect(report.cards.map(card => card.claim)).toEqual([
      { key: 'K10e 착지', value: '#23507' }, { key: '결정론 env 확인 건수', value: '6건' }, undefined,
    ]);
    expect(report.skipped['no-claim']).toBe(2);
    expect(logs.filter(entry => entry.event === 'skipped').map(entry => entry.data)).toEqual([
      { reason: 'no-claim', source: 'https://example.test/0' },
      { reason: 'no-claim', source: 'https://example.test/1' },
    ]);
    expect(logs.filter(entry => entry.event === 'source-skipped').map(entry => entry.data)).toEqual([
      { reason: 'no-claim', kind: 'event', at: events[0]!.at },
      { reason: 'no-claim', kind: 'event', at: events[1]!.at },
    ]);
  } finally { log.mockRestore(); }
});

test('twenty fake journal rows become project/seat items; newer corrections win, opposite claims flag OP, and >30 days retires', async () => {
  const events = Array.from({ length: 20 }, (_, n) => event(n));
  events[15] = { ...event(15, 'UX'), summary: 'project-beta/topic-15/on' };
  events[16] = { ...event(16), summary: 'project-alpha/topic-0/off', kind: '정정' };
  events[17] = { ...event(17), summary: 'project-alpha/topic-1/off' };
  events[18] = { ...event(18), summary: 'project-alpha/topic-1/on' };
  events[19] = { ...event(19), summary: 'project-alpha/topic-1/off' };
  const previous = [{ project: 'project-alpha', seat: 'TC', topic: 'ancient', summary: 'ancient is on',
    source: 'https://example.test/old', updatedAt: '2026-09-02T23:59:59.000Z', status: 'active' as const }];
  const items = await condenseContextDay(day, previous, { summarize, events: () => events.slice().reverse(), decisions: () => [] }, now);
  expect(events).toHaveLength(20);
  expect(items).toHaveLength(17);
  expect(items.find(i => i.topic === 'topic-0')).toMatchObject({ project: 'project-alpha', seat: 'TC',
    summary: 'topic-0 is off', source: 'https://example.test/16', updatedAt: events[16]!.at, status: 'active' });
  expect(items.find(i => i.topic === 'topic-0')?.conflict).toBeUndefined();
  expect(items.find(i => i.topic === 'topic-1')).toMatchObject({ summary: 'topic-1 is off', source: 'https://example.test/19' });
  expect(items.find(i => i.topic === 'topic-1')?.conflict).toBeUndefined();
  expect(items.find(i => i.topic === 'topic-15')).toMatchObject({ project: 'project-beta', seat: 'UX' });
  expect(items.find(i => i.topic === 'ancient')).toMatchObject({ status: 'retired', updatedAt: previous[0]!.updatedAt });
  expect(items.filter(i => i.status === 'active')).toHaveLength(16);
});

test('decided ledger entries join the same day without touching the ledger, and stale input cannot overwrite a newer snapshot', async () => {
  const decision = { id: 'D-20261002-01', title: 'release route', status: 'decided', decidedAt: `${day}T09:00:00.000Z`,
    scqa: { s: 'release', c: 'route', a: 'suggest canary' }, options: [{ key: 'a', label: 'use canary', consequence: 'staged' }],
    choice: 'a', raisedBy: { agent: 'TC', track: 'TC' },
  } as DecisionEntry;
  const items = await condenseContextDay(day, [{ project: 'project-alpha', seat: 'TC', topic: 'release route',
    summary: 'use production', source: 'elanous://decisions/later', updatedAt: `${day}T10:00:00.000Z`, status: 'active' }], {
    events: () => [event(0, 'MK')], decisions: () => [decision],
    summarize: async source => source.kind === 'decision'
      ? { project: 'project-alpha', topic: 'release route', summary: source.text }
      : { project: 'project-alpha', topic: 'MK update', summary: source.text,
        claim: { key: 'MK update', value: source.text } },
  }, now);
  expect(items).toHaveLength(2);
  expect(items.find(i => i.topic === 'release route')).toMatchObject({ summary: 'use production', source: 'elanous://decisions/later' });
  expect(items.find(i => i.topic === 'MK update')).toMatchObject({ seat: 'MK', source: 'https://example.test/0' });
  const fresh = await condenseContextDay(day, [], { events: () => [], decisions: () => [decision],
    summarize: async source => ({ project: 'project-alpha', topic: 'release route', summary: source.text }) }, now);
  expect(fresh).toMatchObject([{ seat: 'TC', topic: 'release route', summary: 'release route: use canary',
    source: 'elanous://decisions/D-20261002-01', updatedAt: decision.decidedAt }]);
});

test('opposing facts across seats flag an OP decision-card candidate with both source links', async () => {
  const items = await condenseContextDay(day, [], { events: () => [
    { ...event(0, 'TC'), summary: 'alpha/release/on' },
    { ...event(1, 'UX'), summary: 'alpha/release/off' },
  ], decisions: () => [], summarize }, now);
  expect(items).toHaveLength(2);
  expect(items.find(i => i.seat === 'UX')).toMatchObject({
    conflict: { owner: 'OP', sources: ['https://example.test/0', 'https://example.test/1'] },
  });
});

test('same project and claim key across different topics and seats flag an OP candidate', async () => {
  const items = await condenseContextDay(day, [], { events: () => [
    { ...event(0, 'TC'), summary: 'alpha/release-ready/on' },
    { ...event(1, 'UX'), summary: 'alpha/launch-status/off' },
  ], decisions: () => [], summarize: async source => {
    const [project, topic, value] = source.text.split('/');
    return { project: project!, topic: topic!, summary: `${topic} is ${value}`,
      claim: { key: 'release-ready', value: value! } };
  } }, now);
  expect(items.find(i => i.topic === 'launch-status')?.conflict).toEqual({
    owner: 'OP', sources: ['https://example.test/0', 'https://example.test/1'],
  });
});

test('opposing claims within the same project and seat but different topics flag OP; another project does not', async () => {
  const items = await condenseContextDay(day, [], { events: () => [
    { ...event(0), summary: 'alpha/deployment/on' },
    { ...event(1), summary: 'alpha/rollout/off' },
    { ...event(2), summary: 'beta/readiness/off' },
  ], decisions: () => [], summarize: async source => {
    const [project, topic, value] = source.text.split('/');
    return { project: project!, topic: topic!, summary: `${topic} is ${value}`,
      claim: { key: 'deployment-state', value: value! } };
  } }, now);
  expect(items.find(i => i.topic === 'rollout')?.conflict).toEqual({
    owner: 'OP', sources: ['https://example.test/0', 'https://example.test/1'],
  });
  expect(items.find(i => i.topic === 'readiness')?.conflict).toBeUndefined();
});

test('a later TC correction resolves the conflict left on UX by an earlier opposing claim', async () => {
  const items = await condenseContextDay(day, [], { events: () => [
    { ...event(0, 'TC'), summary: 'alpha/release/on' },
    { ...event(1, 'UX'), summary: 'alpha/release/off' },
    { ...event(2, 'TC', '정정'), summary: 'alpha/release/off' },
  ], decisions: () => [], summarize }, now);
  expect(items).toHaveLength(2);
  expect(items.find(i => i.seat === 'TC')).toMatchObject({ summary: 'release is off', source: 'https://example.test/2' });
  expect(items.find(i => i.seat === 'TC')?.conflict).toBeUndefined();
  expect(items.find(i => i.seat === 'UX')?.conflict).toBeUndefined();
});

test('opposite claims sharing one URL still produce an OP decision-card candidate', async () => {
  const url = 'https://example.test/shared';
  const items = await condenseContextDay(day, [], { events: () => [
    { ...event(0, 'TC'), summary: 'alpha/release/on', refs: { ...event(0).refs, url } },
    { ...event(1, 'UX'), summary: 'alpha/release/off', refs: { ...event(1, 'UX').refs, url } },
  ], decisions: () => [], summarize }, now);
  expect(items.map(i => i.seat)).toEqual(['TC', 'UX']);
  expect(items.find(i => i.seat === 'UX')?.conflict).toEqual({ owner: 'OP', sources: [url, url] });
});

test('UTC day membership and newest winner use parsed instants across timezone offsets', async () => {
  let requestedSince = '';
  const items = await condenseContextDay(day, [], { events: since => {
    requestedSince = since;
    return [
      { ...event(0), at: '2026-10-03T01:00:00+02:00', summary: 'alpha/release/on' },
      { ...event(1), at: '2026-10-01T23:30:00-02:00', summary: 'alpha/release/off' },
      { ...event(2), at: '2026-10-02T00:30:00Z', summary: 'alpha/release/on' },
      { ...event(3), at: '2026-10-02T23:30:00-02:00', summary: 'alpha/excluded/on' },
      { ...event(4), at: '2026-10-02T00:30:00+02:00', summary: 'alpha/excluded/off' },
    ];
  }, decisions: () => [], summarize }, now);
  expect(requestedSince).toBe('2026-10-01T00:00:00.000Z');
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ topic: 'release', summary: 'release is on',
    source: 'https://example.test/0', updatedAt: '2026-10-03T01:00:00+02:00' });
});

test('day window excludes adjacent days and summaries never include a second line', async () => {
  let called = 0;
  const items = await condenseContextDay(day, [], { events: () => [
    { ...event(1), at: '2026-10-01T23:59:59.000Z' }, event(2),
    { ...event(3), at: '2026-10-03T00:00:00.000Z' },
  ], decisions: () => [], summarize: async source => {
    called++;
    return { project: 'alpha', topic: 'topic', summary: `${source.text}\nprivate text`,
      claim: { key: 'topic', value: 'on' } };
  } }, now);
  expect(called).toBe(1);
  expect(items).toHaveLength(1);
  expect(JSON.stringify(items)).not.toContain('private text');
});

test('harness-child lifecycle events of other kinds are dropped, while a harness-child report stays its own source', async () => {
  const run = 'elanous://harness/run-C/pty-C';
  const at = (n: number) => `${day}T01:${String(n).padStart(2, '0')}:00.000Z`;
  const child = (n: number, kind: string, summary: string): CoordEvent => ({
    ...event(n, 'harness-child', kind), at: at(n), summary,
    refs: { ...event(n).refs, seat: 'harness-child', source: run, url: null },
  });
  const events = [child(1, 'started', 'Harness child started'), child(2, 'unknown', 'Harness child heartbeat'),
    child(3, 'finished', 'Harness child finished: success'), child(4, '보고', 'child report')];
  const calls: MemorySource[] = [];
  const report = await condenseContextWindowWithReport(`${day}T00:00:00.000Z`, '2026-10-03T00:00:00.000Z', [], {
    events: () => events, decisions: () => [],
    summarize: async source => { calls.push(source); return { project: 'alpha', topic: source.text, summary: source.text,
      claim: { key: source.text, value: source.text } }; },
  }, now);
  expect(calls).toEqual([{ kind: 'event', at: events[3]!.at, seat: 'harness-child',
    text: 'child report', source: run }]);
  expect(report.cards).toMatchObject([{ summary: 'child report' }]);
  expect(report.folded).toBe(0);
  expect(report.droppedHarnessChild).toBe(3);
});

test('real harness-child endings are dropped before sources while reports and an outer run remain', async () => {
  const outerRun = 'elanous://harness/outer-run';
  const endings = [
    'Harness child loop exhausted without completion (0m 0s).',
    'Harness child reported a soft timeout at 2026-10-03T22:42:34.596Z (0m 0s).',
    'Child run self_752ca9fd exited successfully in 0m 0s.',
  ];
  const childEvents = endings.map((summary, n) => ({
    ...event(n + 1, 'harness-child', 'finished'), summary,
    refs: { ...event(n + 1).refs, seat: 'harness-child', source: `elanous://harness/child-${n}`, url: null },
  }));
  const childReport = { ...event(4, 'harness-child'), summary: 'Child report: shipped change',
    refs: { ...event(4).refs, seat: 'harness-child', source: 'elanous://harness/child-report', url: null } };
  const started = { ...event(5, 'TC', 'started'), summary: 'Outer run started',
    refs: { ...event(5).refs, seat: 'TC', source: outerRun, url: null } };
  const finished = { ...event(8, 'TC', 'finished'), summary: 'Outer run finished: landed',
    refs: { ...event(8).refs, seat: 'TC', source: outerRun, url: null } };
  const channelReport = { ...event(7, 'MK'), summary: 'Channel report: landed',
    refs: { ...event(7).refs, seat: 'MK', source: 'https://example.test/channel-report' } };
  const calls: MemorySource[] = [];
  const logs: Array<{ event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, name, data) => {
    if (category === 'context.condense') logs.push({ event: name, data });
  });
  try {
    const report = await condenseContextWindowWithReport(`${day}T00:00:00.000Z`,
      '2026-10-03T00:00:00.000Z', [], {
        events: () => [...childEvents, childReport, finished, channelReport, started], decisions: () => [],
        summarize: async source => {
          calls.push(source);
          return { project: 'alpha', topic: source.source, summary: source.text,
            claim: { key: source.source, value: source.text } };
        },
      }, now);
    expect(calls).toEqual([
      { kind: 'event', at: childReport.at, seat: 'harness-child', text: childReport.summary,
        source: childReport.refs.source },
      { kind: 'event', at: channelReport.at, seat: 'MK', text: channelReport.summary,
        source: channelReport.refs.source },
      { kind: 'event', at: finished.at, seat: 'TC', source: outerRun,
        text: `${outerRun} Outer run finished: landed · 3m 0s` },
    ]);
    expect(report.cards.map(card => card.source).sort()).toEqual([
      childReport.refs.source, channelReport.refs.source, outerRun,
    ].sort());
    expect(report.cards.map(card => card.summary)).not.toContain(endings[0]);
    expect(report.cards.map(card => card.summary)).not.toContain(endings[1]);
    expect(report.cards.map(card => card.summary)).not.toContain(endings[2]);
    expect(report).toMatchObject({ droppedHarnessChild: 3, folded: 1, skipped: {} });
    expect(logs.find(entry => entry.event === 'folded')).toEqual({ event: 'folded',
      data: { harnessEvents: 2, kept: 1, droppedHarnessChild: 3 } });
  } finally { log.mockRestore(); }
});
