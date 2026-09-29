// AgentRoomCompose returns an unsupported error; list and close retain their registry behavior.

import type { LLMToolSpec } from '../../llm.js';
import {
  getDefaultAgentRoomRegistry,
  type AgentRoomRegistry,
} from '../../agent-room/registry.js';
import {
  AGENT_ROOM_PRESET_NAMES,
  AGENT_ROOM_ROLE_HINTS,
  presetArityFor,
  isAgentRoomPresetName,
} from '../../agent-room/types.js';

// ─── AgentRoomCompose ────────────────────────────────────────────────

export interface AgentRoomComposeArgs {
  preset: string;
  members: readonly {
    brandRef: string;
    roleHint?: string;
    cwd?: string;
    extraArgs?: readonly string[];
    title?: string;
  }[];
  roomTitle?: string;
  focusIndex?: number;
}

export interface AgentRoomComposeMetadata {
  roomId: string;
  windowId: number;
  preset: string;
  members: ReadonlyArray<{
    sessionId: string;
    paneId: string;
    brand: string;
    roleHint?: string;
  }>;
  warnings: string[];
  budgetAdvisory: {
    currentUsagePercent: number;
    estimatedTurnMultiplier: number;
    warning?: string;
  };
}

export interface AgentRoomComposeResult {
  output: string;
  metadata: AgentRoomComposeMetadata;
  isError?: true;
}

export function buildAgentRoomComposeTool(): LLMToolSpec {
  return {
    name: 'AgentRoomCompose',
    description:
      'Unsupported: agent rooms need the removed rich TUI (virtual windows). ' +
      'AgentRoomCompose remains available by name but returns an error when called.',
    parameters: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          enum: [...AGENT_ROOM_PRESET_NAMES],
          description: 'Layout preset · arity = two-split(2), three-split(3), four-quad(4).',
        },
        members: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          description: 'Members array length MUST match preset arity.',
          items: {
            type: 'object',
            properties: {
              brandRef: {
                type: 'string',
                description: 'Literal brand (codex/claude/gemini/elanous), alias (cas/clc/gem/mac), "lll:<model>", or "auto".',
              },
              roleHint: {
                type: 'string',
                enum: [...AGENT_ROOM_ROLE_HINTS],
                description: 'Optional role for `auto` routing. Ignored for literal brands.',
              },
              cwd: { type: 'string' },
              extraArgs: { type: 'array', items: { type: 'string' } },
              title: { type: 'string' },
            },
            required: ['brandRef'],
            additionalProperties: false,
          },
        },
        roomTitle: {
          type: 'string',
          description: 'Room title (unsupported).',
        },
        focusIndex: {
          type: 'number',
          description: '0-based pane index (unsupported).',
        },
      },
      required: ['preset', 'members'],
      additionalProperties: false,
    },
  };
}

export async function dispatchAgentRoomCompose(
  rawArgs: Record<string, unknown>,
  _registry: AgentRoomRegistry = getDefaultAgentRoomRegistry(),
): Promise<AgentRoomComposeResult> {
  const preset = typeof rawArgs.preset === 'string' ? rawArgs.preset : '';
  if (!isAgentRoomPresetName(preset)) {
    return errorResult(
      `AgentRoomCompose: unknown preset '${preset}' · use one of ${AGENT_ROOM_PRESET_NAMES.join(', ')}`,
      preset,
    );
  }
  const rawMembers = Array.isArray(rawArgs.members) ? rawArgs.members : [];
  const arity = presetArityFor(preset);
  if (rawMembers.length !== arity) {
    return errorResult(
      `AgentRoomCompose: preset '${preset}' expects ${arity} members · got ${rawMembers.length}`,
      preset,
    );
  }
  for (let i = 0; i < rawMembers.length; i++) {
    const raw = rawMembers[i] as Record<string, unknown>;
    if (!raw || typeof raw.brandRef !== 'string' || !raw.brandRef.trim()) {
      return errorResult(`AgentRoomCompose: member[${i}].brandRef must be non-empty string`, preset);
    }
  }
  return errorResult('AgentRoomCompose: agent rooms need the removed rich TUI (virtual windows)', preset);
}

