import { describe, expect, test } from 'bun:test';
import { EMPTY_DECISIONS, parseDecision, reduceDecisions } from './pty-decisions';

const raw = {
  ts: '2026-10-03T08:35:00Z', missionId: 'one', seq: 1, sessionId: 'session',
  terminalId: 'terminal', agent: 'codex', step: 'read', text: '화면을 읽는다',
};
const decision = (patch: Record<string, unknown> = {}) => parseDecision({ ...raw, ...patch })!;

describe('pty.decision parsing', () => {
  test('accepts all six steps and their required details', () => {
    for (const step of ['read', 'judge', 'input'] as const) expect(decision({ step }).step === step).toBe(true);
    expect(decision({ step: 'input', detail: { keys: 'Enter', row: 2 } })).toMatchObject({ detail: { keys: 'Enter', row: 2 } });
    expect(decision({ step: 'answer', detail: { question: '허용?', answer: '예' } }).detail).toEqual({ question: '허용?', answer: '예' });
    expect(decision({ step: 'recover', detail: { blocked: '막힘', action: '다시 시도' } }).step).toBe('recover');
    for (const kind of ['pr', 'file', 'text']) expect(decision({ step: 'done', detail: { result: { kind, ref: 'result' } } }).step).toBe('done');
  });

  test('rejects unknown steps, broken fields and broken step details', () => {
    for (const patch of [
      { step: 'pause' }, { seq: NaN }, { seq: -1 }, { seq: 1.5 }, { missionId: '' },
      { ts: 'bad date' }, { sessionId: null }, { terminalId: 7 }, { terminalId: '' }, { terminalId: '   ' }, { agent: [] }, { text: '' },
      { detail: [] }, { step: 'answer', detail: { question: '왜?' } },
      { step: 'recover', detail: { blocked: '막힘', action: 2 } },
      { step: 'done', detail: { result: { kind: 'other', ref: 'result' } } },
      { step: 'done', detail: { result: { kind: 'file', ref: '' } } },
    ]) expect(parseDecision({ ...raw, ...patch })).toBeNull();
    expect(parseDecision(null)).toBeNull();
    expect(parseDecision('not json')).toBeNull();
  });
});

describe('mission reducer', () => {
  test('groups inherited-property mission IDs safely without losing duplicates or chronology', () => {
    const first = reduceDecisions(EMPTY_DECISIONS, decision({ missionId: '__proto__', seq: 2 }));
    expect(first.missions['__proto__'].map((entry) => entry.seq)).toEqual([2]);
    expect(first.currentMissionId).toBe('__proto__');
    const second = reduceDecisions(first, decision({ missionId: 'constructor', seq: 3, ts: '2026-10-03T08:36:00Z' }));
    expect(second.missions['constructor'].map((entry) => entry.seq)).toEqual([3]);
    expect(second.currentMissionId).toBe('constructor');
    const late = reduceDecisions(second, decision({ missionId: '__proto__', seq: 1, ts: '2026-10-03T08:34:00Z' }));
    expect(late.missions['__proto__'].map((entry) => entry.seq)).toEqual([1, 2]);
    expect(reduceDecisions(late, decision({ missionId: '__proto__', seq: 1 }))).toBe(late);
    expect(late.currentMissionId).toBe('constructor');
  });

  test('groups by mission, sorts late arrivals, ignores duplicate seq and retains newest mission', () => {
    const first = reduceDecisions(EMPTY_DECISIONS, decision({ seq: 3, ts: '2026-10-03T08:35:03Z' }));
    const second = reduceDecisions(first, decision({ seq: 1, ts: '2026-10-03T08:35:01Z' }));
    expect(second.missions.one.map((e) => e.seq)).toEqual([1, 3]);
    const duplicate = reduceDecisions(second, decision({ seq: 1, text: 'duplicate' }));
    expect(duplicate).toBe(second);
    const newer = reduceDecisions(second, decision({ missionId: 'two', seq: 1, ts: '2026-10-03T08:36:00Z' }));
    expect(newer.currentMissionId).toBe('two');
    expect(newer.missions.one).toEqual(second.missions.one);
    const late = reduceDecisions(newer, decision({ seq: 2, ts: '2026-10-03T08:35:02Z' }));
    expect(late.missions.one.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(late.currentMissionId).toBe('two');
    expect(EMPTY_DECISIONS.missions).toEqual({});
  });
});
