import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNextTuiQueue } from './core/queue.js';
import { createSeatMailArrivalWatcher } from './seat-mail-arrival.js';

// This tests the actual watcher start/stop boundary and guards the production entry connection.
describe('Next seat mail liveness wiring', () => {
  test('entry supplies the current session to the watcher, which it starts and stops', () => {
    const entry = readFileSync(join(import.meta.dir, 'entry.ts'), 'utf8');
    expect(entry).toMatch(/heartbeat:\s*\{\s*getSessionId:\s*\(\)\s*=>\s*id\s*\}/);
    expect(entry).toContain('seatMailWatcher.start()');
    expect(entry).toContain('seatMailWatcher.stop()');
  });
  test('heartbeat errors do not block polling or teardown', () => {
    let pollCleared = false; let tick: (() => void) | undefined; let unavailable = true;
    const watcher = createSeatMailArrivalWatcher('/seats/TEST', createNextTuiQueue({}), {
      timer: { set: () => 1, clear: () => { pollCleared = true; } },
      heartbeat: { seatStateRoot: '/dev/null', getSessionId: () => { if (unavailable) throw new Error('session unavailable'); return 'sid'; },
        schedule: (fn) => { tick = fn; return 1 as unknown as ReturnType<typeof setInterval>; }, cancel: () => {} },
    });
    expect(() => watcher.start()).not.toThrow();
    expect(() => tick!()).not.toThrow();
    unavailable = false; expect(() => tick!()).not.toThrow();
    expect(() => watcher.stop()).not.toThrow();
    expect(pollCleared).toBe(true);
  });
  test('only successful reads permit heartbeats; read failure pauses and recovery resumes', () => {
    const root = mkdtempSync(join(tmpdir(), 'seat-alive-health-'));
    const path = join(root, 'TEST', 'inbox.alive');
    let healthy = false; let sid = 'sid'; let beat = () => {};
    const watcher = createSeatMailArrivalWatcher('/seats/TEST', createNextTuiQueue({}), {
      readSnapshot: () => { if (!healthy) throw new Error('ledger unavailable'); return { seat: 'TEST', unread: 0 }; },
      onReadError: () => {}, timer: { set: () => 1, clear: () => {} },
      heartbeat: { getSessionId: () => sid, seatStateRoot: root, host: 'host',
        schedule: fn => { beat = fn; return 1 as unknown as ReturnType<typeof setInterval>; }, cancel: () => {} },
    });
    try {
      watcher.start(); beat(); expect(existsSync(path)).toBe(false);
      healthy = true; watcher.poll(); beat(); expect(existsSync(path)).toBe(true);
      const before = readFileSync(path, 'utf8');
      healthy = false; watcher.poll(); beat(); expect(readFileSync(path, 'utf8')).toBe(before);
      sid = 'recovered'; healthy = true; watcher.poll(); beat();
      expect(watcher.getStatus()).toBe('running');
      expect(JSON.parse(readFileSync(path, 'utf8')).sessionId).toBe('recovered');
    } finally { watcher.stop(); rmSync(root, { recursive: true, force: true }); }
  });
  test('start beats, refreshes session and stop cancels heartbeat without affecting watcher', () => {
    const root = mkdtempSync(join(tmpdir(), 'seat-alive-'));
    let sid = 'one'; let beat: (() => void) | undefined; let cancelled = false;
    const watcher = createSeatMailArrivalWatcher('/seats/TEST', createNextTuiQueue({}), {
      timer: { set: () => 1, clear: () => {} },
      readSnapshot: () => ({ seat: 'TEST', unread: 0 }),
      heartbeat: { getSessionId: () => sid, seatStateRoot: root, host: 'host',
        schedule: (fn) => { beat = fn; return 1 as unknown as ReturnType<typeof setInterval>; },
        cancel: () => { cancelled = true; } },
    });
    try {
      watcher.start(); watcher.poll(); beat!();
      const path = join(root, 'TEST', 'inbox.alive');
      expect(JSON.parse(readFileSync(path, 'utf8')).sessionId).toBe('one');
      sid = 'two'; beat!();
      expect(JSON.parse(readFileSync(path, 'utf8')).sessionId).toBe('two');
      watcher.stop(); expect(cancelled).toBe(true);
    } finally { watcher.stop(); rmSync(root, { recursive: true, force: true }); }
  });
});
