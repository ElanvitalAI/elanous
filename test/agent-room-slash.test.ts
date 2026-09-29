// H6 P4 · /agent-room slash handler tests.
//
// Scope: argument parsing, unsupported composition, and list/close
// against a synthetic registry. Room construction cannot spawn without
// the removed rich TUI; the slash returns that error to callers.

import { describe, test, expect, mock } from 'bun:test';
import {
  executeAgentRoomSlash,
  parseComposeTokens,
} from '../src/skills/tools/agent-room-slash.js';
import { AgentRoomRegistry } from '../src/agent-room/registry.js';
import type { AgentRoomInstance, AgentRoomSpec } from '../src/agent-room/types.js';

function seedRoom(registry: AgentRoomRegistry, id: string, windowId = 1): AgentRoomInstance {
  let disposed = false;
  const room: AgentRoomInstance = {
    id,
    windowId,
    preset: 'three-split',
    members: [
      { sessionId: 's0', paneId: 'p0', brand: 'codex', launchedAt: 1 },
      { sessionId: 's1', paneId: 'p1', brand: 'claude', launchedAt: 2 },
      { sessionId: 's2', paneId: 'p2', brand: 'gemini', launchedAt: 3 },
    ],
    createdAt: 1,
    dispose: async () => {
      disposed = true;
    },
  };
  registry.register(room);
  // Expose `disposed` via a side-channel so tests can assert it.
  (room as unknown as { _disposed: () => boolean })._disposed = () => disposed;
  return room;
}

describe('/agent-room help + unknown subcommand', () => {
  test('no args → help', async () => {
    const r = await executeAgentRoomSlash({ name: 'agent-room', args: [] });
    expect(r?.ok).toBe(true);
    expect(r?.logLines.some((l) => l.includes('/agent-room <N>'))).toBe(true);
  });

  test('`help` alias renders help text with example', async () => {
    const r = await executeAgentRoomSlash({ name: 'agent-room', args: ['help'] });
    expect(r?.ok).toBe(true);
    expect(r?.logLines.join('\n')).toMatch(/Example:/);
  });

  test('unknown subcommand · error with suggestion', async () => {
    const r = await executeAgentRoomSlash({ name: 'agent-room', args: ['nope'] });
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/unknown subcommand/);
  });

  test('returns null for mis-routed slash name', async () => {
    const r = await executeAgentRoomSlash({ name: 'route', args: [] });
    expect(r).toBeNull();
  });

  test('/showroom rejects malformed focus flag with showroom wording', async () => {
    const reg = new AgentRoomRegistry();
    const r = await executeAgentRoomSlash({ name: 'showroom', args: ['--focus', 'two'] }, reg);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/\/showroom: focus index must be an integer/);
  });

  test('/showroom help renders v2 lane composer copy', async () => {
    const r = await executeAgentRoomSlash({ name: 'showroom', args: ['help'] });
    expect(r?.ok).toBe(true);
    const text = r?.logLines.join('\n') ?? '';
    expect(text).toMatch(/multi-LLM lane composer/);
    expect(text).toMatch(/Lane token grammar/);
    expect(text).toMatch(/role:provider\[:transport\]/);
    expect(text).toMatch(/lll:<model>/);
  });

  test('valid /agent-room compose reports the removed rich TUI error', async () => {
    const registry = new AgentRoomRegistry();
    const r = await executeAgentRoomSlash({
      name: 'agent-room', args: ['2', 'codex', 'claude'],
    }, registry);
    expect(r?.ok).toBe(false);
    expect(r?.message).toBe('agent rooms need the removed rich TUI (virtual windows)');
    expect(registry.list()).toEqual([]);
  });

  test('/showroom with no args opens the default 2-pane showroom', async () => {
    const reg = new AgentRoomRegistry();
    const buildRoom = mock(async (spec: AgentRoomSpec) => ({
      room: {
        id: 'room-1',
        windowId: 42,
        preset: spec.preset,
        members: [
          { sessionId: 's-codex', paneId: 'pane-0', brand: 'codex', launchedAt: 1 },
          { sessionId: 's-claude', paneId: 'pane-1', brand: 'claude', launchedAt: 2 },
        ],
        createdAt: 1,
        dispose: async () => {},
      },
      resolvedBrands: [
        { brand: 'codex', resolution: 'literal' as const },
        { brand: 'claude', resolution: 'literal' as const },
      ],
      warnings: [],
    }));

    const r = await executeAgentRoomSlash(
      { name: 'showroom', args: [] },
      reg,
      { buildRoom },
    );

    expect(r?.ok).toBe(true);
    expect(r?.name).toBe('showroom');
    expect(r?.logLines[0]).toMatch(/showroom room-1 · window 42 · 2-pane ready/);
    expect(buildRoom).toHaveBeenCalledTimes(1);
    const spec = buildRoom.mock.calls[0]?.[0] as AgentRoomSpec;
    expect(spec.preset).toBe('two-split');
    expect(spec.layoutMode).toBe('single-vw');
    expect(spec.roomTitle).toBe('showroom');
    expect(spec.members).toEqual([
      { brandRef: 'codex', title: 'codex · auto' },
      { brandRef: 'claude', title: 'claude · auto' },
    ]);
  });
});

