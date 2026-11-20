import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { elnToggleHandoff, type ToggleHandoffDeps } from './els-handoff.js';

function run(over: Partial<ToggleHandoffDeps> & { made?: number; live?: boolean }) {
  const calls: string[] = [];
  const deps: ToggleHandoffDeps = {
    env: {}, sessionId: 's-1', cwd: '/work/proj', busy: false,
    serverLive: async () => { calls.push('live?'); return over.live ?? true; },
    request: async (req) => { calls.push(`new ${req.ws} ${req.command.join(' ')}`); return { exitCode: over.made ?? 0, message: over.made ? 'boom' : 'ok' }; },
    armOuter: () => { calls.push('arm'); return true; },
    ...over,
  };
  return { calls, result: elnToggleHandoff(deps) };
}

test('bare eln + live server: the session goes to a pane (same id), the outer frame is armed, eln exits', async () => {
  const r = run({});
  expect(await r.result).toEqual({ kind: 'exit', message: 'els: 세션 s-1 을 패널로 옮겼습니다' });
  expect(r.calls).toEqual(['live?', 'new proj eln --resume s-1', 'arm']);
});

test('inside an els pane the toggle stays local and nothing is asked of the server', async () => {
  const r = run({ env: { ELANOUS_ELS_PANE: 'p1' } });
  expect(await r.result).toEqual({ kind: 'local' });
  expect(r.calls).toEqual([]);
});

test('no live server, or a running turn: local, no pane made', async () => {
  const none = run({ live: false });
  expect(await none.result).toEqual({ kind: 'local' });
  expect(none.calls).toEqual(['live?']);
  const busy = run({ busy: true });
  expect(await busy.result).toEqual({ kind: 'local' });
  expect(busy.calls).toEqual([]);
});

test('failed pane / throwing server: local with the reason, outer never armed, session kept', async () => {
  const failed = run({ made: 1 });
  const f = await failed.result;
  expect(f.kind).toBe('local');
  expect(failed.calls).not.toContain('arm');
  const thrown = await elnToggleHandoff({ env: {}, sessionId: 's', cwd: '/w', busy: false, serverLive: async () => true, request: async () => { throw new Error('socket gone'); }, armOuter: () => true });
  expect(thrown).toEqual({ kind: 'local', message: 'els: socket gone' });
  expect(await elnToggleHandoff({ env: {}, sessionId: 's', cwd: '/w', busy: false, serverLive: async () => { throw new Error('x'); }, request: async () => ({ exitCode: 0, message: '' }), armOuter: () => true })).toEqual({ kind: 'local' });
});

test('wiring: entry.ts toggleSidetab calls the hand-off before opening, and runs the outer els only after the TUI closed', () => {
  const src = readFileSync(join(import.meta.dir, 'entry.ts'), 'utf8');
  expect(src).toContain("elnToggleHandoff");
  expect(src.indexOf('elnToggleHandoff')).toBeLessThan(src.indexOf('사이드탭은 터미널 폭 34칸'));
  expect(src.indexOf('closeTui();\n  }\n  if (handoffExit && outerElsArmed)')).toBeGreaterThan(0);
});
