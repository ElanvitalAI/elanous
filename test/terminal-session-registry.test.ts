import { describe, expect, test } from 'bun:test';

import {
  TerminalSessionRegistry,
  MAX_SESSIONS,
  type SessionEvent,
} from '../src/terminal/session-registry.js';
import { DisplayCoordinator } from '../src/display/coordinator.js';
import type { PreviewTerminal } from '../src/preview/terminal.js';
import type { PreviewTerminalOpts } from '../src/preview/terminal.js';
import { createControlSignalBus } from '../src/input/control-signal.js';

/** Shared fake PTY factory — the registry builds session objects
 *  around these without ever spawning real node-pty. */
function fakePreviewFactory(opts: PreviewTerminalOpts): PreviewTerminal {
  let alive = false;
  let cols = opts.cols;
  let rows = opts.rows;
  const writes: string[] = [];
  return {
    start: () => { alive = true; },
    stop: () => { alive = false; },
    write: (bytes: string) => writes.push(bytes),
    resize: (c: number, r: number) => { cols = c; rows = r; },
    render: (_f?: boolean) => 'row0\nrow1',
    cursorPosition: () => alive ? ({ row: 0, col: 0 }) : null,
    get isAlive(): boolean { return alive; },
    get cols(): number { return cols; },
    get rows(): number { return rows; },
    get pid(): number { return 1; },
    get isScrolledBack(): boolean { return false; },
    get scrollbackOffset(): number { return 0; },
    get wantsMouse(): boolean { return false; },
    writes,
    scrollUp: () => 0,
    scrollDown: () => 0,
    scrollToTop: () => {},
    scrollToTail: () => {},
    forwardMouse: () => {},
  } as unknown as PreviewTerminal;
}

function makeRegistry() {
  const coord = new DisplayCoordinator({ frameMs: 0 });
  const events: SessionEvent[] = [];
  const signalBus = createControlSignalBus(() => new Date().toISOString());
  const registry = new TerminalSessionRegistry({
    coordinator: coord,
    terminalFactory: fakePreviewFactory,
    signalBus,
  });
  const unsub = registry.subscribe((ev) => events.push(ev));
  return { coord, events, registry, unsub, signalBus };
}

