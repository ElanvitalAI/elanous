import type { LLMToolSpec } from '../../llm/tool-spec.js';
// H6 P7 · InjectCaptureToContext LLM tool (Tier B).
//
// Atomic pipeline: P6 `registry.snapshot(sourceId)` → wrap per `as`
// mode → HITL binary approver (`requestConfirmation`) → `target.send()`
// → 'inject' edge + control-audit-log entry. Consumes the left-half
// from H6 P6 (capture source registry) and the target-side from H5 P3
// (findLiveSessionById).
//
// Output contract matches the rest of the H6 tool family:
//   `{ output: string; metadata: object; isError?: true }`.
//
// Approver denials / timeouts are NOT errors — the tool returns
// `isError` unset with `warnings: ['approver-denied' | 'approver-timeout']`
// so the LLM can adapt (e.g. simplify the request and retry).


import {
  findLiveSessionById,
} from '../../agent/spawn-embodied-agent-in-vw.js';
import {
  injectCapture,
  InjectError,
  type InjectDeps,
  type InjectMode,
  type InjectOpts,
  type InjectResult,
} from '../../capture/inject-context.js';

const VALID_MODES: readonly InjectMode[] = [
  'user-message', 'system-note', 'attached-block',
];

export interface InjectCaptureToContextArgs {
  sourceId: string;
  targetSessionId: string;
  as: InjectMode;
  at?: number;
  fromSessionId?: string;
}

export interface InjectCaptureToContextMetadata {
  sourceId: string;
  targetSessionId: string;
  as: InjectMode;
  injectedBytes: number;
  warnings: string[];
  approvedVia: string;
  elapsedMs: number;
  capturedAt: number;
  denied?: true;
}

export interface InjectCaptureToContextResult {
  output: string;
  metadata: InjectCaptureToContextMetadata;
  isError?: true;
}

export function buildInjectCaptureToContextTool(): LLMToolSpec {
  return {
    name: 'InjectCaptureToContext',
    description:
      'Inject a capture-source snapshot into a live embodied agent session\'s next prompt. ' +
      'Use ListCaptureSources first to find a valid `sourceId` (from H6 P6 registry). ' +
      'The target must be an alive PTY-backed session (see /acp-vw or /agent-room output). ' +
      '`as` controls how the body is wrapped before delivery: ' +
      '`user-message` (raw body · as if user typed it), ' +
      '`system-note` (`[Context]…[/Context]` inline marker), ' +
      '`attached-block` (XML-ish block with metadata · RECOMMENDED DEFAULT). ' +
      'Every call goes through a HITL binary approver — Telegram/Discord/Pushcut/terminal race, ' +
      '120s timeout default. Approver denial or timeout returns `warnings: ["approver-denied"|"approver-timeout"]` ' +
      'WITHOUT `isError` (it\'s an intentional user decision, not a system fault). ' +
      'System errors (`source-missing` · `target-missing` · `target-dead` · `send-failed`) DO set `isError`. ' +
      'Non-revocable v1 — once send() returns, the bytes are in the target\'s PTY buffer. ' +
      'Control-audit-log records every attempt with `action: \'capture_inject\'`.',
    parameters: {
      type: 'object',
      properties: {
        sourceId: {
          type: 'string',
          description: 'Opaque id in `<type>:<native>` form from ListCaptureSources.',
        },
        targetSessionId: {
          type: 'string',
          description: 'Live embodied session id · must have PTY transport.',
        },
        as: {
          type: 'string',
          enum: [...VALID_MODES],
          description: 'Wrapping mode. `attached-block` recommended for most cases.',
        },
        at: {
          type: 'number',
          description: 'Bundle 2 · historical snapshot epoch ms · v1 emits `historical-not-supported` warning.',
        },
        fromSessionId: {
          type: 'string',
          description: 'Optional · graph edge source · defaults to \'user\' ghost when omitted.',
        },
      },
      required: ['sourceId', 'targetSessionId', 'as'],
      additionalProperties: false,
    },
  };
}

function defaultDeps(): InjectDeps {
  return {
    lookupSession: (id) => {
      const e = findLiveSessionById(id);
      return e ? { session: e.session } : undefined;
    },
  };
}

