import { describe, expect, test } from 'bun:test';
import {
  createNextSidetabHostHandler, createReplNextSidetabTool, isNextSidetabCall, nextSidetabToolSpec,
  type SidetabRow,
} from './model.js';

const rows: SidetabRow[] = [
  { id: 'tui:one', label: 'one', kind: 'tui', badge: 'idle', sessionId: 'one' },
  { id: 'pty:shell', label: 'shell · Next TUI', kind: 'shell', badge: 'busy' },
];

describe('renderer-independent sidetab model and actions', () => {
  test('publishes the same bounded action contract without importing a renderer', () => {
    expect(nextSidetabToolSpec.name).toBe('NextSidetab');
    expect(nextSidetabToolSpec.parameters.properties.action.enum).toEqual(['list', 'switch', 'attach', 'detach', 'new', 'mission', 'kill']);
    expect(isNextSidetabCall({ type: 'elanous.sidetab.call', callId: 'one', request: { action: 'list' } })).toBe(true);
    expect(isNextSidetabCall({ type: 'bad', callId: 'one', request: { action: 'list' } })).toBe(false);
  });

  test('resolves exact and unique partial targets and keeps detach/new independent of row lookup', async () => {
    const calls: string[] = [];
    const handler = createNextSidetabHostHandler({
      rows: () => rows, selected: () => 1,
      switchSession: async (row) => { calls.push(`switch:${row.id}`); return { ok: true }; },
      attach: async (row) => { calls.push(`attach:${row.id}`); return { ok: true }; },
      detach: () => { calls.push('detach'); return { ok: true }; },
      spawn: (character) => ({ character }), kill: (row) => ({ killed: row.id }),
    });
    expect(await handler({ action: 'list' })).toEqual(rows);
    expect(await handler({ action: 'switch', target: 'tui:one' })).toEqual({ ok: true });
    expect(await handler({ action: 'attach', target: 'shell' })).toEqual({ ok: true });
    expect(await handler({ action: 'detach' })).toEqual({ ok: true });
    expect(await handler({ action: 'new', character: 'elanous' })).toEqual({ character: 'elanous' });
    expect(calls).toEqual(['switch:tui:one', 'attach:pty:shell', 'detach']);
  });

  test('requires explicit kill confirmation and refuses the current TUI', async () => {
    let kills = 0;
    const handler = createNextSidetabHostHandler({
      rows: () => rows, selected: () => 1,
      switchSession: async () => ({}), attach: async () => ({}), detach: () => ({}),
      spawn: () => ({}), kill: () => { kills++; return { ok: true }; },
    });
    expect(await handler({ action: 'kill', target: 'shell' })).toMatchObject({ needsConfirmation: true });
    expect(await handler({ action: 'kill', target: 'shell', confirm: true })).toEqual({ ok: true });
    expect(kills).toBe(1);

    const currentHandler = createNextSidetabHostHandler({
      rows: () => [{ ...rows[0]!, currentProcess: true }], selected: () => 0,
      switchSession: async () => ({}), attach: async () => ({}), detach: () => ({}),
      spawn: () => ({}), kill: () => { kills++; return { ok: true }; },
    });
    expect(await currentHandler({ action: 'kill', target: 'tui:one', confirm: true })).toEqual({
      error: '현재 TUI 세션은 사이드탭에서 종료할 수 없습니다',
    });
    expect(kills).toBe(1);
  });

  test('gives visible missions enough IPC time to complete', async () => {
    const tool = createReplNextSidetabTool({ send: () => true, on: () => {} }, { ELANOUS_NEXT_TUI_SIDETAB_IPC: '1' }, 5, 35)!;
    const started = Date.now();
    const result = await tool.dispatch({ action: 'mission', agent: 'codex', mission: 'create a demo note' });
    expect(result).toEqual({ error: 'Next TUI did not answer the side-tab request' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});

test('routes a mission through the visible Codex sidetab runner and requires mission text', async () => {
  const missions: string[] = [];
  const handler = createNextSidetabHostHandler({
    rows: () => rows, selected: () => 0,
    switchSession: async () => ({}), attach: async () => ({}), detach: () => ({}),
    spawn: () => ({}), kill: () => ({}),
    runMission: async (agent, mission) => { missions.push(`${agent}:${mission}`); return { ok: true, path: '/tmp/result.md', firstLine: '# done' }; },
  });
  expect(await handler({ action: 'mission', mission: '  Write a note.  ' })).toEqual({
    ok: true, path: '/tmp/result.md', firstLine: '# done',
  });
  expect(await handler({ action: 'mission', agent: 'claude', mission: 'Review the note.' })).toMatchObject({ ok: true });
  expect(await handler({ action: 'mission', agent: 'gemini' as never, mission: 'Review the note.' })).toEqual({ error: 'agent는 codex 또는 claude여야 합니다' });
  expect(await handler({ action: 'mission' })).toEqual({ error: 'mission 텍스트가 필요합니다' });
  expect(missions).toEqual(['codex:Write a note.', 'claude:Review the note.']);
});
