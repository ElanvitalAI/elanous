import { describe, expect, test } from 'bun:test';
import { isLoopTabTitle, loopHomeSeat, loopsBySeat, loopsListCount, loopsListLines, loopsListTitle, loopTabLines, loopTone, planLoopTabs, type LoopAgent } from './loop-agents.js';

// Org as of 11-26: REL's and RES's supervision duties moved to OP; landing moved JUD → TC (JUD keeps veto).
const DUTIES = { 'release-supervision': 'OP', 'resource-supervision': 'OP', landing: 'TC', veto: 'JUD', board: 'OP' };
const agent = (id: string, owner: string, extra: Partial<LoopAgent> = {}): LoopAgent => ({ id, owner, stage: 'live', lastStatus: 'done', lastAt: '2026-11-26T07:40:00.000Z', ...extra });
const NOW = Date.parse('2026-11-26T07:43:00.000Z');

describe('loop agent owner mapping', () => {
  test('REL and RES triggers sit under OP once their supervision duty moved; TC and JUD stay', () => {
    expect(loopHomeSeat('REL', DUTIES)).toBe('OP');
    expect(loopHomeSeat('res', DUTIES)).toBe('OP');
    expect(loopHomeSeat('TC', DUTIES)).toBe('TC');
    expect(loopHomeSeat('JUD', DUTIES)).toBe('JUD');
    expect(loopHomeSeat('OP', DUTIES)).toBe('OP');
  });
  test('REL keeps its own triggers while it still holds release-supervision', () => {
    expect(loopHomeSeat('REL', { 'release-supervision': 'REL' })).toBe('REL');
  });
  test('grouping: release-traffic (REL) and res-burst-lease (RES) under OP, space-advisor-tc under TC, retired hidden', () => {
    const grouped = loopsBySeat([agent('release-traffic', 'REL'), agent('res-burst-lease', 'RES'), agent('board-steward', 'OP'), agent('space-advisor-tc', 'TC'), agent('old', 'OP', { stage: 'retired' })], DUTIES);
    expect([...grouped.keys()]).toEqual(['OP', 'TC']);
    expect(grouped.get('OP')!.map((one) => one.id)).toEqual(['release-traffic', 'res-burst-lease', 'board-steward']);
    expect(grouped.get('TC')!.map((one) => one.id)).toEqual(['space-advisor-tc']);
  });
});

