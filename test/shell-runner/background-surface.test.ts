import { describe, test, expect } from 'bun:test';

import { createBackgroundSurface } from '../../src/shell-runner/background-surface.js';
import type {
  BoundaryEvent,
  BufferMark,
  OutputChunk,
  ShellHandle,
  ShellResult,
  ShellStatus,
  Unsubscribe,
} from '../../src/shell-runner/types.js';

function fakeHandle(id: string = 'h', mode: ShellHandle['mode'] = 'bg'): ShellHandle & {
  emitChunk: (c: OutputChunk) => void;
  emitStatus: (s: ShellStatus) => void;
} {
  const chunkSubs = new Set<(c: OutputChunk) => void>();
  const statusSubs = new Set<(s: ShellStatus) => void>();
  let status: ShellStatus = 'running';
  const bookmark: BufferMark = { row: 0, col: 0, ts: 0, bytes: 0 };
  const result = new Promise<ShellResult>(() => { /* never */ });
  return {
    id,
    mode,
    get status() { return status; },
    bookmark,
    kill() { /* noop */ },
    background() { return false; },
    promote() { return false; },
    write() { /* noop */ },
    resize() { /* noop */ },
    onChunk(cb) { chunkSubs.add(cb); return (() => chunkSubs.delete(cb)) as Unsubscribe; },
    onStatus(cb) { statusSubs.add(cb); return (() => statusSubs.delete(cb)) as Unsubscribe; },
    onBoundary(_cb: (ev: BoundaryEvent) => void) { return (() => {}) as Unsubscribe; },
    result,
    emitChunk(c) { for (const cb of chunkSubs) cb(c); },
    emitStatus(s) { status = s; for (const cb of statusSubs) cb(s); },
  };
}

function fakeScheduler() {
  let next = 1;
  const tasks = new Map<number, { cb: () => void; at: number }>();
  let clock = 0;
  return {
    setTimeout(cb: () => void, ms: number) {
      const id = next++;
      tasks.set(id, { cb, at: clock + ms });
      return id;
    },
    clearTimeout(t: unknown) { tasks.delete(t as number); },
    advance(ms: number) {
      clock += ms;
      const fires: Array<() => void> = [];
      for (const [id, t] of tasks) {
        if (t.at <= clock) { fires.push(t.cb); tasks.delete(id); }
      }
      for (const f of fires) f();
    },
  };
}

