// Showroom v2 Arc 2 · transportPref + brand compat tests.
//
// Covers:
//   - validateAgentRoomSpec enum check on member.transportPref
//   - checkTransportCompat compat-table cells (drop · warning · pass-through)
//   - composeFromLanes pipes lane.transportPref into member.transportPref
//   - room-builder rejects room launches for every transport preference

import { describe, test, expect, mock } from 'bun:test';
import { validateAgentRoomSpec } from '../src/agent-room/types.js';
import {
  checkTransportCompat,
  getLaneMatrixForBrand,
  LANE_MATRIX_BY_BRAND,
  resolveLaneKind,
} from '../src/agent-room/transport-compat.js';
import { executeAgentRoomSlash } from '../src/skills/tools/agent-room-slash.js';
import { AgentRoomRegistry } from '../src/agent-room/registry.js';
import type { AgentRoomSpec } from '../src/agent-room/types.js';
import { buildAgentRoom } from '../src/agent-room/room-builder.js';

// ─── validateAgentRoomSpec · enum ─────────────────────────────────

describe('validateAgentRoomSpec · transportPref enum', () => {
  test('undefined transportPref is fine', () => {
    expect(() => validateAgentRoomSpec({
      preset: 'two-split',
      members: [{ brandRef: 'codex' }, { brandRef: 'claude' }],
    })).not.toThrow();
  });

  test('valid pref pty', () => {
    expect(() => validateAgentRoomSpec({
      preset: 'two-split',
      members: [{ brandRef: 'codex', transportPref: 'pty' }, { brandRef: 'claude' }],
    })).not.toThrow();
  });

  test('valid pref acp', () => {
    expect(() => validateAgentRoomSpec({
      preset: 'two-split',
      members: [{ brandRef: 'elanous', transportPref: 'acp' }, { brandRef: 'claude' }],
    })).not.toThrow();
  });

  test('valid pref auto', () => {
    expect(() => validateAgentRoomSpec({
      preset: 'two-split',
      members: [{ brandRef: 'codex', transportPref: 'auto' }, { brandRef: 'claude' }],
    })).not.toThrow();
  });

  test('invalid enum throws', () => {
    expect(() => validateAgentRoomSpec({
      preset: 'two-split',
      members: [
        { brandRef: 'codex', transportPref: 'rest' as never },
        { brandRef: 'claude' },
      ],
    })).toThrow(/transportPref invalid/);
  });
});

// ─── checkTransportCompat · compat-table ──────────────────────────

describe('checkTransportCompat · ACP-only brands (elanous)', () => {
  test('elanous + pty → drop with warning', () => {
    const r = checkTransportCompat('elanous', 'pty');
    expect(r.effective).toBeUndefined();
    expect(r.warning).toMatch(/no PTY adapter/);
  });

  test('elanous + acp → pass through', () => {
    const r = checkTransportCompat('elanous', 'acp');
    expect(r.effective).toBe('acp');
    expect(r.warning).toBeUndefined();
  });

  test('elanous + auto/undefined → no hint', () => {
    expect(checkTransportCompat('elanous', 'auto').effective).toBeUndefined();
    expect(checkTransportCompat('elanous', undefined).effective).toBeUndefined();
  });
});

describe('checkTransportCompat · PTY-only embodied brands (codex/claude/gemini)', () => {
  test('codex + acp → drop with warning', () => {
    const r = checkTransportCompat('codex', 'acp');
    expect(r.effective).toBeUndefined();
    expect(r.warning).toMatch(/no ACP-embodied adapter yet/);
  });

  test('claude + acp → drop', () => {
    const r = checkTransportCompat('claude', 'acp');
    expect(r.effective).toBeUndefined();
    expect(r.warning).toMatch(/no ACP-embodied adapter/);
  });

  test('gemini + acp → drop', () => {
    const r = checkTransportCompat('gemini', 'acp');
    expect(r.effective).toBeUndefined();
  });

  test('codex + pty → pass through', () => {
    const r = checkTransportCompat('codex', 'pty');
    expect(r.effective).toBe('pty');
    expect(r.warning).toBeUndefined();
  });
});