describe('loop tab view', () => {
  test('tone: done/running green, exception red, never fired grey', () => {
    expect(loopTone({ stage: 'live', lastStatus: 'done' })).toBe('ok');
    expect(loopTone({ stage: 'live', lastStatus: 'running' })).toBe('ok');
    expect(loopTone({ stage: 'live', lastStatus: 'exception' })).toBe('error');
    expect(loopTone({ stage: 'live', lastStatus: null })).toBe('idle');
  });
  test('header and a fire with run id, literal', () => {
    const lines = loopTabLines(agent('release-rocket', 'OP', { cron: '*/2 * * * *', timeZone: 'Asia/Seoul' }), [
      { graphId: 'release-rocket', window: '2026-11-26T07:42:00.000Z', stage: 'live', status: 'done', attempt: 1, runId: 'r-42', dispatchedAt: '2026-11-26T07:42:05.000Z', checkAt: null, nextRetryAt: null, error: null, card: null },
    ], NOW, 80, false);
    expect(lines[0]).toBe('● ↻ release-rocket · live · owner OP');
    expect(lines[1]).toBe('  trigger */2 * * * * · next 16:44 · last done 3m');
    expect(lines[2]).toBe('  read-only · typing is ignored');
    expect(lines[4]).toBe('● 16:42 done · run r-42');
  });
  test('error state: red ✕ header, the error and the card it raised under the fire', () => {
    const lines = loopTabLines(agent('res-ready-pool', 'RES', { lastStatus: 'exception', timeZone: 'UTC' }), [
      { graphId: 'res-ready-pool', window: '2026-11-26T07:10:00.000Z', stage: 'live', status: 'exception', attempt: 3, runId: null, dispatchedAt: null, checkAt: null, nextRetryAt: null, error: 'goal not met', card: 'msg#991' },
    ], NOW, 80, true);
    expect(lines[0]).toBe('\u001b[31m✕ ↻ res-ready-pool · live · owner RES\u001b[0m');
    expect(lines[1]).toBe('  trigger condition · on cond · last exception 3m');
    expect(lines.slice(4).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''))).toEqual(['✕ 07:10 exception · attempt 3', '    ✕ goal not met', '    ✉ card msg#991']);
  });
  test('width: every line fits a narrow pane, CJK id included', () => {
    for (const width of [12, 20, 28]) {
      const lines = loopTabLines(agent('릴리스-로켓-release-rocket', 'OP', { error: null }), [
        { graphId: 'x', window: '2026-11-26T07:42:00.000Z', stage: 'live', status: 'done', attempt: 1, runId: 'run-with-a-long-id-1234567890', dispatchedAt: null, checkAt: null, nextRetryAt: null, error: '실패 이유가 아주 길게 적혀 있다', card: null },
      ], NOW, width, false);
      for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});

describe('loop-tabs reconciler plan: ONE «↻ loops (N)» tab per space (CEO 11-26 11:1x)', () => {
  test('first run over today\'s per-loop tabs: closes every «↻ <id>» tab, opens one list tab per space with its count', () => {
    const bySeat = loopsBySeat([agent('release-rocket', 'REL'), agent('op-pulse', 'OP'), agent('res-ready-pool', 'RES'), agent('space-advisor-tc', 'TC')], DUTIES);
    const plan = planLoopTabs(bySeat, [
      { tab: 't1', title: '↻ op-pulse', workspace: 'OP' },
      { tab: 't2', title: '↻ release-rocket', workspace: 'OP' },
      { tab: 't3', title: '↻ gone', workspace: 'OP' },
      { tab: 't4', title: 'OP', workspace: 'OP' },
      { tab: 't5', title: '↻ space-advisor-tc [build unknown]', workspace: 'TC' },
      { tab: 't6', title: 'federation board', workspace: 'OP' },
    ]);
    expect(plan.open).toEqual([{ ws: 'OP', count: 3 }, { ws: 'TC', count: 1 }]);
    expect(plan.close).toEqual([{ tab: 't1', id: 'op-pulse' }, { tab: 't2', id: 'release-rocket' }, { tab: 't3', id: 'gone' }, { tab: 't5', id: 'space-advisor-tc' }]);
  });
  test('in sync: a matching list tab per space is kept (workspace case and build badge ignored) — nothing to do', () => {
    const bySeat = loopsBySeat([agent('op-pulse', 'OP'), agent('op-retro', 'OP'), agent('space-advisor-tc', 'TC')], DUTIES);
    expect(planLoopTabs(bySeat, [
      { tab: 'a', title: '↻ loops (2)', workspace: 'op' },
      { tab: 'b', title: '↻ loops (1) [build unknown]', workspace: 'TC' },
    ])).toEqual({ open: [], close: [] });
  });
  test('stale count, duplicate list tab, and a space with no loops left: closed; the right one opened', () => {
    const bySeat = loopsBySeat([agent('op-pulse', 'OP'), agent('op-retro', 'OP'), agent('op-bulletin', 'OP')], DUTIES);
    const plan = planLoopTabs(bySeat, [
      { tab: 'a', title: '↻ loops (2)', workspace: 'OP' },
      { tab: 'b', title: '↻ loops (1)', workspace: 'TC' },
    ]);
    expect(plan.open).toEqual([{ ws: 'OP', count: 3 }]);
    expect(plan.close).toEqual([{ tab: 'a', id: 'loops' }, { tab: 'b', id: 'loops' }]);
    const dup = planLoopTabs(bySeat, [{ tab: 'x', title: '↻ loops (3)', workspace: 'OP' }, { tab: 'y', title: '↻ loops (3)', workspace: 'OP' }]);
    expect(dup).toEqual({ open: [], close: [{ tab: 'y', id: 'loops' }] });
  });
  test('retired triggers do not count; no triggers at all = no list tab', () => {
    expect(planLoopTabs(loopsBySeat([agent('old', 'OP', { stage: 'retired' })], DUTIES), [])).toEqual({ open: [], close: [] });
  });
  test('titles: the list tab is not a per-loop tab', () => {
    expect(loopsListTitle(10)).toBe('↻ loops (10)');
    expect(loopsListCount('↻ loops (10)')).toBe(10);
    expect(loopsListCount('↻ loops (10) [build abc]')).toBe(10);
    expect(loopsListCount('↻ op-pulse')).toBeUndefined();
    expect(isLoopTabTitle('↻ loops (10)')).toBeUndefined();
    expect(isLoopTabTitle('↻ op-pulse [build abc]')).toBe('op-pulse');
  });
});

describe('list tab screen «↻ loops (N)»', () => {
  const strip = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, '');
  const entries = [
    { agent: agent('op-pulse', 'OP', { cron: '*/10 * * * *', timeZone: 'UTC' }), fireAtMs: [NOW - 3 * 60_000, NOW - 13 * 60_000] },
    { agent: agent('res-ready-pool', 'RES', { lastStatus: 'exception', lastAt: '2026-11-26T07:10:00.000Z' }), fireAtMs: [] },
    { agent: agent('op-retro', 'OP', { lastStatus: null, lastAt: null, cron: '0 * * * *', timeZone: 'UTC' }), fireAtMs: [] },
  ];
  test('literal: header names the exception count, one line per loop with heartbeat · last fire · next, cursor on row 2', () => {
    const lines = loopsListLines('op', entries, 1, NOW, 100, false);
    expect(lines).toEqual([
      '● ↻ loops (3) · OP · 1 in exception',
      '  read-only · ↑↓ select · Enter watch · Ctrl-C in a watch = back to this list',
      '─'.repeat(100),
      '  ● op-pulse       ▁▁▁▁▇▇  3m · done · next 07:50',
      '› ● res-ready-pool ▁▁▁▁▁▁ 33m · exception · on cond',
      '  ● op-retro       ▁▁▁▁▁▁   — · never fired · next 08:00',
    ]);
  });
  test('red dot: header and the exception row\'s dot are red; a healthy row\'s dot is green, a never-fired one dim', () => {
    const lines = loopsListLines('OP', entries, 0, NOW, 100, true);
    expect(lines[0]!.startsWith('\u001b[31m● ↻ loops (3)')).toBe(true);
    expect(lines[3]).toContain('\u001b[32m●\u001b[0m op-pulse');
    expect(lines[4]).toContain('\u001b[31m●\u001b[0m res-ready-pool');
    expect(lines[5]).toContain('\u001b[2m●\u001b[0m op-retro');
    expect(lines.map(strip)).toEqual(loopsListLines('OP', entries, 0, NOW, 100, false));
  });
  test('no exception: header is not red; empty space says so; every line fits a narrow pane', () => {
    const calm = loopsListLines('TC', [entries[0]!], 0, NOW, 80, true);
    expect(calm[0]).toBe('\u001b[32m● ↻ loops (1) · TC\u001b[0m');
    expect(loopsListLines('MK', [], 0, NOW, 80, false).slice(3)).toEqual(['  (no loops in this space)']);
    for (const width of [12, 24, 40]) for (const line of loopsListLines('OP', entries, 2, NOW, width, false)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
  });
});

import { fireBuckets, heartbeatRow, loopShortName, loopsFoldedByDefault, loopsSubHead, sparkline } from './loop-agents.js';
import { layoutSpaceList, type SpaceTabRow } from './space-tabs-view.js';

describe('side list heartbeat rows', () => {
  test('short names', () => {
    expect(['op-pulse', 'op-bulletin', 'board-steward', 'op-retro', 'op-idle-triage', 'release-rocket', 'release-traffic', 'res-burst-lease', 'res-ready-pool', 'res-reservation', 'space-advisor-tc'].map(loopShortName))
      .toEqual(['pulse', 'bulletin', 'board', 'retro', 'idle-triage', 'release-rocket', 'release-traffic', 'res-lease', 'res-pool', 'res-reservation', 'advisor']);
  });
  test('sparkline buckets the last hour into six 10-minute cells, oldest first', () => {
    const at = (minAgo: number) => NOW - minAgo * 60_000;
    expect(fireBuckets([at(1), at(2), at(15), at(55), at(70)], NOW)).toEqual([1, 0, 0, 0, 1, 2]);
    expect(sparkline([1, 0, 0, 0, 1, 2])).toBe('▄▁▁▁▄▇');
    expect(sparkline([0, 0, 0, 0, 0, 0])).toBe('▁▁▁▁▁▁');
  });
  test('row literal (SIDETAB-POLISH-1126): name + last-fire age only, no bars; exception = red dot — exactly the sidebar width (28)', () => {
    const calm = heartbeatRow('op-pulse', { buckets: [1, 0, 0, 0, 1, 2], lastAt: '2026-11-26T07:40:00.000Z', tone: 'ok', firing: false }, NOW, 28, false);
    expect(calm).toBe('  ↻ pulse' + ' '.repeat(15) + '  3m');
    expect(heartbeatRow('op-pulse', { buckets: [0, 0, 0, 0, 0, 1], lastAt: null, tone: 'ok', firing: true }, NOW, 28, false)).toBe('  ↻ pulse' + ' '.repeat(15) + ' now');
    expect(heartbeatRow('res-ready-pool', { buckets: [0, 0, 0, 0, 0, 0], lastAt: null, tone: 'error', firing: false }, NOW, 28, false)).toBe('  ● res-pool' + ' '.repeat(12) + '   —');
    expect(heartbeatRow('res-ready-pool', { buckets: [0, 0, 0, 0, 0, 0], lastAt: '2026-11-26T07:40:00.000Z', tone: 'error', firing: false }, NOW, 28, true)).toBe('  \u001b[31m●\u001b[39m res-pool' + ' '.repeat(12) + '  3m');
    for (const facts of [undefined, { buckets: [3, 1, 4, 1, 5, 9], lastAt: null, tone: 'ok' as const, firing: true }]) {
      const row = heartbeatRow('op-pulse', facts, NOW, 28, true);
      expect(/[▁▂▃▄▅▆▇]/.test(row)).toBe(false);
      expect(row).not.toContain('\u001b[5m');
    }
    for (const w of [12, 20, 28]) expect(Bun.stringWidth(heartbeatRow('릴리스-로켓-release-rocket', undefined, NOW, w, false))).toBe(w);
  });
  test('fold: more than three loops start folded, the sub-header carries the error count', () => {
    expect(loopsFoldedByDefault(10)).toBe(true);
    expect(loopsFoldedByDefault(3)).toBe(false);
    expect(loopsSubHead(10, true, 1)).toBe(' › ↻ loops 10 ✖1');
    expect(loopsSubHead(1, false)).toBe(' ⌄ ↻ loops 1');
  });
});

describe('side list: loop tabs under their space', () => {
  const pane = (id: string, ws: string, title: string, extra: Partial<SpaceTabRow> = {}): SpaceTabRow => ({ pane: id, wsId: ws, workspace: ws, tabId: id, title, state: 'idle', cwd: '/x', ...extra } as SpaceTabRow);
  const strip = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
  test('TC (one loop) open: seat row, then «⌄ ↻ loops 1», then the heartbeat row; header shows ↻1', () => {
    const rows = [pane('p1', 'TC', 'TC', { seat: 'TC' }), pane('p2', 'TC', '↻ space-advisor-tc')];
    const facts = new Map([['space-advisor-tc', { buckets: [0, 0, 0, 0, 0, 1], lastAt: null, tone: 'ok' as const, firing: true }]]);
    const lines = layoutSpaceList(rows, 'p1', 28, 20, undefined, 0, [], undefined, 'grouped', undefined, undefined, new Map(), false, undefined, facts).lines.map(strip);
    const head = lines.findIndex((line) => line.includes('⌄ TC'));
    expect(lines[head]).toContain('↻1');
    expect(lines.slice(head).find((line) => line.includes('loops'))).toBe(' ⌄ ↻ loops 1');
    expect(lines).toContain('  ↻ advisor' + ' '.repeat(13) + ' now');
    expect(lines.some((line) => line.includes('↻ space-advisor-tc'))).toBe(false);
  });
  test('OP with ten loops (REL/RES absorbed): folded by default, header «↻10 ✖1», no heartbeat rows until opened', () => {
    const ids = ['op-pulse', 'op-bulletin', 'board-steward', 'op-retro', 'op-idle-triage', 'release-rocket', 'release-traffic', 'res-burst-lease', 'res-ready-pool', 'res-reservation'];
    const rows = [pane('s', 'OP', 'OP', { seat: 'OP' }), ...ids.map((id, at) => pane(`l${at}`, 'OP', `↻ ${id}`))];
    const facts = new Map(ids.map((id) => [id, { buckets: [0, 0, 0, 0, 0, 0], lastAt: null, tone: id === 'res-ready-pool' ? 'error' as const : 'ok' as const, firing: false }]));
    const folded = layoutSpaceList(rows, 's', 28, 30, undefined, 0, [], undefined, 'grouped', undefined, undefined, new Map(), false, undefined, facts).lines.map(strip);
    expect(folded.find((line) => line.includes('⌄ OP'))).toContain('↻10 ✖1');
    expect(folded).toContain(' › ↻ loops 10 ✖1');
    expect(folded.some((line) => line.includes('res-pool'))).toBe(false);
    const open = layoutSpaceList(rows, 's', 28, 30, undefined, 0, [], undefined, 'grouped', undefined, undefined, new Map([['loops:OP', false]]), false, undefined, facts).lines.map(strip);
    expect(open).toContain(' ⌄ ↻ loops 10 ✖1');
    expect(open).toContain('  ● res-pool' + ' '.repeat(12) + '   —');
    for (const line of open) expect(Bun.stringWidth(strip(line))).toBeLessThanOrEqual(28);
  });
});

import { nodeOutputSummary, runNodesOf, withLoopStates } from './loop-agents.js';

describe('loop tab: graph node steps in the timeline', () => {
  const RUN = JSON.stringify({ status: 'running', path: ['measure', 'turn'], nodes: [
    { nodeId: 'measure', ok: true, exit: 0, seconds: 4.56, output: '{"gaps":2,"outcome":"turn","table":"/x/PULSE.md"}' },
  ] });
  test('run state → node steps; the node it is on now is running', () => {
    expect(runNodesOf(RUN)).toEqual([{ nodeId: 'measure', ok: true, exit: 0, seconds: 4.56, output: '{"gaps":2,"outcome":"turn","table":"/x/PULSE.md"}' }, { nodeId: 'turn', running: true }]);
    expect(runNodesOf('not json')).toEqual([]);
  });
  test('output summary: outcome first, scalar fields only', () => {
    expect(nodeOutputSummary('{"gaps":2,"outcome":"turn","nested":{"a":1}}')).toBe('outcome=turn · gaps=2');
    expect(nodeOutputSummary('posted msg#5\nmore')).toBe('posted msg#5');
  });
  test('timeline literal: fire, its steps (done ✓, running …, failed ✕ exit), then the error', () => {
    const fires = [{ graphId: 'op-pulse', window: '2026-11-26T07:42:00.000Z', stage: 'live' as const, status: 'running' as const, attempt: 1, runId: 'r1', dispatchedAt: '2026-11-26T07:42:00.000Z', checkAt: null, nextRetryAt: null, error: null, card: null },
      { graphId: 'op-pulse', window: '2026-11-26T07:30:00.000Z', stage: 'live' as const, status: 'exception' as const, attempt: 1, runId: 'r0', dispatchedAt: '2026-11-26T07:30:00.000Z', checkAt: null, nextRetryAt: null, error: 'goal not met', card: null }];
    const runs = new Map([['r1', runNodesOf(RUN)], ['r0', [{ nodeId: 'measure', ok: false, exit: 2, seconds: 1 }]]]);
    const lines = loopTabLines(agent('op-pulse', 'OP', { lastStatus: 'running', timeZone: 'UTC' }), fires, NOW, 80, false, runs);
    expect(lines.slice(4)).toEqual([
      '● 07:42 running · run r1',
      '    ├ ✓ measure 4.6s · outcome=turn · gaps=2 · table=/x/PULSE.md',
      '    └ … turn running',
      '✕ 07:30 exception · run r0',
      '    ├ ✕ measure exit 2 1.0s',
      '    ✕ goal not met',
    ]);
  });
});

describe('loop tab state = its trigger (red dot in side list, tab row, tile)', () => {
  test('exception → failed, firing → working, else idle; other panes and exited loop tabs untouched', () => {
    const facts = new Map([
      ['res-ready-pool', { buckets: [], lastAt: null, tone: 'error' as const, firing: false }],
      ['op-pulse', { buckets: [], lastAt: null, tone: 'ok' as const, firing: true }],
      ['op-retro', { buckets: [], lastAt: null, tone: 'ok' as const, firing: false }],
    ]);
    const rows = [{ title: '↻ res-ready-pool [build unknown]', state: 'working' }, { title: '↻ op-pulse', state: 'idle' }, { title: '↻ op-retro', state: 'working' }, { title: 'OP', state: 'working' }, { title: '↻ op-pulse', state: 'exited' }];
    expect(withLoopStates(rows, facts).map((row) => row.state)).toEqual(['failed', 'working', 'idle', 'working', 'exited']);
    expect(withLoopStates(rows, undefined)).toEqual(rows);
  });
});

describe('list tab state = its space\'s loops', () => {
  test('any loop of the space in exception → the «↻ loops (N)» tab is failed (red); firing → working; other spaces untouched', () => {
    const facts = new Map([
      ['res-ready-pool', { buckets: [], lastAt: null, tone: 'error' as const, firing: false, seat: 'OP' }],
      ['op-pulse', { buckets: [], lastAt: null, tone: 'ok' as const, firing: true, seat: 'OP' }],
      ['space-advisor-tc', { buckets: [], lastAt: null, tone: 'ok' as const, firing: true, seat: 'TC' }],
      ['land-graph', { buckets: [], lastAt: null, tone: 'ok' as const, firing: false, seat: 'JUD' }],
    ]);
    const rows = [
      { title: '↻ loops (2)', state: 'idle', workspace: 'OP' },
      { title: '↻ loops (1) [build x]', state: 'idle', workspace: 'TC' },
      { title: '↻ loops (1)', state: 'working', workspace: 'JUD' },
      { title: '↻ loops (4)', state: 'idle', workspace: 'MK' },
      { title: '↻ loops (2)', state: 'exited', workspace: 'OP' },
    ];
    expect(withLoopStates(rows, facts).map((row) => row.state)).toEqual(['failed', 'working', 'idle', 'idle', 'exited']);
  });
});
