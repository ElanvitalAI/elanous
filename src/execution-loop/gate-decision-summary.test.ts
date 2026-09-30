import { describe, expect, test } from 'bun:test';
import { summarizeGateDecision } from './gate-decision-summary.js';

const marker = 'MARKER-7f3a';

describe('summarizeGateDecision', () => {
  test('budget includes action, optional provider and only the first 80 characters of the first reason', () => {
    const reason = 'abcd '.repeat(16) + marker;
    const result = { decision: { action: 'next-provider', provider: 'grok', reasons: [reason, 'second reason'] }, explanation: marker };
    expect(summarizeGateDecision('budget', result)).toBe(`action=next-provider · provider=grok · reason=${'abcd '.repeat(16)}`);
    expect(summarizeGateDecision('budget', { decision: { action: 'stop', reasons: [] }, explanation: '' })).toBe('action=stop · reason=');
  });

  test('placement reports substrate, pool, memory limit and unknown input names, not other fields', () => {
    const summary = summarizeGateDecision('placement', { decision: {
      substrate: 'pod', pool: 'node-b', memory: { limit: '8Gi', tier: marker, source: 'goal' },
      unknownInputs: ['needsBrowser', 'localFiles'], localReasons: [marker], poolReachability: 'unknown', source: 'flag',
    }, explanation: marker });
    expect(summary).toBe('substrate=pod · pool=node-b · memory=8Gi · unknown=needsBrowser,localFiles');
    expect(summarizeGateDecision('placement', { decision: {
      substrate: 'unknown', pool: null, unknownInputs: [], localReasons: [], poolReachability: 'unknown', source: 'unknown',
    }, explanation: '' })).toBe('substrate=unknown · pool=none · unknown=');
  });

  test('relation counts overlapping cards and names only unknown fields', () => {
    const summary = summarizeGateDecision('relation', { decision: {
      action: 'record', overlappingCards: [marker, 'card-b'], preflightOverlaps: 'unknown', dependsOn: 'unknown',
      similarCards: [], sameGoalActiveRuns: 'unknown', priorTermination: marker,
    }, explanation: marker });
    expect(summary).toBe('overlap=2 · unknown=preflightOverlaps,dependsOn,sameGoalActiveRuns');
  });

  test('memory reports only recall presence and fragment count, never recalled text or other strings', () => {
    const result = { decision: { action: 'record', context: marker, fragmentIds: [marker, 'id-2'], priorAbandonment: marker }, explanation: marker };
    expect(summarizeGateDecision('memory', result)).toBe('context=recalled · fragments=2');
    expect(summarizeGateDecision('memory', { decision: { ...result.decision, context: '', fragmentIds: [] }, explanation: marker })).toBe('context=none · fragments=0');
    expect(summarizeGateDecision('memory', result)).not.toContain(marker);
  });

  test('string decision is unavailable; memory never includes explanation even when recalled text is first', () => {
    expect(summarizeGateDecision('memory', { decision: '측정 불가', explanation: `${marker} recalled conversation` }))
      .toBe('unavailable');
    expect(summarizeGateDecision('budget', { decision: '측정 불가', explanation: 'xyz '.repeat(20) + marker }))
      .toBe(`unavailable · explanation=${'xyz '.repeat(20)}`);
  });

  test('all four gate summaries and unavailable stay within 250 characters and redact secrets', () => {
    const long = 'x'.repeat(500);
    const secret = 'sk-abcdefghijklmnopqrs0123456789';
    const results = [
      ['budget', { decision: { action: 'stop', provider: secret, reasons: [long] }, explanation: long }],
      ['placement', { decision: { substrate: 'pod', pool: long, memory: { limit: long }, unknownInputs: [long] }, explanation: long }],
      ['relation', { decision: { overlappingCards: [], preflightOverlaps: 'unknown', dependsOn: 'unknown', similarCards: 'unknown', sameGoalActiveRuns: 'unknown' }, explanation: long }],
      ['memory', { decision: { context: marker, fragmentIds: [] }, explanation: marker }],
      ['budget', { decision: 'unavailable', explanation: long }],
    ] as const;
    for (const [gate, result] of results) {
      const summary = summarizeGateDecision(gate, result);
      expect(summary.length).toBeLessThanOrEqual(250);
      expect(summary).not.toContain(secret);
      expect(summary).not.toContain(marker);
    }
    expect(summarizeGateDecision('budget', results[0][1])).toContain('<redacted>');
    const splitSecret = `${'z'.repeat(30)} ${'sk-abcdefghijklmnopqrs0123456789'}`;
    expect(summarizeGateDecision('budget', { decision: { action: 'stop', reasons: [splitSecret] }, explanation: '' }))
      .toBe(`action=stop · reason=${'z'.repeat(30)} <redacted>`);
    expect(summarizeGateDecision('budget', { decision: '측정 불가', explanation: splitSecret }))
      .toBe(`unavailable · explanation=${'z'.repeat(30)} <redacted>`);
  });
});