describe('checkTransportCompat · local-llm', () => {
  test('local-llm + acp → drop with local-llm-specific reason', () => {
    const r = checkTransportCompat('local-llm', 'acp');
    expect(r.effective).toBeUndefined();
    expect(r.warning).toMatch(/local LLM is PTY only/);
  });

  test('lll:llama3 + acp → drop', () => {
    const r = checkTransportCompat('lll:llama3', 'acp');
    expect(r.effective).toBeUndefined();
    expect(r.warning).toMatch(/local LLM is PTY only/);
  });

  test('lll:llama3 + pty → pass through', () => {
    const r = checkTransportCompat('lll:llama3', 'pty');
    expect(r.effective).toBe('pty');
  });
});

describe('checkTransportCompat · unknown brand', () => {
  test('unknown brand pass-through', () => {
    const r = checkTransportCompat('mystery', 'acp');
    expect(r.effective).toBe('acp');
    expect(r.warning).toBeUndefined();
  });
});

// ─── buildAgentRoom refuses all transport combinations ──────────────

describe('buildAgentRoom · unsupported transport preferences', () => {
  for (const transportPref of ['pty', 'acp', 'auto'] as const) {
    test(`refuses ${transportPref} without launching a room`, async () => {
      const registry = new AgentRoomRegistry();
      await expect(buildAgentRoom({
        preset: 'two-split',
        members: [{ brandRef: 'codex', transportPref }, { brandRef: 'claude' }],
        layoutMode: 'single-vw',
      }, { registry })).rejects.toThrow('agent rooms need the removed rich TUI (virtual windows)');
      expect(registry.list()).toEqual([]);
    });
  }
});

// ─── composeFromLanes · transportPref pipe ────────────────────────

describe('composeFromLanes · transportPref pipe', () => {
  function fakeBuildRoom(memberCount: number) {
    return mock(async (spec: AgentRoomSpec) => ({
      room: {
        id: 'room-test',
        windowId: 1,
        preset: spec.preset,
        members: Array.from({ length: memberCount }, (_, i) => ({
          sessionId: `s-${i}`,
          paneId: `p-${i}`,
          brand: spec.members[i]?.brandRef ?? 'unknown',
          launchedAt: i,
        })),
        createdAt: 0,
        dispose: async () => {},
      },
      resolvedBrands: spec.members.map((m) => ({
        brand: m.brandRef,
        resolution: 'literal' as const,
      })),
      warnings: [],
    }));
  }

  test('explicit pty → member.transportPref=pty', async () => {
    const reg = new AgentRoomRegistry();
    const buildRoom = fakeBuildRoom(2);
    await executeAgentRoomSlash(
      { name: 'showroom', args: ['claude:pty', 'codex:acp'] },
      reg, { buildRoom },
    );
    const spec = buildRoom.mock.calls[0]?.[0] as AgentRoomSpec;
    expect(spec.members[0]?.transportPref).toBe('pty');
    expect(spec.members[1]?.transportPref).toBe('acp');
  });

  test('explicit auto → member.transportPref undefined (drop bare auto)', async () => {
    const reg = new AgentRoomRegistry();
    const buildRoom = fakeBuildRoom(2);
    await executeAgentRoomSlash(
      { name: 'showroom', args: ['claude:auto', 'codex:auto'] },
      reg, { buildRoom },
    );
    const spec = buildRoom.mock.calls[0]?.[0] as AgentRoomSpec;
    expect(spec.members[0]?.transportPref).toBeUndefined();
    expect(spec.members[1]?.transportPref).toBeUndefined();
  });

  test('no transport segment → member.transportPref undefined', async () => {
    const reg = new AgentRoomRegistry();
    const buildRoom = fakeBuildRoom(2);
    await executeAgentRoomSlash(
      { name: 'showroom', args: ['claude', 'codex'] },
      reg, { buildRoom },
    );
    const spec = buildRoom.mock.calls[0]?.[0] as AgentRoomSpec;
    expect(spec.members[0]?.transportPref).toBeUndefined();
  });

  test('local-llm with explicit pty pipes through', async () => {
    const reg = new AgentRoomRegistry();
    const buildRoom = fakeBuildRoom(2);
    await executeAgentRoomSlash(
      { name: 'showroom', args: ['build:lll:llama3:pty', 'review:gemini'] },
      reg, { buildRoom },
    );
    const spec = buildRoom.mock.calls[0]?.[0] as AgentRoomSpec;
    expect(spec.members[0]?.brandRef).toBe('lll:llama3');
    expect(spec.members[0]?.transportPref).toBe('pty');
  });
});

