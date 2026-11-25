import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { detectPhase, loadRhythm, parseRhythm, pulseDue, pulseGaps, renderPulseBrief, rhythmRow, type PulseMeasure } from './op-pulse.js';
import { parseUrgency, urgencyOf, urgentCeoLines } from './op-pulse-urgency.js';

const RHYTHM = join(import.meta.dir, '../../graphs/triggers/op-pulse.rhythm.yaml');
const MIN_YAML = `
detection: { pre_cut_hours: 4, release_after_publish_min: 30, post_release_hours: 2, night: { from: 1, to: 6 },
  freezes: [{ from: '2026-11-26T05:00:00Z', to: '2026-11-26T11:00:00Z', label: demo }] }
phases:
  - { phase: build, cadence_min: 60, targets: { landed_per_h: 20 }, levers: [reprioritize], beat: b, source: 'A.md#x' }
  - { phase: release-window, cadence_min: 15, targets: { landed_per_h: null }, levers: [status-only], new_work: false, beat: r, source: 'A.md#y' }
`;
const rhythm = parseRhythm(MIN_YAML);
const SCHED = [{ version: '0.3.37', cutAt: '2026-11-26T19:00:00Z', publishAt: '2026-11-26T21:00:00Z' }];
const at = (iso: string, hour = 12) => ({ now: new Date(iso), schedules: SCHED, burstActive: false, localHour: hour });

describe('rhythm table', () => {
  test('the shipped rhythm yaml parses and every phase row cites a seed-doc section', () => {
    const r = loadRhythm(RHYTHM);
    expect([...r.rows.keys()].sort()).toEqual(['build', 'burst', 'demo-freeze', 'night', 'post-release', 'pre-cut', 'release-window']);
    for (const row of r.rows.values()) expect(row.source.startsWith('docs/conductor/')).toBe(true);
    expect(r.rows.get('build')!.targets.landedPerH).toBe(20);
    expect(r.rows.get('release-window')!.newWork).toBe(false);
  });
  test('a bad edit is refused loud', () => {
    expect(() => parseRhythm('phases: [{ phase: build, cadence_min: 60, levers: [nuke], beat: b, source: "A.md#x" }]')).toThrow('nuke is not a known lever');
    expect(() => parseRhythm('phases: [{ phase: build, cadence_min: 60, beat: b, source: nodoc }]')).toThrow('must cite a seed-doc section');
    expect(() => parseRhythm('phases: [{ phase: night, cadence_min: 60, beat: b, source: "A.md#x" }]')).toThrow('build phase row is required');
  });
});

describe('phase detection', () => {
  test('precedence and windows', () => {
    expect(detectPhase(at('2026-11-26T12:00:00Z'), rhythm.detection).phase).toBe('build');
    expect(detectPhase(at('2026-11-26T15:30:00Z'), rhythm.detection).phase).toBe('pre-cut');
    expect(detectPhase(at('2026-11-26T19:10:00Z'), rhythm.detection).phase).toBe('release-window');
    expect(detectPhase(at('2026-11-26T21:20:00Z'), rhythm.detection).phase).toBe('release-window');
    expect(detectPhase(at('2026-11-26T21:40:00Z'), rhythm.detection).phase).toBe('post-release');
    expect(detectPhase(at('2026-11-26T06:00:00Z'), rhythm.detection).phase).toBe('demo-freeze');
    expect(detectPhase(at('2026-11-25T18:00:00Z', 3), rhythm.detection).phase).toBe('night');
    expect(detectPhase({ ...at('2026-11-26T19:10:00Z'), burstActive: true }, rhythm.detection).phase).toBe('burst');
  });
  test('a phase missing from the table falls back to build', () => {
    expect(rhythmRow(rhythm, 'night').phase).toBe('build');
  });
});

const measure = (over: Partial<PulseMeasure> = {}): PulseMeasure => ({ at: '2026-11-26T12:00:00Z', version: '0.3.37', landedPerH: 22, greenPerH: 12, judgeQueue: 3,
  judgeWaitMedianMin: 12, budget: [], unmeasured: [], spaces: [{ space: 'TC', landedPerH: 10, greenPerH: 5, hands: 4, idleWithWork: 1, readyCells: 9, blockedCells: 0 }], ...over });

