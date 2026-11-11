// PR-1 G7 transition coverage · multi-platform substrate ROADMAP.
//
// Verifies that ShellRegistry.{describePosture,subscribePosture,
// listWithPosture,attachSurface} satisfy the no-stale-posture invariant
// across the four critical transitions:
//   1. vw setFocusPolicy('output-only' → 'interactive')
//   2. shell status: running → completed
//   3. shell status: running → killed
//   4. attach initial snapshot (lazy lookup is instantly fresh)
//
// Real wiring throughout — actual VwSurface instances are constructed
// and attached to a real registry. Per CLAUDE.md no mock.module() use.

import { describe, expect, test } from 'bun:test';

import { createShellRegistry } from '../../src/shell-runner/registry.js';
import { createVwSurface } from '../../src/shell-runner/vw-surface.js';
import type {
  BoundaryEvent,
  BufferMark,
  OutputChunk,
  ShellHandle,
  ShellMode,
  ShellResult,
  ShellStatus,
  Unsubscribe,
} from '../../src/shell-runner/types.js';
import type {
  TerminalExposureSnapshot,
} from '../../src/terminal/posture.js';

function fakeHandle(opts: { id?: string; mode?: ShellHandle['mode'] } = {}): ShellHandle & {
  emitChunk: (c: OutputChunk) => void;
  emitStatus: (s: ShellStatus) => void;
  emitBoundary: (ev: BoundaryEvent) => void;
} {
  const chunkSubs = new Set<(c: OutputChunk) => void>();
  const statusSubs = new Set<(s: ShellStatus) => void>();
  const boundarySubs = new Set<(ev: BoundaryEvent) => void>();
  let status: ShellStatus = 'running';
  const bookmark: BufferMark = { row: 0, col: 0, ts: 0, bytes: 0 };
  const result = new Promise<ShellResult>(() => { /* never */ });
  return {
    id: opts.id ?? 'h-1',
    mode: (opts.mode ?? 'vw') as Exclude<ShellMode, 'auto'>,
    get status() { return status; },
    bookmark,
    kill() { /* noop */ },
    background() { return false; },
    promote() { return false; },
    write() { /* noop */ },
    resize() { /* noop */ },
    onChunk(cb) { chunkSubs.add(cb); return (() => chunkSubs.delete(cb)) as Unsubscribe; },
    onStatus(cb) { statusSubs.add(cb); return (() => statusSubs.delete(cb)) as Unsubscribe; },
    onBoundary(cb) { boundarySubs.add(cb); return (() => boundarySubs.delete(cb)) as Unsubscribe; },
    result,
    emitChunk(c) { for (const cb of chunkSubs) cb(c); },
    emitStatus(s) { status = s; for (const cb of statusSubs) cb(s); },
    emitBoundary(ev) { for (const cb of boundarySubs) cb(ev); },
  };
}

