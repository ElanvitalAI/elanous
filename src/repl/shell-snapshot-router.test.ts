import { describe, expect, test } from 'bun:test';
import { createPushNowRouter, createShellSnapshotRouter } from './shell-snapshot-router.js';

describe('REPL shell snapshot routing', () => {
  test('buffers a snapshot sent before the turn listener is ready', () => {
    const router = createShellSnapshotRouter();
    let snapshots = 0;

    expect(router.receive({ type: 'elanous.next-tui.shell-snapshot', turnId: 'turn-1' })).toBe(true);
    router.listen('turn-1', () => { snapshots += 1; });

    expect(snapshots).toBe(1);
  });

  test('routes snapshots only to the matching active turn', () => {
    const router = createShellSnapshotRouter();
    let first = 0;
    let second = 0;
    router.listen('turn-1', () => { first += 1; });
    router.listen('turn-2', () => { second += 1; });

    router.receive({ type: 'elanous.next-tui.shell-snapshot', turnId: 'turn-2' });

    expect(first).toBe(0);
    expect(second).toBe(1);
  });
});

describe('REPL push-now routing', () => {
  test('retains each request ID until its matching turn is ready', () => {
    const router = createPushNowRouter();
    const seen: string[] = [];
    router.receive({ type: 'elanous.next-tui.push-now', turnId: 'later', requestId: 'esc-old' });
    router.receive({ type: 'elanous.next-tui.push-now', turnId: 'current', requestId: 'push-new' });
    router.listen('current', ({ requestId, phase }) => seen.push(`${requestId}:${phase}`));
    expect(seen).toEqual(['push-new:probe']);
    router.listen('later', ({ requestId, phase }) => seen.push(`${requestId}:${phase}`));
    expect(seen).toEqual(['push-new:probe', 'esc-old:probe']);
  });

  test('the decision observes a tool start before the request in one event-loop order', () => {
    const router = createPushNowRouter();
    const active = new Set<string>();
    const decisions: string[] = [];
    router.listen('turn', ({ requestId, phase }) => decisions.push(`${requestId}:${phase}:${active.size ? 'deferred' : 'ready'}`));
    active.add('Agent');
    router.receive({ type: 'elanous.next-tui.push-now', turnId: 'turn', requestId: 'push-1' });
    active.clear();
    router.receive({ type: 'elanous.next-tui.push-now', turnId: 'turn', requestId: 'push-2' });
    expect(decisions).toEqual(['push-1:probe:deferred', 'push-2:probe:ready']);
  });

  test('commit retains the matching request ID and cannot be confused with a probe', () => {
    const router = createPushNowRouter();
    const seen: string[] = [];
    router.listen('turn', ({ requestId, phase }) => seen.push(`${requestId}:${phase}`));
    router.receive({ type: 'elanous.next-tui.push-now', turnId: 'turn', requestId: 'push-1' });
    router.receive({ type: 'elanous.next-tui.push-now-commit', turnId: 'turn', requestId: 'push-1' });
    expect(seen).toEqual(['push-1:probe', 'push-1:commit']);
  });
});