describe('gaps', () => {
  const targets = loadRhythm(RHYTHM).rows.get('build')!.targets;
  test('all green → no gap', () => { expect(pulseGaps(measure(), targets)).toEqual([]); });
  test('each missed target is one gap row', () => {
    const gaps = pulseGaps(measure({ landedPerH: 7, judgeWaitMedianMin: 45, spaces: [{ space: 'UX', landedPerH: 1, greenPerH: 0, hands: 3, idleWithWork: 4, readyCells: 2, blockedCells: 1 }] }), targets);
    expect(gaps.map(g => `${g.space}:${g.metric}:${g.value}`)).toEqual(['FED:landed/h:7', 'JUD:judge-wait:45', 'UX:idle-with-work:4', 'UX:ready-cells:2']);
  });
  test('unmeasured is never a gap', () => {
    expect(pulseGaps(measure({ landedPerH: null, greenPerH: null, judgeWaitMedianMin: null }), targets)).toEqual([]);
  });
  test('the brief starts with phase and rhythm and carries the contract', () => {
    const row = loadRhythm(RHYTHM).rows.get('build')!;
    const brief = renderPulseBrief({ window: '2026-11-26T12:00:00.000Z', phase: { phase: 'build', evidence: 'e' }, row, gaps: [{ metric: 'landed/h', space: 'FED', value: 7, target: '≥ 20' }], table: 't', phaseChanged: null, tablePath: '/x' });
    expect(brief.split('\n')[0]).toBe('[pulse 2026-11-26T12:00:00.000Z] 국면: build · 리듬: 60분 · 착지 20/h · 초록 10/h · 판정 대기 ≤30m · 손잡이 reprioritize, lend-hands, judge-relief, vm-ask, burst-propose');
    expect(brief).toContain('eln pulse verify --window 2026-11-26T12:00:00.000Z');
  });
});

describe('due', () => {
  const row = rhythmRow(rhythm, 'build');
  const phase = { phase: 'build' as const, evidence: 'e' };
  test('cadence not elapsed → not due; elapsed → due', () => {
    expect(pulseDue({ now: new Date('2026-11-26T12:30:00Z'), phase, row, state: { lastPulseAt: '2026-11-26T12:00:00Z', lastPhase: 'build' } }).met).toBe(false);
    expect(pulseDue({ now: new Date('2026-11-26T13:00:00Z'), phase, row, state: { lastPulseAt: '2026-11-26T12:00:00Z', lastPhase: 'build' } }).met).toBe(true);
  });
  test('a phase change is due at once', () => {
    const r = pulseDue({ now: new Date('2026-11-26T12:05:00Z'), phase: { phase: 'release-window', evidence: 'cut' }, row, state: { lastPulseAt: '2026-11-26T12:00:00Z', lastPhase: 'build' } });
    expect(r.met).toBe(true);
    expect(r.key).toBe('phase:build->release-window@2026-11-26T12:00:00Z');
  });
});

describe('urgency field (structured)', () => {
  test('parse and read from refs', () => {
    expect(parseUrgency('ALL-IN')).toBe('all-in');
    expect(() => parseUrgency('asap')).toThrow('--urgency must be');
    expect(urgencyOf(['goal:task', 'urgency:urgent'])).toBe('urgent');
    expect(urgencyOf(['긴급'])).toBe(null);
  });
  test('only crown mails with urgent/all-in after the last pulse count; all-in first', () => {
    const lines = urgentCeoLines([
      { id: 1, crownDirective: 'c1', refs: ['urgency:all-in'], createdAt: '2026-11-26T11:00:00Z' },
      { id: 2, crownDirective: 'c2', refs: ['urgency:urgent'], createdAt: '2026-11-26T12:10:00Z' },
      { id: 3, crownDirective: 'c3', refs: ['urgency:all-in'], createdAt: '2026-11-26T12:20:00Z' },
      { id: 4, crownDirective: null, refs: ['urgency:all-in'], createdAt: '2026-11-26T12:21:00Z' },
      { id: 5, crownDirective: 'c5', refs: ['urgency:normal'], createdAt: '2026-11-26T12:22:00Z' },
    ], '2026-11-26T12:00:00Z');
    expect(lines.map(l => l.msgId)).toEqual([3, 2]);
  });
});
