import type { LLMToolSpec } from '../../llm/tool-spec.js';
// H5 Phase 3 · AgentHandoff LLM tool.
//
// Thin wrapper around `src/agent/handoff.ts` that exposes the
// primitive as an LLM-callable tool with JSON-schema validation. The
// actual snapshot-based context transfer, adapter launch, and graph
// edge recording all happen in handoff().
//
// Consumers:
//   - `src/skill-runner.ts` (dispatch map entry)
//   - `src/native-tool-catalog.ts` (surface advertisement)
//   - dashboard `/handoff` slash (convenience · calls dispatchAgentHandoff)


import { handoff, type HandoffLookup, type HandoffResult } from '../../agent/handoff.js';
import type { AgentLaunchMode } from '../../agent/embodiment.js';

// ─── Lookup injection · same pattern as skill-tool-tty-snapshot ───

let _lookup: HandoffLookup | null = null;

/** Bootstrap-level hook · dashboard wires the live-session lookup
 *  (live embodied session registry + optional observer lookup). */
export function initAgentHandoffTool(lookup: HandoffLookup): void {
  _lookup = lookup;
}

export function _resetAgentHandoffToolForTesting(): void {
  _lookup = null;
}

// ─── Tool spec ────────────────────────────────────────────────────

export function buildAgentHandoffTool(): LLMToolSpec {
  return {
    name: 'AgentHandoff',
    description:
      'Hand off context from one embodied agent session to a new one, possibly of a different brand. The source session keeps running; a new session is launched whose initial prompt is built from the source\'s snapshot (optionally filtered by channel tags). Returns the new session id and the graph edge recorded. Use when the next step is better handled by a different agent (e.g. codex researched → hand to claude for write-up).',
    parameters: {
      type: 'object',
      properties: {
        from_session_id: {
          type: 'string',
          description: 'Source EmbodiedAgentSession id (e.g. emb-codex-pty-3-...).',
        },
        to_brand: {
          type: 'string',
          description:
            'Target agent brand. Registered brands include: codex, claude, claude-code, gemini, gemini-cli, elanous, elanous-child.',
        },
        to_mode: {
          type: 'string',
          description:
            'Optional launch mode override · auto | pty-direct | hybrid | acp | native-sdk · default pty-direct.',
        },
        to_cwd: { type: 'string', description: 'Optional cwd for the new agent.' },
        context_channels: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional channel filter (e.g. ["reasoning", "plan"]) · only makes sense when the source has an attached observer. Empty / omitted = include all active channels or fall back to raw PTY snapshot.',
        },
        context_prompt: {
          type: 'string',
          description:
            'Optional prefix prompt emitted before the source extract (e.g. "Continue from where codex left off, focus on the tests").',
        },
        max_bytes: {
          type: 'number',
          description:
            'Byte cap for the built context · default 8192. Keeps target agent token budget under control.',
        },
        edge_kind: {
          type: 'string',
          description: 'Graph edge kind · "handoff" (default) or "dependency".',
        },
      },
      required: ['from_session_id', 'to_brand'],
      additionalProperties: false,
    },
  };
}

// ─── Dispatcher ───────────────────────────────────────────────────

export async function dispatchAgentHandoff(
  args: Record<string, unknown>,
): Promise<{
  output: string;
  from_session_id: string;
  to_session_id: string;
  context_bytes: number;
  included_channels: readonly string[];
  edge_kind: string;
}> {
  const lookup = requireLookup();
  const from = typeof args.from_session_id === 'string' ? args.from_session_id : '';
  const brand = typeof args.to_brand === 'string' ? args.to_brand : '';
  if (!from) throw new Error('AgentHandoff: from_session_id is required');
  if (!brand) throw new Error('AgentHandoff: to_brand is required');

  const mode = typeof args.to_mode === 'string'
    ? (args.to_mode as AgentLaunchMode)
    : undefined;
  const cwd = typeof args.to_cwd === 'string' ? args.to_cwd : undefined;
  const contextChannels = Array.isArray(args.context_channels)
    ? (args.context_channels as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined;
  const contextPrompt = typeof args.context_prompt === 'string' ? args.context_prompt : undefined;
  const maxBytes = typeof args.max_bytes === 'number' && Number.isFinite(args.max_bytes)
    ? Math.max(256, Math.min(64 * 1024, Math.floor(args.max_bytes)))
    : undefined;
  const edgeKindRaw = typeof args.edge_kind === 'string' ? args.edge_kind : undefined;
  const edgeKind: 'handoff' | 'dependency' | undefined =
    edgeKindRaw === 'handoff' || edgeKindRaw === 'dependency' ? edgeKindRaw : undefined;

  const result: HandoffResult = await handoff(
    {
      from,
      to: {
        brand,
        ...(mode !== undefined ? { mode } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      },
      ...(contextChannels !== undefined ? { contextChannels } : {}),
      ...(contextPrompt !== undefined ? { contextPrompt } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(edgeKind !== undefined ? { edgeKind } : {}),
    },
    { lookup },
  );

  const channelsNote = result.includedChannels.length > 0
    ? `channels=${result.includedChannels.join(',')}`
    : 'raw-snapshot';
  return {
    output: `handoff ${from} → ${result.toSession.id} · ${result.contextBytes}B · ${channelsNote}`,
    from_session_id: from,
    to_session_id: result.toSession.id,
    context_bytes: result.contextBytes,
    included_channels: result.includedChannels,
    edge_kind: result.edge.kind,
  };
}

function requireLookup(): HandoffLookup {
  if (!_lookup) {
    throw new Error('AgentHandoff tool not wired · call initAgentHandoffTool(lookup) first.');
  }
  return _lookup;
}
