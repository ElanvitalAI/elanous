import { classifyTurnFailure, TURN_FAILURE_CAUSE_LABELS } from '../chat/error-card.js';
import { NEXT_TUI_AUTH_FAILURE_TEXT, type NextTuiAuthFailureKind } from '../../tui-client/next-auth-preflight.js';
/** Next basic chat projects public turn text without transport or tool payloads. */
const clean = (text: string): string => text.replace(/\r\n?/g, '\n')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ');

export function projectUserReplyStatus(status: string): string {
  return /(?:재시도|retry)/iu.test(status) ? '연결 재시도 중 · Esc 취소' : '응답 중 · Esc 취소';
}

export function streamReplyProgress(_turnId: string): string { return '응답을 준비하고 있습니다.'; }
/** Only known, actionable auth failures may pass through the public failure projection. */
export function projectKnownAuthFailure(kind?: NextTuiAuthFailureKind): string | null {
  return kind ? NEXT_TUI_AUTH_FAILURE_TEXT[kind] ?? null : null;
}
export function streamReplyFailure(_turnId: string): string { return '요청을 처리하지 못했습니다.'; }

/** Select the assistant-visible failure notice for a finished turn.
 *
 * Seam for the entry hotspot (P0-ENTRY-TS-HOTSPOT-SEAM): failure classification
 * for the public reply used to be an inline `entry.ts` ternary, so failure-handling
 * changes (e.g. the known-auth-failure projection in #37348) edited the entry file.
 * `entry.ts` keeps one stable call; classification lands here.
 */
export function turnReplyFailureMessage(
  turnId: string,
  failed: boolean,
  authFailureKind?: NextTuiAuthFailureKind,
  error?: string,
): string | null {
  if (!failed) return null;
  const known = projectKnownAuthFailure(authFailureKind);
  if (known) return known;
  // Class of cause only (never the raw error text): provider failure vs cut stream vs timeout, etc.
  const cause = classifyTurnFailure(error);
  return cause ? `${streamReplyFailure(turnId)} (${cause})` : streamReplyFailure(turnId);
}

/** NEXT-TUI-FEATURE-COMPLETE ② — the cause label of a saved failure notice, so a reloaded session does not fall back to
 *  the bare «요청을 처리하지 못했습니다». Only an exact known label is accepted: saved text is never shown as is. */
export function savedFailureCause(content: string): string | null {
  const match = /\(([^()]+)\)\s*$/u.exec(content);
  return match && TURN_FAILURE_CAUSE_LABELS.includes(match[1]!) ? match[1]! : null;
}

/** A trailing action-shaped line inside an open code fence remains answer text. */
function hasOpenCodeFence(text: string): boolean {
  let opened: { marker: string; length: number } | null = null;
  for (const line of text.split('\n')) {
    const fence = /^[ \t]*((?:`{3,}|~{3,}))(.*)$/u.exec(line);
    if (!fence) continue;
    const marker = fence[1]![0]!;
    const length = fence[1]!.length;
    if (!opened) { opened = { marker, length }; continue; }
    if (marker === opened.marker && length >= opened.length && fence[2]!.trim() === '') opened = null;
  }
  return opened !== null;
}

/** Keep full final prose and only split an explicit trailing action block. */
export function streamReplyFinal(_turnId: string, text: string): string {
  const safe = clean(text);
  const match = /\n\n할 일:\n((?:- [^\n]+\n?)+)$/u.exec(safe);
  if (!match) return safe;
  const preceding = safe.slice(0, match.index);
  if (hasOpenCodeFence(preceding)) return safe;
  const actions = match[1]!.split('\n').filter(Boolean).map((line) => line.slice(2));
  return `${preceding}\n\n${actions.map((action) => `할 일: ${action}`).join('\n')}`;
}

/** The shared log renderer strips control tabs. Expand only at paint time; the saved answer keeps its bytes. */
export function displayNextPublicReplyText(text: string): string {
  return text.replace(/\t/g, '    ');
}
