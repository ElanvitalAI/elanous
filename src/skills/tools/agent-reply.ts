import type { LLMToolSpec } from '../../llm/tool-spec.js';
// H6 P5 · AgentReply LLM tool.
//
// Complements `AgentHandoff` (H5 P3): where handoff launches a fresh
// target session with a source snapshot, AgentReply talks to an
// already-live session and captures the reply. Use for plan → exec →
// review cycles inside an agent-room (H6 P4) or any workflow where
// the source needs an answer BEFORE continuing its own turn.
//
// Output contract matches the rest of the H6 tool family:
//   `{ output: string; metadata: object; isError?: true }`.
// Timeouts are NOT errors — they return partial content + a
// `'timeout-truncated'` warning so the LLM can adapt.


import { debug } from '../../debug/log.js';
import {
  findLiveSessionById,
} from '../../agent/spawn-embodied-agent-in-vw.js';
import { findSessionObserver } from '../../agent/observer-registry.js';
import { defaultAgentGraph } from '../../agent/agent-graph.js';
import {
  sendReply,
  ReplyCycleExceededError,
  USER_GHOST_SESSION_ID,
  type ReplyDeps,
  type ReplyOpts,
} from '../../agent/reply.js';

export interface AgentReplyArgs {
  toSessionId: string;
  message: string;
  fromSessionId?: string;
  includeChannels?: string[];
  idleMs?: number;
  timeoutMs?: number;
}

export interface AgentReplyMetadata {
  fromSessionId: string | null;
  toSessionId: string;
  replyText: string;
  channels: Readonly<Record<string, string>>;
  elapsedMs: number;
  cycleDepth: number;
  warnings: string[];
}

export interface AgentReplyResult {
  output: string;
  metadata: AgentReplyMetadata;
  isError?: true;
}

export function buildAgentReplyTool(): LLMToolSpec {
  return {
    name: 'AgentReply',
    description:
      'Send a message to a live embodied agent session and capture its reply. ' +
      'Complements AgentHandoff (which launches a NEW target); AgentReply talks ' +
      'to an already-alive session identified by `toSessionId` (use AgentRoomList ' +
      'or /acp-vw output to find the id). The call blocks until the target idles ' +
      '(no new bytes for `idleMs`, default 2000) or `timeoutMs` (default 30000) ' +
      'fires. Timeouts are NOT errors — they return partial content + ' +
      '`warnings: ["timeout-truncated"]`. Default channel filter = ["message"]; ' +
      'pass empty array to receive every channel. Cycle depth cap = 8 (counted ' +
      'across inbound reply edges) prevents runaway loops; exceeding it throws.',
    parameters: {
      type: 'object',
      properties: {
        toSessionId: {
          type: 'string',
          description: 'Target embodied session id (must be alive + have a PTY transport).',
        },
        message: {
          type: 'string',
          description: 'The message body to send to the target. A trailing newline is added if absent.',
        },
        fromSessionId: {
          type: 'string',
          description: 'Optional · source session id for graph edge + cycle counting. Omit when the user initiates directly.',
        },
        includeChannels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Channel tags to include in the reply. Default = ["message"]. Empty array = everything.',
        },
        idleMs: {
          type: 'number',
          description: 'No-new-output duration that ends the wait. Default 2000.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Hard cap on the wait. Default 30000.',
        },
      },
      required: ['toSessionId', 'message'],
      additionalProperties: false,
    },
  };
}

function defaultDeps(): ReplyDeps {
  return {
    lookup: {
      findSession: (id) => {
        const e = findLiveSessionById(id);
        return e?.session;
      },
    },
    observerLookup: (id) => findSessionObserver(id),
    graph: defaultAgentGraph,
  };
}

