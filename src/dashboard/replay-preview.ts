// BACKLOG #1 — markdown-aware replay preview rendering.
//
// `ELANOUS_RESUME_SESSION` boot, `/resume <daemon-id>` mid-flight swap,
// and `/session load <prefix>` (TUI-side) all show a "Preview of last
// 5" block after replaying history into chat.history. The original
// implementation collapsed each message into a single 100-char line
// via `text.replace(/\s+/g, ' ').slice(0, 100)`, which destroys
// markdown structure (tables, lists, headings) the streaming path's
// `formatResponse` would otherwise render.
//
// This helper centralizes the render contract so the three call
// sites stay aligned: same role prefix coloring, same per-message
// line cap, same continuation marker. Output mirrors the streaming
// path's look (`formatResponse` → ANSI lines) so a replayed turn
// looks visually consistent with one streamed live.
//
// Sized for "preview" not "full restoration" — caller already pushed
// the messages into chat.history; this just gives the user a
// scannable confirmation of what was loaded.

import { formatResponse } from '../chat/index.js';
import { C } from '../tui.js';

/** Subset of chat-history-message shape this helper consumes.
 *  Defined permissively so callers don't have to coerce
 *  daemon-side LLM-message types vs. local session-store types. */
export interface ReplayPreviewMessage {
  role: string;
  content: unknown;
}

export interface ReplayPreviewOpts {
  /** Maximum characters per chat line (typically `wrapWidth - 8` to
   *  leave room for the role-prefix gutter). Caller computes from
   *  `termSize().cols` minus their own pane padding. */
  maxWidth: number;
  /** How many trailing messages to render. Default 5 — the historical
   *  "Preview of last 5" contract. */
  tail?: number;
  /** How many rendered lines to show per message before collapsing
   *  the rest under a "… (N more lines)" marker. Default 2 keeps
   *  long replies from drowning out the preview. */
  perMessageLines?: number;
  /** Streaming-path wrap options forwarded to `formatResponse`. Pass
   *  `getUserConfig().chat.rendering.wrap` to match the live render. */
  wrapOpts?: { urlAware?: boolean };
}

/** Extract the displayable text from a chat-history message. Handles
 *  both `string` content (TUI session-store) and ACP-style
 *  `Array<{type, text}>` blocks (daemon REST history). */
export function extractReplayText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = block as { type?: string; text?: string };
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    return parts.join('');
  }
  return '';
}

/** Render the role-prefix gutter for a message. Mirrors the colors
 *  the original three sites used inline so the visual shape is
 *  unchanged from the user's POV. */
function rolePrefix(role: string): string {
  switch (role) {
    case 'user': return C.accent('  you  ');
    case 'assistant': return C.success('  asst ');
    default: return C.muted('  sys  ');
  }
}

/** Build the preview block as an array of ready-to-push chat lines.
 *  Each message renders as: prefix on the first line, followed by
 *  continuation indent on overflow lines. When a message has more
 *  rendered lines than `perMessageLines`, a muted footer marker
 *  shows the elided count so users know there's more in the
 *  underlying chat.history. */
export function renderReplayPreviewLines(
  messages: readonly ReplayPreviewMessage[],
  opts: ReplayPreviewOpts,
): string[] {
  const tail = opts.tail ?? 5;
  const perMessageLines = opts.perMessageLines ?? 2;
  const indent = '        ';
  const lines: string[] = [];

  const slice = messages.slice(-tail);
  for (const m of slice) {
    const text = extractReplayText(m.content);
    if (text.length === 0) continue;
    const rendered = formatResponse(text, Math.max(20, opts.maxWidth - indent.length), opts.wrapOpts ?? {});
    const head = rendered.slice(0, perMessageLines);
    for (let i = 0; i < head.length; i += 1) {
      const body = head[i] ?? '';
      lines.push(i === 0 ? `${rolePrefix(m.role)}${body}` : `${indent}${body}`);
    }
    const remaining = rendered.length - head.length;
    if (remaining > 0) {
      lines.push(C.muted(`${indent}… (${remaining} more line${remaining === 1 ? '' : 's'})`));
    }
  }
  return lines;
}