describe('ShellRegistry posture proxy (PR-1 G7)', () => {
  test('attachSurface + describePosture lazy-proxies surface.posture()', () => {
    const reg = createShellRegistry();
    const handle = fakeHandle({ id: 'h-vw1', mode: 'vw' });
    const vw = createVwSurface({ focusPolicy: 'output-only' });
    vw.attach(handle);
    reg.register(handle);
    reg.attachSurface(handle.id, vw);

    expect(reg.describePosture('h-vw1')).toEqual({
      userExposure: 'observe-only',
      agentInteractive: true,
    });
    reg.dispose();
  });

  test('G7 transition 1 · vw setFocusPolicy output-only → interactive fires posture-changed', () => {
    const reg = createShellRegistry();
    const handle = fakeHandle({ id: 'h-vw2', mode: 'vw' });
    const vw = createVwSurface({ focusPolicy: 'output-only' });
    vw.attach(handle);
    reg.register(handle);
    reg.attachSurface(handle.id, vw);

    const events: Array<{ prev: TerminalExposureSnapshot | null; next: TerminalExposureSnapshot | null }> = [];
    reg.subscribePosture((e) => {
      events.push({ prev: e.prev, next: e.next });
    });

    // Sanity: no transitions yet (subscribed after attach)
    expect(events.length).toBe(0);

    vw.setFocusPolicy('interactive');

    expect(events.length).toBe(1);
    expect(events[0].prev?.userExposure).toBe('observe-only');
    expect(events[0].next?.userExposure).toBe('user-interactive');
    expect(reg.describePosture('h-vw2')?.userExposure).toBe('user-interactive');

    reg.dispose();
  });

  test('G7 transition 2 · running → completed flips exposure to unavailable', () => {
    const reg = createShellRegistry();
    const handle = fakeHandle({ id: 'h-vw3', mode: 'vw' });
    const vw = createVwSurface({ focusPolicy: 'interactive' });
    vw.attach(handle);
    reg.register(handle);
    reg.attachSurface(handle.id, vw);

    const events: string[] = [];
    reg.subscribePosture((e) => {
      events.push(e.next?.userExposure ?? 'null');
    });

    handle.emitStatus('completed');

    // Both surface.onPostureChanged and registry.onStatus path the same
    // refreshPosture call, but exposure-level diffing means only one
    // transition fires.
    expect(events).toContain('unavailable');
    expect(reg.describePosture('h-vw3')?.userExposure).toBe('unavailable');
    expect(reg.describePosture('h-vw3')?.agentInteractive).toBe(false);

    reg.dispose();
  });

  test('G7 transition 3 · running → killed flips exposure to unavailable', () => {
    const reg = createShellRegistry();
    const handle = fakeHandle({ id: 'h-vw-killed', mode: 'vw' });
    const vw = createVwSurface({ focusPolicy: 'interactive' });
    vw.attach(handle);
    reg.register(handle);
    reg.attachSurface(handle.id, vw);

    const transitions: string[] = [];
    reg.subscribePosture((e) => {
      transitions.push(`${e.prev?.userExposure ?? 'null'} -> ${e.next?.userExposure ?? 'null'}`);
    });

    handle.emitStatus('killed');

    expect(transitions).toContain('user-interactive -> unavailable');
    expect(reg.describePosture('h-vw-killed')?.userExposure).toBe('unavailable');

    reg.dispose();
  });

  test('G7 transition 4 · attach initial snapshot is instantly fresh (no stale)', () => {
    const reg = createShellRegistry();
    // Pre-mark the surface as 'completed' before registry sees it.
    // describePosture must reflect this immediately, no stale 'running' shown.
    const handle = fakeHandle({ id: 'h-vw4', mode: 'vw' });
    const vw = createVwSurface({ focusPolicy: 'interactive' });
    vw.attach(handle);
    handle.emitStatus('completed');

    reg.register(handle);
    reg.attachSurface(handle.id, vw);

    expect(reg.describePosture('h-vw4')).toEqual({
      userExposure: 'unavailable',
      agentInteractive: false,
    });

    reg.dispose();
  });

  test('chunk events do NOT fire posture-changed (G7 spurious-fire prevention)', () => {
    const reg = createShellRegistry();
    const handle = fakeHandle({ id: 'h-vw5', mode: 'vw' });
    const vw = createVwSurface({ focusPolicy: 'output-only' });
    vw.attach(handle);
    reg.register(handle);
    reg.attachSurface(handle.id, vw);

    const events: unknown[] = [];
    reg.subscribePosture((e) => events.push(e));

    handle.emitChunk({ bytes: 'hello', stream: 'stdout', ts: 0 });
    handle.emitChunk({ bytes: 'world', stream: 'stdout', ts: 1 });

    expect(events.length).toBe(0);
    reg.dispose();
  });

  test('listWithPosture enumerates handles + their current posture', () => {
    const reg = createShellRegistry();
    const h1 = fakeHandle({ id: 'h-list1', mode: 'vw' });
    const h2 = fakeHandle({ id: 'h-list2', mode: 'vw' });
    const vw = createVwSurface({ focusPolicy: 'output-only' });
    vw.attach(h1);
    const vw2 = createVwSurface({ focusPolicy: 'interactive' });
    vw2.attach(h2);
    reg.register(h1);
    reg.register(h2);
    reg.attachSurface(h1.id, vw);
    reg.attachSurface(h2.id, vw2);

    const items = reg.listWithPosture();
    const byId = new Map(items.map((it) => [it.handle.id, it.posture]));
    expect(byId.get('h-list1')?.userExposure).toBe('observe-only');
    expect(byId.get('h-list2')?.userExposure).toBe('user-interactive');

    reg.dispose();
  });

  test('mode=bg fallback synthesizes hidden posture without attached surface', () => {
    const reg = createShellRegistry();
    const handle = fakeHandle({ id: 'h-bg1', mode: 'bg' });
    reg.register(handle);
    // No attachSurface call — bg mode uses registry-side fallback.

    expect(reg.describePosture('h-bg1')).toEqual({
      userExposure: 'hidden',
      agentInteractive: true,
    });

    handle.emitStatus('completed');
    expect(reg.describePosture('h-bg1')?.userExposure).toBe('unavailable');

    reg.dispose();
  });

  test('unregister fires final posture-changed with next=null', () => {
    const reg = createShellRegistry();
    const handle = fakeHandle({ id: 'h-final', mode: 'vw' });
    const vw = createVwSurface({ focusPolicy: 'interactive' });
    vw.attach(handle);
    reg.register(handle);
    reg.attachSurface(handle.id, vw);

    const events: Array<{ next: TerminalExposureSnapshot | null }> = [];
    reg.subscribePosture((e) => events.push({ next: e.next }));

    reg.unregister('h-final');

    expect(events[events.length - 1].next).toBe(null);
    expect(reg.describePosture('h-final')).toBe(null);

    reg.dispose();
  });

  test('detach via attachSurface unsubscribe re-syncs posture', () => {
    const reg = createShellRegistry();
    const handle = fakeHandle({ id: 'h-detach', mode: 'vw' });
    const vw = createVwSurface({ focusPolicy: 'interactive' });
    vw.attach(handle);
    reg.register(handle);
    const detachSurface = reg.attachSurface(handle.id, vw);

    expect(reg.describePosture('h-detach')?.userExposure).toBe('user-interactive');

    detachSurface();
    // No surface, no bg fallback (mode=vw) → null
    expect(reg.describePosture('h-detach')).toBe(null);

    reg.dispose();
  });
});
