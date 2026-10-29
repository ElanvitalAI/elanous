import { describe, expect, test } from 'bun:test';
import {
  createNextSidetabHostHandler, isNextSidetabCall, nextSidetabToolSpec,
  type SidetabRow,
} from './model.js';

const rows: SidetabRow[] = [
  { id: 'tui:one', label: 'one', kind: 'tui', badge: 'idle', sessionId: 'one' },
  { id: 'pty:shell', label: 'shell · Next TUI', kind: 'shell', badge: 'busy' },
];

describe('renderer-independent sidetab model and actions', () => {
  test('publishes the same bounded action contract without importing a renderer', () => {
    expect(nextSidetabToolSpec.name).toBe('NextSidetab');
    expect(nextSidetabToolSpec.parameters.properties.action.enum).toEqual(['list', 'switch', 'attach', 'detach', 'new', 'kill']);
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
});