// ─── PR-CL6 (C.2 · 2026-04-29) — Lane matrix exposure ─────────────────
//
// Verifies that LANE_MATRIX_BY_BRAND advertises the correct defaults,
// getLaneMatrixForBrand handles aliases / lll:<model> / unknown brand,
// and resolveLaneKind narrows a user transportPref to the brand's
// supported set.

describe('LANE_MATRIX_BY_BRAND', () => {
  test('contains an entry for every recognized brand', () => {
    expect(Object.keys(LANE_MATRIX_BY_BRAND).sort()).toEqual([
      'claude', 'codex', 'elanous', 'gemini', 'local-llm',
    ]);
  });

  test('codex defaults to acp + supports pty acp hybrid', () => {
    const e = LANE_MATRIX_BY_BRAND.codex!;
    expect(e.defaultLane).toBe('acp');
    expect(e.supported).toEqual(['pty', 'acp', 'hybrid']);
  });

  test('claude is pty-only', () => {
    const e = LANE_MATRIX_BY_BRAND.claude!;
    expect(e.defaultLane).toBe('pty');
    expect(e.supported).toEqual(['pty']);
  });

  test('elanous is acp-only', () => {
    const e = LANE_MATRIX_BY_BRAND.elanous!;
    expect(e.defaultLane).toBe('acp');
    expect(e.supported).toEqual(['acp']);
  });
});

describe('getLaneMatrixForBrand', () => {
  test('canonical brand → entry', () => {
    expect(getLaneMatrixForBrand('codex')?.defaultLane).toBe('acp');
  });

  test('case-insensitive lookup', () => {
    expect(getLaneMatrixForBrand('CLAUDE')?.defaultLane).toBe('pty');
  });

  test('lll:<model> maps to local-llm entry', () => {
    expect(getLaneMatrixForBrand('lll:qwen-32b')?.defaultLane).toBe('pty');
  });

  test('unknown brand → null', () => {
    expect(getLaneMatrixForBrand('not-a-real-brand')).toBeNull();
  });
});

describe('resolveLaneKind', () => {
  test('no pref → defaultLane', () => {
    expect(resolveLaneKind('codex', undefined)).toBe('acp');
    expect(resolveLaneKind('claude', undefined)).toBe('pty');
  });

  test('auto pref → defaultLane', () => {
    expect(resolveLaneKind('codex', 'auto')).toBe('acp');
  });

  test('explicit pref narrows to supported', () => {
    expect(resolveLaneKind('codex', 'pty')).toBe('pty');
    expect(resolveLaneKind('codex', 'acp')).toBe('acp');
  });

  test('unsupported pref drops to defaultLane', () => {
    // claude has no acp adapter; user request narrows back to pty.
    expect(resolveLaneKind('claude', 'acp')).toBe('pty');
  });

  test('unknown brand → null', () => {
    expect(resolveLaneKind('mystery-brand', 'pty')).toBeNull();
  });
});
