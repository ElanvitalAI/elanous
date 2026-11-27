// kit/trigger-lock (land-graph tick lock takes over a dead tick's lock at once) ⊕ kit/release-target (trigger facts follow
// release.graph.version, not «the earliest run») — DUPLICATION-MAP-1127 §1-2 · §1-11.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, lockHolderAlive } from '../land-graph/land-graph.js';
import { activeRelease } from './trigger-facts.js';

describe('land-graph tick lock', () => {
  test('a lock held by a dead pid is taken over at once; a live holder keeps it; release frees it', () => {
    const root = mkdtempSync(join(tmpdir(), 'land-lock-'));
    const home = join(root, 'land-graph');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'tick.lock'), '424242');
    expect(acquireLock(root, Date.now(), () => true)).toBeNull();          // alive → held
    const release = acquireLock(root, Date.now(), (pid) => pid !== 424242); // dead → taken over
    expect(release).not.toBeNull();
    release!();
    expect(acquireLock(root, Date.now(), () => true)).not.toBeNull();
  });
  test('an unreadable pid falls back to the 60-min age rule', () => {
    const root = mkdtempSync(join(tmpdir(), 'land-lock-'));
    const home = join(root, 'land-graph'); mkdirSync(home, { recursive: true });
    const lock = join(home, 'tick.lock');
    writeFileSync(lock, 'garbage');
    const t = Date.parse('2026-11-27T10:00:00Z');
    utimesSync(lock, new Date(t), new Date(t));
    expect(acquireLock(root, t + 10 * 60_000, () => true)).toBeNull();
    expect(acquireLock(root, t + 61 * 60_000, () => true)).not.toBeNull();
    expect(lockHolderAlive('x')).toBeNull();
    expect(lockHolderAlive('77', () => false)).toBe(false);
  });
});

describe('trigger facts — release in play', () => {
  const run = (root: string, v: string, cutAt: string, publishAt: string) => {
    mkdirSync(join(root, 'release-graph', v), { recursive: true });
    writeFileSync(join(root, 'release-graph', v, 'state.json'), JSON.stringify({ kind: 'release', clock: { cutAt, publishAt }, steps: {} }));
  };
  test('two unpublished runs: the graph target wins over the earliest run; no target → the earliest', () => {
    const root = mkdtempSync(join(tmpdir(), 'facts-target-'));
    run(root, '0.3.37', '2026-11-27T19:00:00Z', '2026-11-27T21:00:00Z');
    run(root, '0.3.38', '2026-11-28T04:00:00Z', '2026-11-28T06:00:00Z');
    const now = new Date('2026-11-27T12:00:00Z');
    expect(activeRelease(root, now, '0.3.38')?.version).toBe('0.3.38');
    expect(activeRelease(root, now, null)?.version).toBe('0.3.37');
    expect(activeRelease(root, now, '0.3.99')?.version).toBe('0.3.37'); // target without an active run here → fallback
  });
});
