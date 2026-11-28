import { describe, expect, test } from 'bun:test';
import { planNextActions, type NextActionState } from './op-next-action.js';
import { executeThroughput, type ThroughputVerdict, type ThroughputActuators } from './throughput-controller.js';

const state = (splitPieces: number | null): NextActionState => ({
  now: '2026-11-28T12:00:00.000Z', version: '1.0.0', splitPieces,
  cells: [{ id: 'C', title: 'large', status: 'yellow', owner: 'TC-H-BUSY' }],
  hands: [{ seat: 'TC-H-BUSY', home: 'TC', state: 'working' }, ...Array.from({ length: 10 }, (_, i) => ({ seat: `TC-H-${i}`, home: 'TC', state: 'idle' as const }))],
  directives: [], handRaises: [], land: null, releases: [], bulletin: null,
});

describe('live steward caps at planner boundary', () => {
  test('split proposal scales above legacy four and never exceeds measured cap', () => {
    const action = planNextActions(state(7)).actions.find(a => a.key === 'c:C');
    expect(action?.commands.filter(c => c.startsWith('eln release checklist add '))).toHaveLength(7);
    expect(planNextActions(state(2)).actions.find(a => a.key === 'c:C')?.commands.filter(c => c.startsWith('eln release checklist add '))).toHaveLength(2);
  });
  test('unknown and zero capacity never propose splitting', () => {
    for (const cap of [null, 0]) expect(planNextActions(state(cap)).actions.some(a => a.key === 'c:C' || a.do === 'split-request')).toBe(false);
    expect(planNextActions(state(null)).unmeasured).toContain('steward splitPieces');
  });
});

describe('throughput recipient card budget', () => {
  const action = (key: string, to: string[]) => ({ key, to, do: 'tsc-rerun' as const, body: key });
  const verdict = (throughputCards: number | null): ThroughputVerdict => ({
    at: '2026-11-28T12:00:00Z', throughputCards,
    measured: { lands: null, greens: null, targets: { landsPerH: 10, greensPerH: 10 }, ceilingLandsPerH: null, pipeline: null },
    chain: 'land', active: [], binding: { kind: 'on-target', signal: '' }, hotFiles: [], unmeasured: [],
    safety: [action('safety', ['A', 'RES'])],
    lever: { id: 'test', actor: 'machine', owner: 'OP', what: '', commands: [], doneWhen: '', actions: [action('lever', ['B'])] },
  });
  test('safety first, combined actions cannot exceed cap in individual recipient cards', async () => {
    const cards: string[] = [];
    const act = { sentKeys: () => new Set<string>(), record: () => {}, card: (to: string) => { cards.push(to); return '1'; } } as ThroughputActuators;
    await executeThroughput(verdict(2), act, 'live');
    expect(cards).toEqual(['A', 'RES']);
    cards.length = 0;
    await executeThroughput(verdict(3), act, 'live');
    expect(cards).toEqual(['A', 'RES', 'B']);
    cards.length = 0;
    await executeThroughput(verdict(null), act, 'live');
    expect(cards).toEqual([]);
  });
});