describe('/agent-room list', () => {
  test('empty registry · "no live agent rooms"', async () => {
    const reg = new AgentRoomRegistry();
    const r = await executeAgentRoomSlash({ name: 'agent-room', args: ['list'] }, reg);
    expect(r?.ok).toBe(true);
    expect(r?.logLines[0]).toMatch(/no live agent rooms/);
  });

  test('populated registry · shows each room + members', async () => {
    const reg = new AgentRoomRegistry();
    seedRoom(reg, 'room-1', 7);
    seedRoom(reg, 'room-2', 9);
    const r = await executeAgentRoomSlash({ name: 'agent-room', args: ['list'] }, reg);
    expect(r?.ok).toBe(true);
    const txt = r?.logLines.join('\n') ?? '';
    expect(txt).toMatch(/room-1/);
    expect(txt).toMatch(/room-2/);
    expect(txt).toMatch(/codex/);
    expect(txt).toMatch(/claude/);
  });
});

describe('/agent-room close', () => {
  test('missing id · usage error', async () => {
    const reg = new AgentRoomRegistry();
    const r = await executeAgentRoomSlash({ name: 'agent-room', args: ['close'] }, reg);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/roomId/);
  });

  test('unknown id · not-found error', async () => {
    const reg = new AgentRoomRegistry();
    const r = await executeAgentRoomSlash({ name: 'agent-room', args: ['close', 'ghost'] }, reg);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/no room with id/);
  });

  test('valid id · closes + reports member count', async () => {
    const reg = new AgentRoomRegistry();
    seedRoom(reg, 'room-1');
    const r = await executeAgentRoomSlash({ name: 'agent-room', args: ['close', 'room-1'] }, reg);
    expect(r?.ok).toBe(true);
    expect(r?.logLines[0]).toMatch(/closed room-1/);
    expect(reg.get('room-1')).toBeUndefined();
  });
});

describe('/agent-room compose arg parsing', () => {
  test('numeric N with no brands · usage error', async () => {
    const reg = new AgentRoomRegistry();
    const r = await executeAgentRoomSlash({ name: 'agent-room', args: ['3'] }, reg);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/got no brands/);
  });

  test('numeric N with wrong brand count · arity mismatch', async () => {
    const reg = new AgentRoomRegistry();
    const r = await executeAgentRoomSlash(
      { name: 'agent-room', args: ['3', 'codex', 'claude'] },
      reg,
    );
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/expected 3 brands/);
  });

  test('preset subcommand · unknown preset', async () => {
    const reg = new AgentRoomRegistry();
    const r = await executeAgentRoomSlash(
      { name: 'agent-room', args: ['preset', 'nine-split', 'a', 'b', 'c'] },
      reg,
    );
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/unknown preset/);
  });

  test('parseComposeTokens extracts trailing --focus index', () => {
    expect(parseComposeTokens(['codex', 'claude', 'gemini', '--focus', '2'], 3)).toEqual({
      brandTokens: ['codex', 'claude', 'gemini'],
      focusIndex: 2,
    });
  });

  test('parseComposeTokens rejects misplaced --focus', () => {
    expect(parseComposeTokens(['codex', '--focus', '2', 'gemini'], 3)).toEqual({
      brandTokens: [],
      error: '/agent-room: --focus <idx> must come after all 3 brand token(s)',
    });
  });

  test('parseComposeTokens rejects non-integer focus index', () => {
    expect(parseComposeTokens(['codex', 'claude', 'gemini', '--focus', 'two'], 3)).toEqual({
      brandTokens: [],
      error: "/agent-room: focus index must be an integer · got 'two'",
    });
  });
});