export async function dispatchInjectCaptureToContext(
  rawArgs: Record<string, unknown>,
  depsOverride?: InjectDeps,
): Promise<InjectCaptureToContextResult> {
  const sourceId = typeof rawArgs.sourceId === 'string' ? rawArgs.sourceId.trim() : '';
  if (!sourceId) {
    return errorResult('InjectCaptureToContext: sourceId required', '', 'attached-block');
  }
  const targetSessionId = typeof rawArgs.targetSessionId === 'string'
    ? rawArgs.targetSessionId.trim() : '';
  if (!targetSessionId) {
    return errorResult(
      'InjectCaptureToContext: targetSessionId required', sourceId, 'attached-block',
    );
  }
  const asRaw = typeof rawArgs.as === 'string' ? rawArgs.as : '';
  if (!(VALID_MODES as readonly string[]).includes(asRaw)) {
    return errorResult(
      `InjectCaptureToContext: as must be one of ${VALID_MODES.join(', ')} · got '${asRaw}'`,
      sourceId,
      'attached-block',
    );
  }
  const as = asRaw as InjectMode;
  const opts: InjectOpts = {
    sourceId,
    targetSessionId,
    as,
    ...(typeof rawArgs.at === 'number' && Number.isFinite(rawArgs.at)
      ? { at: rawArgs.at }
      : {}),
    ...(typeof rawArgs.fromSessionId === 'string' && rawArgs.fromSessionId.trim()
      ? { fromSessionId: rawArgs.fromSessionId.trim() }
      : {}),
  };
  try {
    const result = await injectCapture(opts, depsOverride ?? defaultDeps());
    return successResult(result);
  } catch (err) {
    if (err instanceof InjectError) {
      return errorResult(
        `InjectCaptureToContext: ${err.message}`,
        sourceId,
        as,
        targetSessionId,
      );
    }
    return errorResult(
      `InjectCaptureToContext: ${err instanceof Error ? err.message : String(err)}`,
      sourceId,
      as,
      targetSessionId,
    );
  }
}

function successResult(result: InjectResult): InjectCaptureToContextResult {
  const lines: string[] = [];
  if (result.denied) {
    const reason = result.warnings.includes('approver-timeout')
      ? 'approver timed out'
      : 'approver denied';
    lines.push(
      `InjectCaptureToContext: ${reason} · source=${result.sourceId} → ${result.targetSessionId}`,
    );
    lines.push(`  elapsed ${result.elapsedMs}ms · via ${result.approvedVia}`);
  } else {
    lines.push(
      `InjectCaptureToContext: injected ${result.sourceId} into ${result.targetSessionId} ` +
      `· as=${result.as} · ${result.injectedBytes}B · approved via ${result.approvedVia}`,
    );
    lines.push(`  elapsed ${result.elapsedMs}ms`);
  }
  if (result.warnings.length > 0) {
    lines.push(`  warnings: ${result.warnings.join(', ')}`);
  }
  const metadata: InjectCaptureToContextMetadata = {
    sourceId: result.sourceId,
    targetSessionId: result.targetSessionId,
    as: result.as,
    injectedBytes: result.injectedBytes,
    warnings: [...result.warnings],
    approvedVia: String(result.approvedVia),
    elapsedMs: result.elapsedMs,
    capturedAt: result.capturedAt,
    ...(result.denied ? { denied: true as const } : {}),
  };
  return { output: lines.join('\n'), metadata };
}

function errorResult(
  message: string,
  sourceId: string,
  as: InjectMode,
  targetSessionId: string = '',
): InjectCaptureToContextResult {
  return {
    output: message,
    metadata: {
      sourceId,
      targetSessionId,
      as,
      injectedBytes: 0,
      warnings: [],
      approvedVia: '',
      elapsedMs: 0,
      capturedAt: 0,
    },
    isError: true,
  };
}

/** Bootstrap parity with other H6 tools — no-op by design; lookups
 *  are lazy so the dispatcher stays usable even when the module was
 *  imported before the registry / live-session map was populated. */
export function initCaptureInjectTools(): void {
  // Intentionally empty · dispatchInjectCaptureToContext resolves deps
  // at call time.
}
