// H6 P4 · AgentRoom* LLM tool dispatcher tests.
//
// Covers input validation + read-only paths (List/Close). Happy-path
// compose is exercised in room-builder tests (stubbed spawn). Here we
// focus on the LLM-tool contract: structured metadata + isError flag
// + idempotent close.

import { describe, test, expect } from 'bun:test';
import {
  dispatchAgentRoomCompose,
  dispatchAgentRoomList,
  dispatchAgentRoomClose,
  buildAgentRoomComposeTool,
  buildAgentRoomListTool,
  buildAgentRoomCloseTool,
  initAgentRoomTools,
} from '../src/skills/tools/agent-room.js';
import { AgentRoomRegistry } from '../src/agent-room/registry.js';
import type { AgentRoomInstance } from '../src/agent-room/types.js';

function seedRoom(registry: AgentRoomRegistry, id: string, windowId = 1): void {
  const room: AgentRoomInstance = {
    id,
    windowId,
    preset: 'three-split',
    members: [
      { sessionId: 's0', paneId: 'p0', brand: 'codex', roleHint: 'plan', launchedAt: 1 },
      { sessionId: 's1', paneId: 'p1', brand: 'claude', launchedAt: 2 },
      { sessionId: 's2', paneId: 'p2', brand: 'gemini', launchedAt: 3 },
    ],
    createdAt: 1,
    dispose: async () => {},
  };
  registry.register(room);
}

describe('AgentRoomCompose · input validation', () => {
  test('unknown preset · isError with message', async () => {
    const reg = new AgentRoomRegistry();
    const r = await dispatchAgentRoomCompose(
      {
        preset: 'nine-split',
        members: [{ brandRef: 'codex' }, { brandRef: 'claude' }],
      },
      reg,
    );
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/unknown preset/);
  });

  test('arity mismatch · isError', async () => {
    const reg = new AgentRoomRegistry();
    const r = await dispatchAgentRoomCompose(
      {
        preset: 'three-split',
        members: [{ brandRef: 'codex' }, { brandRef: 'claude' }],
      },
      reg,
    );
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/expects 3 members/);
  });

  test('member with empty brandRef · isError', async () => {
    const reg = new AgentRoomRegistry();
    const r = await dispatchAgentRoomCompose(
      {
        preset: 'two-split',
        members: [{ brandRef: 'codex' }, { brandRef: '' }],
      },
      reg,
    );
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/brandRef/);
  });

  test('error path metadata shape is still stable', async () => {
    const reg = new AgentRoomRegistry();
    const r = await dispatchAgentRoomCompose({ preset: 'bogus', members: [] }, reg);
    expect(r.metadata.roomId).toBe('');
    expect(r.metadata.members).toEqual([]);
    expect(r.metadata.budgetAdvisory.estimatedTurnMultiplier).toBe(0);
  });
});

describe('AgentRoomList', () => {
  test('empty registry · structured empty list', async () => {
    const reg = new AgentRoomRegistry();
    const r = await dispatchAgentRoomList({}, reg);
    expect(r.metadata.rooms).toEqual([]);
    expect(r.output).toMatch(/no live rooms/);
  });

  test('populated · members include roleHint when set', async () => {
    const reg = new AgentRoomRegistry();
    seedRoom(reg, 'room-1', 5);
    const r = await dispatchAgentRoomList({}, reg);
    expect(r.metadata.rooms).toHaveLength(1);
    expect(r.metadata.rooms[0]!.members[0]!.roleHint).toBe('plan');
    expect(r.metadata.rooms[0]!.members[1]!.roleHint).toBeUndefined();
  });
});

describe('AgentRoomClose · idempotent contract', () => {
  test('missing roomId · isError (schema violation)', async () => {
    const reg = new AgentRoomRegistry();
    const r = await dispatchAgentRoomClose({}, reg);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/roomId required/);
  });

  test('unknown roomId · NOT an error · closed=false', async () => {
    const reg = new AgentRoomRegistry();
    const r = await dispatchAgentRoomClose({ roomId: 'ghost' }, reg);
    expect(r.isError).toBeUndefined();
    expect(r.metadata.closed).toBe(false);
    expect(r.metadata.disposedSessions).toBe(0);
  });

  test('valid roomId · closed=true · disposedSessions reports pre-close count', async () => {
    const reg = new AgentRoomRegistry();
    seedRoom(reg, 'room-1');
    const r = await dispatchAgentRoomClose({ roomId: 'room-1' }, reg);
    expect(r.metadata.closed).toBe(true);
    expect(r.metadata.disposedSessions).toBe(3);
  });
});

describe('tool spec shapes', () => {
  test('buildAgentRoomComposeTool · schema gates preset enum + members arity', () => {
    const spec = buildAgentRoomComposeTool();
    expect(spec.name).toBe('AgentRoomCompose');
    const presetEnum = (spec.parameters.properties as any).preset?.enum as string[];
    expect(presetEnum).toContain('three-split');
    const membersMax = (spec.parameters.properties as any).members?.maxItems;
    expect(membersMax).toBe(4);
    expect(spec.description).toContain('Unsupported: agent rooms need the removed rich TUI');
  });

  test('valid compose returns the removed rich TUI error without spawning', async () => {
    const reg = new AgentRoomRegistry();
    const result = await dispatchAgentRoomCompose({
      preset: 'two-split',
      members: [{ brandRef: 'codex' }, { brandRef: 'claude' }],
    }, reg);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('agent rooms need the removed rich TUI (virtual windows)');
    expect(reg.list()).toEqual([]);
  });
});

describe('initAgentRoomTools', () => {
  test('bootstrap is idempotent · no throw on re-call', () => {
    expect(() => {
      initAgentRoomTools();
      initAgentRoomTools();
    }).not.toThrow();
    // Also touch the list + close specs to make sure they're valid.
    expect(buildAgentRoomListTool().name).toBe('AgentRoomList');
    expect(buildAgentRoomCloseTool().name).toBe('AgentRoomClose');
  });
});
