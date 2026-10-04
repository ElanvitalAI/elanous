import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk';

import { writeInputSourceMeta } from '../acp/input-source-meta.js';
import { isInputSourceKind, type InputSourceRef } from '../input/input-source-kind.js';
import { composeDaemonSystemPrompt } from './daemon-runtime.js';
import type { DaemonToolSurfaceKind } from './daemon-tools/types.js';

const DAEMON_TOOL_SURFACE_KINDS: readonly DaemonToolSurfaceKind[] = [
  'none',
  'readonly',
  'chat',
  'webterm',
];

function isDaemonToolSurfaceKind(value: unknown): value is DaemonToolSurfaceKind {
  return (
    typeof value === 'string'
    && (DAEMON_TOOL_SURFACE_KINDS as readonly string[]).includes(value)
  );
}

export interface DaemonPromptBody {
  sessionId?: string;
  userText?: string;
  /** P-3 §6.9 (2026-05-07) — multi-part user content. When present and
   *  non-empty, the daemon routes through `appendUserPromptBlocksAndBuildMessages`
   *  so image / resource blocks are preserved. `userText` becomes optional
   *  in this mode (and is auto-lifted from the first `text` block for
   *  legacy `submit.text` fields). Q1=B locks `[{text}, {image}]` order
   *  on the composer side; the daemon does not enforce ordering. */
   userContent?: AcpContentBlock[];
  source?: InputSourceRef;
  /** PR-D (PWA surface picker · 2026-05-13) — per-request tool-surface
   *  override. When present, the daemon swaps the boot-time `toolSurface`
   *  for `toolSurface(tools)` on this turn only; subsequent turns fall
   *  back to the daemon's configured surface (CLI `--tools` or
   *  `global.tools`). Validated against the 4-tier kind set
   *  (`none` · `readonly` · `chat` · `webterm`); invalid values reject
   *  the request rather than silently falling back. */
  tools?: DaemonToolSurfaceKind;
  personaId?: string;
}

export interface DaemonPromptRequest {
  sessionId: string;
  userText: string;
  /** P-3 §6.9 (2026-05-07) — see {@link DaemonPromptBody.userContent}.
   *  `null` when the caller used the text-only path. */
  userContent: readonly AcpContentBlock[] | null;
  source: InputSourceRef | null;
  effectiveSystemPrompt: string | undefined;
  /** PR-D (2026-05-13) — per-request tool-surface override resolved
   *  from {@link DaemonPromptBody.tools}. `null` when the caller did
   *  not opt in; the caller-side (`handlePromptStreamPost`) interprets
   *  null as "use the daemon's boot-time surface". */
  tools: DaemonToolSurfaceKind | null;
  personaId?: string;
}

export type DaemonPromptRequestParseResult =
  | { ok: true; value: DaemonPromptRequest }
  | { ok: false; reason: string };

function buildPromptSessionId(): string {
  return `http-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function liftUserTextFromContent(blocks: readonly AcpContentBlock[]): string {
  for (const block of blocks) {
    if (
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ) {
      return (block as { text: string }).text;
    }
  }
  return '';
}

export function parseDaemonPromptBody(
  body: DaemonPromptBody,
  systemPrompt: string | undefined,
): DaemonPromptRequestParseResult {
  const hasContent = Array.isArray(body.userContent) && body.userContent.length > 0;
  const hasText = typeof body.userText === 'string' && body.userText.length > 0;
  if (!hasContent && !hasText) {
    return { ok: false, reason: 'userText or userContent required' };
  }
  if (hasContent) {
    for (const block of body.userContent!) {
      if (
        typeof block !== 'object' || block === null
        || typeof (block as { type?: unknown }).type !== 'string'
      ) {
        return { ok: false, reason: 'userContent items must be ContentBlock objects with a type string' };
      }
    }
  }
  if (body.source && !isInputSourceKind((body.source as Record<string, unknown>)['kind'])) {
    return { ok: false, reason: 'source.kind must be a valid input source kind' };
  }
  if (body.tools !== undefined && !isDaemonToolSurfaceKind(body.tools)) {
    return {
      ok: false,
      reason: `tools must be one of ${DAEMON_TOOL_SURFACE_KINDS.join(', ')}`,
    };
  }
  const userText = hasText ? body.userText! : liftUserTextFromContent(body.userContent!);
  return {
    ok: true,
    value: {
      sessionId: body.sessionId ?? buildPromptSessionId(),
      userText,
      userContent: hasContent ? body.userContent! : null,
      source: body.source ?? null,
      effectiveSystemPrompt: composeDaemonSystemPrompt(
        systemPrompt,
        body.source ? writeInputSourceMeta(body.source) : undefined,
      ),
      tools: body.tools ?? null,
      ...(typeof body.personaId === 'string' && body.personaId.trim() ? { personaId: body.personaId } : {}),
    },
  };
}

