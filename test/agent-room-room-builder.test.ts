import { describe, expect, test } from 'bun:test';
import { buildAgentRoom } from '../src/agent-room/room-builder.js';
import { AgentRoomRegistry } from '../src/agent-room/registry.js';
import type { AgentRoomSpec } from '../src/agent-room/types.js';

const spec: AgentRoomSpec = {
  preset: 'two-split',
  members: [{ brandRef: 'codex' }, { brandRef: 'claude' }],
  layoutMode: 'single-vw',
};

describe('buildAgentRoom · removed rich TUI', () => {
  test('fails without injected spawn functions or registering a room', async () => {
    const registry = new AgentRoomRegistry();
    await expect(buildAgentRoom(spec, { registry })).rejects.toThrow(
      'agent rooms need the removed rich TUI (virtual windows)',
    );
    expect(registry.list()).toEqual([]);
  });

  test('fails for ACP and PTY rooms alike', async () => {
    await expect(buildAgentRoom({ ...spec, members: [
      { brandRef: 'codex', transportPref: 'acp' },
      { brandRef: 'claude', transportPref: 'pty' },
    ] })).rejects.toThrow('agent rooms need the removed rich TUI (virtual windows)');
  });
});
