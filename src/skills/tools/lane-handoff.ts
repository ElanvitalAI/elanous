import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Showroom v2 · LaneHandoff LLM tool.
//
// Lets the agent invoke a structured cross-lane handoff inside the
// most recent (or named) showroom — the LLM-friendly counterpart of
// the /handoff slash. Reuses `executeHandoffSlash()` so the HITL
// approver, audit, and lane-aware audit detail behave identically.
//
// Output contract matches the H6 P7 InjectCaptureToContext tool —
// `{ output: string; metadata: object; isError?: true }`.


import {
  executeHandoffSlash,
  type HandoffSlashDeps,
} from '../../showroom/handoff-slash.js';
import type { InjectMode } from '../../capture/inject-context.js';

const VALID_MODES: readonly InjectMode[] = [
  'user-message', 'system-note', 'attached-block',
];

export interface LaneHandoffArgs {
  fromLane: string | number;
  toLane: string | number;
  as?: InjectMode;
  roomId?: string;
  reason?: string;
}

export interface LaneHandoffMetadata {
  fromLane: string;
  toLane: string;
  as: InjectMode;
  ok: boolean;
  message: string;
  roomId?: string;
  reason?: string;
}

export interface LaneHandoffResult {
  output: string;
  metadata: LaneHandoffMetadata;
  isError?: true;
}

export function buildLaneHandoffTool(): LLMToolSpec {
  return {
    name: 'LaneHandoff',
    description:
      'Send the recent output of one showroom lane into another live lane (cross-LLM handoff). ' +
      'Targets the most recently-spawned `/showroom` room unless `roomId` is given. ' +
      '`fromLane` and `toLane` accept: ' +
      'integer pane index (0-based), role hint (`plan`/`build`/`exec`/`review`/`reflect`), ' +
      'or brand name (`claude`/`codex`/`gemini`/`elanous`/alias). ' +
      '`as` controls how the captured pane body is wrapped (default `user-message`). ' +
      'Every call routes through the HITL binary approver — denial/timeout returns ' +
      '`ok: false` WITHOUT `isError` (intentional user decision). ' +
      'System failures (`target-dead` · `source-missing`, no live room) DO set `isError`. ' +
      '`reason` is recorded in audit detail for traceability.',
    parameters: {
      type: 'object',
      properties: {
        fromLane: {
          oneOf: [{ type: 'integer' }, { type: 'string' }],
          description: 'Source lane · pane index, role hint, or brand name.',
        },
        toLane: {
          oneOf: [{ type: 'integer' }, { type: 'string' }],
          description: 'Target lane · pane index, role hint, or brand name.',
        },
        as: {
          type: 'string',
          enum: [...VALID_MODES],
          description: 'Wrapping mode. Default `user-message`.',
        },
        roomId: {
          type: 'string',
          description: 'Optional · target a specific showroom by id.',
        },
        reason: {
          type: 'string',
          description: 'Free-form rationale recorded in audit detail.',
        },
      },
      required: ['fromLane', 'toLane'],
      additionalProperties: false,
    },
  };
}

export async function dispatchLaneHandoff(
  rawArgs: Record<string, unknown>,
  deps: HandoffSlashDeps = {},
): Promise<LaneHandoffResult> {
  const fromRaw = rawArgs.fromLane;
  const toRaw = rawArgs.toLane;
  const fromLane = normalizeLaneAddr(fromRaw);
  const toLane = normalizeLaneAddr(toRaw);
  if (!fromLane) return errorResult('LaneHandoff: fromLane required (string|integer)', '', '', 'user-message');
  if (!toLane) return errorResult('LaneHandoff: toLane required (string|integer)', fromLane, '', 'user-message');

  const asRaw = typeof rawArgs.as === 'string' ? rawArgs.as : '';
  let as: InjectMode = 'user-message';
  if (asRaw) {
    if (!(VALID_MODES as readonly string[]).includes(asRaw)) {
      return errorResult(
        `LaneHandoff: invalid as '${asRaw}' · must be one of ${VALID_MODES.join(', ')}`,
        fromLane, toLane, 'user-message',
      );
    }
    as = asRaw as InjectMode;
  }

  const slashArgs: string[] = [fromLane, toLane, '--as', as];
  if (typeof rawArgs.roomId === 'string' && rawArgs.roomId.trim()) {
    slashArgs.push('--room', rawArgs.roomId.trim());
  }

  const result = await executeHandoffSlash(
    { name: 'lane', args: slashArgs },
    deps,
  );

  if (!result) {
    return errorResult('LaneHandoff: dispatcher returned null', fromLane, toLane, as);
  }
  const output = result.logLines.join('\n');
  const metadata = {
    fromLane,
    toLane,
    as,
    ok: result.ok,
    message: result.message ?? output,
    ...(typeof rawArgs.roomId === 'string' && rawArgs.roomId.trim()
      ? { roomId: rawArgs.roomId.trim() }
      : {}),
    ...(typeof rawArgs.reason === 'string' && rawArgs.reason.trim()
      ? { reason: rawArgs.reason.trim() }
      : {}),
  };

  // System failures set isError; HITL denial returns ok=false WITHOUT
  // isError (matches InjectCaptureToContext semantics).
  if (!result.ok) {
    const looksLikeDenial = output.toLowerCase().includes('approver');
    if (!looksLikeDenial) {
      return { output, metadata, isError: true };
    }
  }
  return { output, metadata };
}

function normalizeLaneAddr(raw: unknown): string {
  if (typeof raw === 'number' && Number.isInteger(raw)) return String(raw);
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return '';
}

function errorResult(
  message: string,
  fromLane: string,
  toLane: string,
  as: InjectMode,
): LaneHandoffResult {
  return {
    output: message,
    metadata: {
      fromLane, toLane, as, ok: false, message,
    },
    isError: true,
  };
}