describe('BackgroundSurface', () => {
  test('track adds rows; rollup counts reflect statuses', () => {
    const surf = createBackgroundSurface();
    const a = fakeHandle('a'); const b = fakeHandle('b');
    surf.track(a); surf.track(b);
    b.emitStatus('backgrounded');
    const snap = surf.snapshot();
    expect(snap.total).toBe(2);
    expect(snap.running).toBe(1);
    expect(snap.backgrounded).toBe(1);
  });

  test('TUI-BG-JOB-VISIBILITY — background = 살아 있는 bg 모드 ⊕ backgrounded · 끝나면 0', () => {
    const surf = createBackgroundSurface({ retainCompletedMs: 0 });
    const job = fakeHandle('job', 'bg');
    surf.track(job);
    expect(surf.snapshot().background).toBe(1);
    job.emitStatus('completed');
    expect(surf.snapshot().background).toBe(0);
  });

  test('TUI-BG-JOB-VISIBILITY — 인라인(전경) 실행은 background 로 안 센다 · 뒤로 보내면 센다', () => {
    const surf = createBackgroundSurface();
    const inline = fakeHandle('in', 'inline');
    surf.track(inline);
    let snap = surf.snapshot();
    expect(snap.running).toBe(1);
    expect(snap.background).toBe(0);
    inline.emitStatus('backgrounded');
    snap = surf.snapshot();
    expect(snap.backgrounded).toBe(1);
    expect(snap.background).toBe(1);
    inline.emitStatus('killed');
    expect(surf.snapshot().background).toBe(0);
  });

  test('TUI-BG-JOB-VISIBILITY — onUpdate 집계에 background 가 실린다', () => {
    const seen: number[] = [];
    const surf = createBackgroundSurface({ onUpdate: (r) => { seen.push(r.background); } });
    surf.track(fakeHandle('a', 'bg'));
    surf.track(fakeHandle('b', 'inline'));
    expect(seen).toEqual([1, 1]);
  });

  test('duplicate track is ignored', () => {
    const surf = createBackgroundSurface();
    const h = fakeHandle('x');
    surf.track(h);
    surf.track(h);
    expect(surf.snapshot().total).toBe(1);
  });

  test('onUpdate fires on every attach, chunk, and status change', () => {
    const calls: number[] = [];
    const surf = createBackgroundSurface({ onUpdate: (r) => calls.push(r.total) });
    const h = fakeHandle();
    surf.track(h);                                   // +1 emit
    h.emitChunk({ stream: 'stdout', bytes: 'a', ts: 0 }); // +1
    h.emitStatus('backgrounded');                    // +1
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  test('describe returns per-row detail', () => {
    const surf = createBackgroundSurface();
    const h = fakeHandle('rich');
    surf.track(h, 'build script');
    h.emitChunk({ stream: 'stdout', bytes: 'hello', ts: 0 });
    const row = surf.describe('rich')!;
    expect(row.id).toBe('rich');
    expect(row.label).toBe('build script');
    expect(row.totalBytes).toBe(5);
    expect(row.status).toBe('running');
    expect(row.exposure).toEqual({
      userExposure: 'hidden',
      agentInteractive: true,
    });
  });

  test('forget removes a row without killing the handle', () => {
    const surf = createBackgroundSurface();
    const h = fakeHandle('byebye');
    surf.track(h);
    surf.forget('byebye');
    expect(surf.snapshot().total).toBe(0);
    expect(surf.describe('byebye')).toBeNull();
  });

  test('completed rows retain for retainCompletedMs then drop', () => {
    const sched = fakeScheduler();
    const surf = createBackgroundSurface({
      scheduler: sched,
      retainCompletedMs: 500,
    });
    const h = fakeHandle('retain');
    surf.track(h);
    h.emitStatus('completed');
    expect(surf.snapshot().total).toBe(1);
    expect(surf.describe('retain')?.exposure).toEqual({
      userExposure: 'unavailable',
      agentInteractive: false,
    });
    sched.advance(499);
    expect(surf.snapshot().total).toBe(1);
    sched.advance(2);
    expect(surf.snapshot().total).toBe(0);
  });

  test('retainCompletedMs=0 removes immediately on completion', () => {
    const surf = createBackgroundSurface({ retainCompletedMs: 0 });
    const h = fakeHandle('gone');
    surf.track(h);
    h.emitStatus('completed');
    expect(surf.snapshot().total).toBe(0);
  });

  test('detach clears everything and unsubs', () => {
    const surf = createBackgroundSurface();
    const h = fakeHandle('x');
    surf.track(h);
    surf.detach();
    expect(surf.snapshot().total).toBe(0);
    // Events after detach should be no-ops — tracking the handle
    // again should cleanly start fresh.
    surf.track(h);
    expect(surf.snapshot().total).toBe(1);
  });

  test('attach(handle) is a single-track alias (inherited from ShellSurface)', () => {
    const surf = createBackgroundSurface();
    const h = fakeHandle('alias');
    surf.attach(h);
    expect(surf.snapshot().total).toBe(1);
  });

  test('idleMs grows when no chunks arrive', () => {
    const nowRef = { v: 1000 };
    const surf = createBackgroundSurface({ now: () => nowRef.v });
    const h = fakeHandle('idle');
    surf.track(h);
    nowRef.v = 1500;
    const row = surf.describe('idle')!;
    expect(row.idleMs).toBeGreaterThanOrEqual(500);
  });
});
