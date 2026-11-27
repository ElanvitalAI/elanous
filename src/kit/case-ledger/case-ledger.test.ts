import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attemptsOf, moveCase, openCase, overdueCases, readCases, unnormalizedCases } from './index.js';

const T0 = new Date('2026-11-27T13:00:00Z');
const at = (m: number) => new Date(T0.getTime() + m * 60_000);
const base = { domain: 'loop-exception', id: 'loop:release-traffic@2026-11-27T13:20', subject: 'release-traffic 예외', owner: 'OP', slaMin: 60, by: 'RUN-DOCTOR', why: 'last fire exception' };

describe('kit/case-ledger — detect → normalize → resolved | escalated', () => {
  test('open is idempotent while open · acting rows count normalize attempts · resolved only by a move · re-detection reopens', () => {
    const root = mkdtempSync(join(tmpdir(), 'cases-'));
    expect(openCase(root, base, T0)!.state).toBe('detected');
    openCase(root, base, at(1));
    expect(readCases(root, 'loop-exception').length).toBe(1);
    expect(readCases(root, 'loop-exception')[0]!.history.length).toBe(1); // the second open wrote nothing
    moveCase(root, 'loop-exception', base.id, 'acting', { by: 'RUN-DOCTOR', why: 'normalize 1' }, at(2));
    const c2 = moveCase(root, 'loop-exception', base.id, 'acting', { by: 'RUN-DOCTOR', why: 'normalize 2' }, at(10))!;
    expect([c2.state, attemptsOf(c2)]).toEqual(['acting', 2]);
    const r = moveCase(root, 'loop-exception', base.id, 'resolved', { by: 'RUN-DOCTOR', why: 'normal again' }, at(20))!;
    expect(r.state).toBe('resolved');
    expect(moveCase(root, 'loop-exception', base.id, 'acting', { by: 'X', why: 'refused move' }, at(21))).toBeNull(); // resolved → acting is not a move
    const again = openCase(root, base, at(30))!;
    expect([again.state, attemptsOf(again), again.detectedAt]).toEqual(['detected', 0, at(30).toISOString()]);
  });
  test('an open case past its SLA is overdue · the «미정상화 사건» count spans every domain', () => {
    const root = mkdtempSync(join(tmpdir(), 'cases-'));
    openCase(root, base, T0);
    openCase(root, { ...base, domain: 'other-domain', id: 'x:1', slaMin: 10 }, T0);
    expect(overdueCases(readCases(root, 'loop-exception'), at(59)).length).toBe(0);
    expect(overdueCases(readCases(root, 'loop-exception'), at(61)).length).toBe(1);
    expect(unnormalizedCases(root, at(30))).toEqual({ open: 2, overdue: 1, ids: ['loop:release-traffic@2026-11-27T13:20', 'x:1'] });
    moveCase(root, 'other-domain', 'x:1', 'escalated', { by: 'RUN-DOCTOR', why: 'card' }, at(31));
    expect(unnormalizedCases(root, at(32))).toEqual({ open: 2, overdue: 0, ids: ['loop:release-traffic@2026-11-27T13:20', 'x:1'] }); // escalated is still not normal
    expect(openCase(root, { ...base, domain: 'other-domain', id: 'x:1', slaMin: 10 }, at(33))!.state).toBe('escalated'); // no re-detection while escalated
    moveCase(root, 'other-domain', 'x:1', 'resolved', { by: 'RUN-DOCTOR', why: 'normal again' }, at(40));
    expect(unnormalizedCases(root, at(41))!.open).toBe(1);
  });
});