export async function dispatchAgentReply(
  rawArgs: Record<string, unknown>,
  depsOverride?: ReplyDeps,
): Promise<AgentReplyResult> {
  const toSessionId = typeof rawArgs.toSessionId === 'string' ? rawArgs.toSessionId.trim() : '';
  const record = (result: AgentReplyResult, deliveryReason: string): AgentReplyResult => {
    debug.log('agent.reply', 'dispatch', {
      toSessionId: result.metadata.toSessionId || null,
      delivered: !result.isError,
      ...(result.isError ? { deliveryReason } : {}),
    });
    return result;
  };
  if (!toSessionId) {
    return record(errorResult('AgentReply: toSessionId required', '', ''), 'missing_to_session_id');
  }
  const message = typeof rawArgs.message === 'string' ? rawArgs.message : '';
  if (message.length === 0) {
    return record(errorResult(`AgentReply: message must be non-empty`, '', toSessionId), 'empty_message');
  }
  const opts: ReplyOpts = {
    toSessionId,
    message,
    ...(typeof rawArgs.fromSessionId === 'string' && rawArgs.fromSessionId.trim()
      ? { fromSessionId: rawArgs.fromSessionId.trim() }
      : {}),
    ...(Array.isArray(rawArgs.includeChannels)
      ? {
          includeChannels: rawArgs.includeChannels.filter(
            (x) => typeof x === 'string',
          ) as readonly string[],
        }
      : {}),
    ...(typeof rawArgs.idleMs === 'number' && Number.isFinite(rawArgs.idleMs)
      ? { idleMs: rawArgs.idleMs }
      : {}),
    ...(typeof rawArgs.timeoutMs === 'number' && Number.isFinite(rawArgs.timeoutMs)
      ? { timeoutMs: rawArgs.timeoutMs }
      : {}),
  };
  try {
    const result = await sendReply(opts, depsOverride ?? defaultDeps());
    const lines: string[] = [];
    const label = result.fromSessionId
      ? `${result.fromSessionId} → ${result.toSessionId}`
      : `${USER_GHOST_SESSION_ID} → ${result.toSessionId}`;
    lines.push(
      `AgentReply: ${label} · elapsed ${result.elapsedMs}ms · depth ${result.cycleDepth}`,
    );
    if (result.replyText) {
      lines.push('');
      lines.push(result.replyText);
    } else {
      lines.push('  (no reply content)');
    }
    if (result.warnings.length > 0) {
      lines.push('');
      lines.push(`  warnings: ${result.warnings.join(', ')}`);
    }
    return record({
      output: lines.join('\n'),
      metadata: {
        fromSessionId: result.fromSessionId,
        toSessionId: result.toSessionId,
        replyText: result.replyText,
        channels: result.channels,
        elapsedMs: result.elapsedMs,
        cycleDepth: result.cycleDepth,
        warnings: [...result.warnings],
      },
    }, 'delivered');
  } catch (err) {
    if (err instanceof ReplyCycleExceededError) {
      return record(errorResult(
        `AgentReply: cycle depth ${err.depth} exceeds cap ${err.cap} (from=${err.fromSessionId}, to=${err.toSessionId})`,
        typeof opts.fromSessionId === 'string' ? opts.fromSessionId : '',
        opts.toSessionId,
      ), 'cycle_depth_exceeded');
    }
    return record(errorResult(
      `AgentReply: ${err instanceof Error ? err.message : String(err)}`,
      typeof opts.fromSessionId === 'string' ? opts.fromSessionId : '',
      opts.toSessionId,
    ), 'send_failed');
  }
}

function errorResult(message: string, fromId: string, toId: string): AgentReplyResult {
  return {
    output: message,
    metadata: {
      fromSessionId: fromId || null,
      toSessionId: toId,
      replyText: '',
      channels: {},
      elapsedMs: 0,
      cycleDepth: 0,
      warnings: [],
    },
    isError: true,
  };
}

/** Bootstrap parity with other H6 tools — no-op by design; lookups
 *  are lazy so the dispatcher stays usable even when the module was
 *  imported before the live-session map was populated. */
export function initAgentReplyTools(): void {
  // Intentionally empty · dispatchAgentReply resolves deps at call
  // time. Exists so `dashboard.ts` bootstrap reads uniformly alongside
  // `initPolicyRouter()` / `initAgentRoomTools()`.
}