describe('TerminalSessionRegistry', () => {
  test('spawn creates foreground session with modal + preview', () => {
    const { coord, events, registry } = makeRegistry();
    const session = registry.spawn(
      { title: 't', cwd: '/tmp' },
      { termCols: 100, termRows: 30 },
    );
    expect(session.state).toBe('foreground');
    expect(session.modal).not.toBeNull();
    expect(coord.modalStack()).toContain(session.id);
    expect(session.preview.isAlive).toBe(true);
    expect(events[0]?.type).toBe('spawned');
  });

  test('spawn types an explicit command into the registered PTY', () => {
    const { registry } = makeRegistry();
    const session = registry.spawn(
      { title: 'elanous', cwd: '/tmp', command: 'elanous --tui next' },
      { termCols: 100, termRows: 30 },
    );
    expect((session.preview as unknown as { writes: string[] }).writes).toEqual(['elanous --tui next\r']);
  });

  test('spawning a second session auto-detaches the first', () => {
    const { registry, events } = makeRegistry();
    const a = registry.spawn({ title: 'a', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    const b = registry.spawn({ title: 'b', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    expect(a.state).toBe('background');
    expect(b.state).toBe('foreground');
    expect(events.map(e => e.type)).toContain('detached');
  });

  test('detach disposes modal but keeps preview alive', () => {
    const { coord, registry } = makeRegistry();
    const s = registry.spawn({ title: 't', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    registry.detach(s.id);
    expect(s.state).toBe('background');
    expect(s.modal).toBeNull();
    expect(s.preview.isAlive).toBe(true);
    expect(coord.modalStack()).not.toContain(s.id);
  });

  test('attach re-wraps background session with fresh modal', () => {
    const { coord, registry, events } = makeRegistry();
    const s = registry.spawn({ title: 't', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    registry.detach(s.id);
    registry.attach(s.id, { termCols: 100, termRows: 30 });
    expect(s.state).toBe('foreground');
    expect(s.modal).not.toBeNull();
    expect(coord.modalStack()).toContain(s.id);
    const kinds = events.map(e => e.type);
    expect(kinds).toContain('attached');
  });

  test('attach auto-detaches current foreground', () => {
    const { registry } = makeRegistry();
    const a = registry.spawn({ title: 'a', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    const b = registry.spawn({ title: 'b', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    // b is now foreground, a is background. attach a.
    registry.attach(a.id, { termCols: 100, termRows: 30 });
    expect(a.state).toBe('foreground');
    expect(b.state).toBe('background');
  });

  test('kill stops preview + marks exited', () => {
    const { coord, registry } = makeRegistry();
    const s = registry.spawn({ title: 't', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    registry.kill(s.id);
    expect(s.state).toBe('exited');
    expect(s.preview.isAlive).toBe(false);
    expect(coord.modalStack()).not.toContain(s.id);
  });

  test('MAX_SESSIONS cap rejects further spawns', () => {
    const { registry } = makeRegistry();
    for (let i = 0; i < MAX_SESSIONS; i++) {
      registry.spawn({ title: `t${i}`, cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    }
    expect(registry.list().length).toBe(MAX_SESSIONS);
    expect(() => registry.spawn({ title: 'over', cwd: '/tmp' }, { termCols: 100, termRows: 30 }))
      .toThrow(/max/);
  });

  test('raiseAttention clamps level + stores notification', () => {
    const { registry, events } = makeRegistry();
    const s = registry.spawn({ title: 't', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    registry.raiseAttention(s.id, 2, { title: 'Permission', body: 'y/n?' });
    expect(s.attentionLevel).toBe(2);
    expect(s.lastNotification?.title).toBe('Permission');
    // Event emitted.
    const attn = events.find(e => e.type === 'attention');
    expect(attn).toBeDefined();
  });

  test('clearAttention resets to 0', () => {
    const { registry } = makeRegistry();
    const s = registry.spawn({ title: 't', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    registry.raiseAttention(s.id, 3);
    registry.clearAttention(s.id);
    expect(s.attentionLevel).toBe(0);
  });

  test('gc removes exited sessions only', () => {
    const { registry } = makeRegistry();
    const a = registry.spawn({ title: 'a', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    const b = registry.spawn({ title: 'b', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    registry.kill(a.id);
    expect(registry.list().length).toBe(2);
    registry.gc();
    expect(registry.list().length).toBe(1);
    expect(registry.get(b.id)).toBeDefined();
  });

  test('foreground()/backgrounded() accessors', () => {
    const { registry } = makeRegistry();
    const a = registry.spawn({ title: 'a', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    const b = registry.spawn({ title: 'b', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    expect(registry.foreground()?.id).toBe(b.id);
    expect(registry.backgrounded().map(s => s.id)).toEqual([a.id]);
  });

  test('subscribe + unsub', () => {
    const { registry } = makeRegistry();
    const seen: string[] = [];
    const unsub = registry.subscribe((ev) => seen.push(ev.type));
    registry.spawn({ title: 't', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    unsub();
    registry.spawn({ title: 't2', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    expect(seen).toEqual(['spawned']);
  });

  test('recent terminal-session-stop quick-pass kills the scoped session', () => {
    const { registry, signalBus, events } = makeRegistry();
    const s = registry.spawn({ title: 't', cwd: '/tmp' }, { termCols: 100, termRows: 30 });
    signalBus.emit({
      kind: 'terminal-session-stop',
      urgency: 'quick-pass',
      source: 'system',
      scope: { sessionId: s.id },
      mayPreempt: true,
    });
    expect(s.state).toBe('exited');
    expect(s.preview.isAlive).toBe(false);
    expect(events.map((ev) => ev.type)).toContain('killed');
  });
});
