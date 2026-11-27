import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getSessionTierOverride, setSessionTierOverride } from '../../model-tier/session-override.js';
import type { ModelTier } from '../../model-tier/types.js';

export type NextTuiModelChoice = 'fast' | 'normal' | 'deep';

const CHOICES: Readonly<Record<string, { choice: NextTuiModelChoice; tier: ModelTier; label: string }>> = {
  fast: { choice: 'fast', tier: 'budget', label: 'fast' },
  빠름: { choice: 'fast', tier: 'budget', label: 'fast' },
  normal: { choice: 'normal', tier: 'balanced', label: 'normal' },
  보통: { choice: 'normal', tier: 'balanced', label: 'normal' },
  deep: { choice: 'deep', tier: 'best', label: 'deep' },
  깊음: { choice: 'deep', tier: 'best', label: 'deep' },
};

export type NextTuiModelCommand =
  | { readonly kind: 'tier'; readonly choice: NextTuiModelChoice; readonly tier: ModelTier; readonly label: string }
  | { readonly kind: 'provider'; readonly providerCommand: string }
  | { readonly kind: 'invalid'; readonly message: string };

const MODEL_USAGE = 'Usage: /model <fast|normal|deep> (Korean aliases 빠름|보통|깊음 also work) · /provider is an alias';

/** Parse /model and its /provider alias; retain the older /provider subcommands. */
export function parseNextTuiModelCommand(input: string): NextTuiModelCommand {
  const normalized = input.trim().replace(/\s+/g, ' ');
  const separator = normalized.indexOf(' ');
  const command = separator < 0 ? normalized : normalized.slice(0, separator);
  const args = separator < 0 ? '' : normalized.slice(separator + 1).trim();
  const normalizedChoice = args.toLowerCase();
  const selected = args
    ? (Object.hasOwn(CHOICES, normalizedChoice) ? CHOICES[normalizedChoice] : undefined)
      ?? (Object.hasOwn(CHOICES, args) ? CHOICES[args] : undefined)
    : undefined;

  if (selected) {
    return { kind: 'tier', choice: selected.choice, tier: selected.tier, label: selected.label };
  }
  if (command === '/provider' && (!args || /^(models|refresh|use)(\s|$)/.test(args))) {
    return { kind: 'provider', providerCommand: args };
  }
  return { kind: 'invalid', message: MODEL_USAGE };
}

/** SEAT-MODEL-SURVIVES-MIGRATION: a seat's /model choice is kept per seat (<root>/seat-model/<SEAT>.tier.json) — the session
 *  override is in memory and every `els update-all` migration (rails every 2 h) restarted the tab onto the default tier. */
export interface SeatTierChoice { readonly seat: string; readonly tier: ModelTier; readonly choice: NextTuiModelChoice; readonly at: string }
export const seatTierPath = (root: string, seat: string): string => join(root, 'seat-model', `${seat.toUpperCase().replace(/[^A-Z0-9._-]/gu, '_')}.tier.json`);
const liveRoot = (): string => (require('../../instance/resolve.js') as typeof import('../../instance/resolve.js')).effectiveInstanceRoot();
/** SEAT-MODEL-PERSIST-OP: the seat this TUI runs as. ELANOUS_TRACK alone missed the OP tab — the els server mints the OP
 *  pane with ELANOUS_ELS_WS=OP and cwd seats/OP but no ELANOUS_TRACK, so `/model deep` there was never persisted and every
 *  rail restart came back on the default tier (live 11-27 21:00: terra 57 · sol 0 · no *.tier.json for any seat).
 *  Order = the caller-identity kit (ELANOUS_TRACK → ELANOUS_SEAT → seats/<SEAT> cwd) → the els workspace of the pane. */
export function tuiSeat(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | undefined {
  const { callerSeat } = require('../../kit/mail-route/sender.js') as typeof import('../../kit/mail-route/sender.js');
  const ws = env.ELANOUS_ELS_WS?.trim().toUpperCase() ?? '';
  return callerSeat(env, cwd) ?? (/^[A-Z][A-Z0-9_-]{0,63}$/u.test(ws) ? ws : undefined);
}
const liveSeat = (): string | undefined => tuiSeat();

export function readSeatTierChoice(root: string, seat: string): SeatTierChoice | null {
  try {
    const j = JSON.parse(readFileSync(seatTierPath(root, seat), 'utf8')) as Partial<SeatTierChoice>;
    const known = Object.values(CHOICES).find(c => c.choice === j.choice && c.tier === j.tier);
    return known && typeof j.at === 'string' ? { seat: seat.toUpperCase(), tier: known.tier, choice: known.choice, at: j.at } : null;
  } catch { return null; }
}

/** Persist the person's tier choice for this session (the shared turn resolver applies it) and, in a seat, for the seat. */
export function applyNextTuiModelTier(sessionId: string, tier: ModelTier, choice: NextTuiModelChoice, opts: { seat?: string; root?: string; now?: Date } = {}): void {
  setSessionTierOverride(sessionId, {
    llm: tier,
    rationale: `next TUI /model ${choice}`,
  });
  const seat = opts.seat ?? liveSeat();
  if (!seat) return;
  try {
    const path = seatTierPath(opts.root ?? liveRoot(), seat);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify({ seat: seat.toUpperCase(), tier, choice, at: (opts.now ?? new Date()).toISOString() } satisfies SeatTierChoice)}\n`);
    renameSync(`${path}.tmp`, path);
  } catch { /* the session choice still holds; persistence is best-effort */ }
}

/** On a fresh session (boot · migration · child restart) with no override: re-apply the seat's last /model choice.
 *  Returns the restored choice, or null (no seat · no choice · the session already has one). */
export function restoreSeatTier(sessionId: string, opts: { seat?: string; root?: string } = {}): SeatTierChoice | null {
  const seat = opts.seat ?? liveSeat();
  if (!seat || getSessionTierOverride(sessionId)) return null;
  const c = readSeatTierChoice(opts.root ?? liveRoot(), seat);
  if (!c) return null;
  setSessionTierOverride(sessionId, { llm: c.tier, rationale: `seat ${c.seat} /model ${c.choice} (restored · ${c.at})` });
  return c;
}

/** SEAT-MODEL-SURVIVES-MIGRATION (live 11-27 11:1x): `/model deep` sent while a turn ran went into the queue and the tier
 *  never applied. A tier choice only changes the NEXT turn, so it never needs to wait: while busy it applies at once (same
 *  apply as an idle send). Returns the tier command to apply now, or null (anything else keeps the queued path). */
export function busyModelCommand(text: string): Extract<NextTuiModelCommand, { kind: 'tier' }> | null {
  const parsed = parseNextTuiModelCommand(text);
  return parsed.kind === 'tier' ? parsed : null;
}
