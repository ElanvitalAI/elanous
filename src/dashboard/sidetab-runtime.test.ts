import { expect, test } from 'bun:test';
import type { ModalSurface } from '../display/modal-stack.js';
import type { Key } from '../tui.js';
import { createDashboardSidetabRuntime } from './sidetab-runtime.js';
import type { SidetabRow } from '../sidetab-core/model.js';

const key = (name: string, ctrl = false): Key => ({ name, ctrl, shift: false, raw: name });
const event = (name: string) => ({ name, ctrl: false, shift: false, alt: false, sequence: name });

function fixture(rows: SidetabRow[]) {
  const surfaces: ModalSurface[] = [];
  const attached: SidetabRow[] = [];
  const detached: (SidetabRow | null)[] = [];
  const killed: SidetabRow[] = [];
  const statuses: string[] = [];
  let disposed = 0;
  let spawned = 0;
  let returned = 0;
  const runtime = createDashboardSidetabRuntime({
    currentSessionId: () => 'chat-session',
    termSize: () => ({ cols: 100, rows: 30 }),
    loadRows: () => rows,
    pushModal: (surface) => {
      surfaces.push(surface);
      return { dispose: () => { disposed++; } };
    },
    attach: (row) => { attached.push(row); },
    spawnShell: () => { spawned++; },
    detach: (row) => { detached.push(row); },
    kill: (row) => { killed.push(row); },
    returnToParent: () => { returned++; },
    status: (message) => { statuses.push(message); },
  });
  return { runtime, surfaces, attached, detached, killed, statuses, get disposed() { return disposed; }, get spawned() { return spawned; }, get returned() { return returned; } };
}

const sampleRows: SidetabRow[] = [
  { id: 'tui:1', label: 'current', kind: 'tui', badge: 'idle', sessionId: 'chat-session', currentProcess: true },
  { id: 'shell:2', label: 'child shell', kind: 'shell', badge: 'idle', sessionId: 'terminal-2', ptyId: 'shell:2' },
];

test('Ctrl+\\ prefix opens the current-session sidetab panel and Enter selects a child', () => {
  const f = fixture(sampleRows);
  expect(f.runtime.routeKey(key('\\', true))).toBe(true);
  expect(f.runtime.routeKey(key('s'))).toBe(true);
  expect(f.surfaces).toHaveLength(1);
  f.surfaces[0]!.onKey?.(event('down'));
  f.surfaces[0]!.onKey?.(event('return'));
  expect(f.attached).toEqual([sampleRows[1]]);
});

test('Ctrl+backslash protocol alias opens the sidetab panel too', () => {
  const f = fixture(sampleRows);
  expect(f.runtime.routeKey(key('backslash', true))).toBe(true);
  expect(f.runtime.routeKey(key('s'))).toBe(true);
  expect(f.surfaces).toHaveLength(1);
});

test('SIGQUIT integration starts the same prefix state as the parsed key path', () => {
  const f = fixture(sampleRows);
  f.runtime.beginPrefix();
  expect(f.runtime.routeKey(key('s'))).toBe(true);
  expect(f.surfaces).toHaveLength(1);
  expect(f.statuses[0]).toContain('키 대기');
});

test('starting a prefix closes an open panel and duplicate SIGQUIT delivery is idempotent', () => {
  const f = fixture(sampleRows);
  f.runtime.routeKey(key('\\', true));
  f.runtime.routeKey(key('s'));
  f.statuses.length = 0;
  f.runtime.beginPrefix();
  f.runtime.beginPrefix();
  expect(f.disposed).toBe(1);
  expect(f.statuses.filter((message) => message.includes('키 대기'))).toHaveLength(1);
  expect(f.runtime.routeKey(key('n'))).toBe(true);
  expect(f.spawned).toBe(1);
});

test('prefix number attaches directly; p/Esc return to the parent', () => {
  const f = fixture(sampleRows);
  f.runtime.routeKey(key('\\', true));
  f.runtime.routeKey(key('2'));
  expect(f.attached).toEqual([sampleRows[1]]);
  f.runtime.routeKey(key('\\', true));
  f.runtime.routeKey(key('p'));
  f.runtime.routeKey(key('\\', true));
  f.runtime.routeKey(key('escape'));
  expect(f.returned).toBe(2);
});

test('panel actions spawn, detach, and require explicit selection before killing', () => {
  const f = fixture(sampleRows);
  f.runtime.routeKey(key('\\', true));
  f.runtime.routeKey(key('s'));
  const panel = f.surfaces[0]!;
  panel.onKey?.(event('n'));
  expect(f.spawned).toBe(1);

  f.runtime.routeKey(key('\\', true));
  f.runtime.routeKey(key('s'));
  const secondPanel = f.surfaces[1]!;
  secondPanel.onKey?.(event('down'));
  secondPanel.onKey?.(event('d'));
  expect(f.detached).toEqual([sampleRows[1]]);

  f.runtime.routeKey(key('\\', true));
  f.runtime.routeKey(key('s'));
  const thirdPanel = f.surfaces[2]!;
  thirdPanel.onKey?.(event('down'));
  thirdPanel.onKey?.(event('k'));
  expect(f.killed).toEqual([]);
  const confirm = f.surfaces[3]!;
  confirm.onKey?.(event('down'));
  confirm.onKey?.(event('return'));
  expect(f.killed).toEqual([sampleRows[1]]);
});

test('current TUI row cannot be killed', () => {
  const f = fixture(sampleRows);
  f.runtime.routeKey(key('\\', true));
  f.runtime.routeKey(key('s'));
  f.surfaces[0]!.onKey?.(event('k'));
  expect(f.surfaces).toHaveLength(1);
  expect(f.killed).toEqual([]);
  expect(f.statuses.at(-1)).toContain('종료할 수 없습니다');
});

test('runtime close disposes an open sidetab modal and clears pending prefix state', () => {
  const f = fixture(sampleRows);
  f.runtime.routeKey(key('\\', true));
  f.runtime.routeKey(key('s'));
  f.runtime.close();
  expect(f.disposed).toBe(1);
  expect(f.runtime.routeKey(key('n'))).toBe(false);
});
