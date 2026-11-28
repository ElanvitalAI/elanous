// NEXT-TUI-CONTINUE-BANNER (대표 11-17 «오류처럼 보이는 문구»): when the TUI opens a turn by itself it says so in one calm,
// dimmed English line — «↻ Continuing (turn limit reached · 1/5)» — instead of «↻ 자동 재개(goal-continue): seat turn cap
// exhausted · continuing», which read like an error, mixed languages and exposed internal names. The reason codes come
// from the callers (goal-continue: turn-limit n/m · next-step · remaining-plan); other origins are named by what woke.
import type { InternalTurnOrigin } from '../../chat/internal-turn-origin.js';

export const CONTINUE_GLYPH = '↻';

/** Reason codes goal-continue passes with its internal turn (never shown as they are). */
export const CONTINUE_REASON = {
  turnLimit: (n: number, limit: number) => `turn-limit ${n}/${limit}`,
  nextStep: 'next-step',
  remainingPlan: 'remaining-plan',
  delegationFallback: 'delegation-fallback',
} as const;

const RESUME_BY_ORIGIN: Readonly<Partial<Record<InternalTurnOrigin | string, string>>> = {
  scheduled: 'Resuming (scheduled check)',
  retro: 'Resuming (scheduled retro)',
  pulse: 'Resuming (OP pulse)',
  'msg-wake': 'Resuming (new message)',
  'child-complete': 'Resuming (delegated work finished)',
  autowake: 'Resuming (remaining work)',
  'self-pull': 'Resuming (next cell)',
};

/** The words after the glyph for an internal turn of `origin` with `reason` (a code from CONTINUE_REASON or free text). */
export function continueLabel(origin: InternalTurnOrigin | string, reason?: string): string {
  if (origin === 'goal-continue') {
    const limit = /^turn-limit (\d+)\/(\d+)$/u.exec(reason ?? '');
    if (limit) return `Continuing (turn limit reached · ${limit[1]}/${limit[2]})`;
    if (reason === CONTINUE_REASON.remainingPlan) return 'Continuing (remaining plan)';
    if (reason === CONTINUE_REASON.nextStep) return 'Continuing (next step)';
    if (reason === CONTINUE_REASON.delegationFallback) return 'Continuing (doing the delegated work directly)';
    return 'Continuing';
  }
  return RESUME_BY_ORIGIN[origin] ?? 'Resuming';
}

export const continueBanner = (origin: InternalTurnOrigin | string, reason?: string): string => `${CONTINUE_GLYPH} ${continueLabel(origin, reason)}`;

/** A continue/resume line: drawn dim like other activity, never like a person's turn or an error. */
export const isContinueBanner = (line: string): boolean => /^↻ (?:Continuing|Resuming)\b/u.test(line);
export const dimContinueBanner = (line: string): string => (isContinueBanner(line) ? `\x1b[2m${line}\x1b[22m` : line);

/** The one-line head of a turn delivered for another seat — the same words the log head draws (structured fields only). */
export function agentTurnBanner(from: { seat?: string; intent?: string; due?: string; msgId?: string }): string {
  return ['⇢ ' + (from.seat ?? 'agent'), from.intent, from.due ? `due ${from.due}` : undefined, from.msgId ? `#${from.msgId}` : undefined]
    .filter(Boolean).join(' · ');
}
