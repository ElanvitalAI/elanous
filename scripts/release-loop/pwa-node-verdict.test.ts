import { describe, expect, test } from 'bun:test';
import { decideVerdict, exitCodeFor, idsToRerun } from './pwa-node-verdict';

describe('release-loop PWA node verdict', () => {
  test('all pass on the first run → pass, nothing to rerun', () => {
    const first = [{ id: 'T1', pass: true }, { id: 'C1', pass: true }];
    expect(idsToRerun(first)).toEqual([]);
    const v = decideVerdict(first, []);
    expect(v.verdict).toBe('pass');
    expect(exitCodeFor(v.verdict)).toBe(0);
  });

  test('fails first, passes on a rerun → flaky, still exit 0 (the 0.2.3 cut: T4a, N5a)', () => {
    const first = [{ id: 'T4a', pass: false }, { id: 'N5a', pass: false }, { id: 'T1', pass: true }];
    expect(idsToRerun(first)).toEqual(['T4a', 'N5a']);
    const v = decideVerdict(first, [[{ id: 'T4a', pass: true }, { id: 'N5a', pass: false }], [{ id: 'N5a', pass: true }]]);
    expect(v.verdict).toBe('flaky');
    expect(v.cells.find((c) => c.id === 'N5a')).toEqual({ id: 'N5a', first: 'fail', reruns: ['fail', 'pass'], final: 'flaky' });
    expect(exitCodeFor(v.verdict)).toBe(0);
  });

  test('never passes → fail, exit 1', () => {
    const v = decideVerdict([{ id: 'C1', pass: false }], [[{ id: 'C1', pass: false }], [{ id: 'C1', pass: false }]]);
    expect(v.verdict).toBe('fail');
    expect(exitCodeFor(v.verdict)).toBe(1);
  });

  test('blocked (selector gone) is a fail even if a rerun passes', () => {
    const v = decideVerdict([{ id: 'N1', pass: false, blocked: true }], [[{ id: 'N1', pass: true }]]);
    expect(v.cells[0]!.final).toBe('fail');
    expect(v.verdict).toBe('fail');
  });
});