function errorResult(message: string, preset: string): AgentRoomComposeResult {
  return {
    output: message,
    metadata: {
      roomId: '',
      windowId: -1,
      preset,
      members: [],
      warnings: [],
      budgetAdvisory: {
        currentUsagePercent: 0,
        estimatedTurnMultiplier: 0,
      },
    },
    isError: true,
  };
}

// ─── AgentRoomList ───────────────────────────────────────────────────

export interface AgentRoomListResult {
  output: string;
  metadata: {
    rooms: ReadonlyArray<{
      id: string;
      windowId: number;
      preset: string;
      members: ReadonlyArray<{
        sessionId: string;
        paneId: string;
        brand: string;
        roleHint?: string;
      }>;
      createdAt: number;
    }>;
  };
  isError?: true;
}

export function buildAgentRoomListTool(): LLMToolSpec {
  return {
    name: 'AgentRoomList',
    description:
      'List live agent rooms with their member sessions. Read-only. ' +
      'Use before AgentRoomClose to discover room ids.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}

export async function dispatchAgentRoomList(
  _rawArgs: Record<string, unknown>,
  registry: AgentRoomRegistry = getDefaultAgentRoomRegistry(),
): Promise<AgentRoomListResult> {
  const rooms = registry.list();
  const lines: string[] = [];
  if (rooms.length === 0) {
    lines.push('AgentRoomList: no live rooms');
  } else {
    lines.push(`AgentRoomList: ${rooms.length} room(s)`);
    for (const r of rooms) {
      lines.push(`  ${r.id} · window ${r.windowId} · ${r.preset} · ${r.members.length} member(s)`);
    }
  }
  return {
    output: lines.join('\n'),
    metadata: {
      rooms: rooms.map((r) => ({
        id: r.id,
        windowId: r.windowId,
        preset: r.preset,
        members: r.members.map((m) => ({
          sessionId: m.sessionId,
          paneId: m.paneId,
          brand: m.brand,
          ...(m.roleHint ? { roleHint: m.roleHint } : {}),
        })),
        createdAt: r.createdAt,
      })),
    },
  };
}

// ─── AgentRoomClose ──────────────────────────────────────────────────

export interface AgentRoomCloseResult {
  output: string;
  metadata: {
    closed: boolean;
    disposedSessions: number;
    roomId: string;
  };
  isError?: true;
}

export function buildAgentRoomCloseTool(): LLMToolSpec {
  return {
    name: 'AgentRoomClose',
    description:
      'Close an existing agent room and dispose its member agents. ' +
      'Idempotent: a second call on the same id returns `closed: false` without error.',
    parameters: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Room id from AgentRoomList.' },
      },
      required: ['roomId'],
      additionalProperties: false,
    },
  };
}

export async function dispatchAgentRoomClose(
  rawArgs: Record<string, unknown>,
  registry: AgentRoomRegistry = getDefaultAgentRoomRegistry(),
): Promise<AgentRoomCloseResult> {
  const roomId = typeof rawArgs.roomId === 'string' ? rawArgs.roomId : '';
  if (!roomId.trim()) {
    return {
      output: 'AgentRoomClose: roomId required',
      metadata: { closed: false, disposedSessions: 0, roomId },
      isError: true,
    };
  }
  const result = await registry.dispose(roomId);
  return {
    output: result.closed
      ? `AgentRoomClose: ${roomId} closed · ${result.disposedSessions} session(s) disposed`
      : `AgentRoomClose: no room with id '${roomId}'`,
    metadata: {
      closed: result.closed,
      disposedSessions: result.disposedSessions,
      roomId,
    },
    // Not-found is NOT an error · idempotent no-op contract. LLM sees
    // `closed: false` and moves on.
  };
}

// ─── Bootstrap ───────────────────────────────────────────────────────

/** Bootstrap — no-op by design. Tools share the default registry
 *  singleton (`getDefaultAgentRoomRegistry`). Exists as a parity
 *  surface with `initPolicyRouter` / `initTtySnapshotTools` so the
 *  dashboard bootstrap sequence reads uniformly. */
export function initAgentRoomTools(): void {
  // Eager-touch the registry so the module is wired before the first
  // LLM invocation. No other work needed — dispatch functions lazily
  // resolve the registry when invoked.
  getDefaultAgentRoomRegistry();
}
