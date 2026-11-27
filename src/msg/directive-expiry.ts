// DIRECTIVE-EXPIRY (Q5 · OP 11-25 «지시에 만료가 없다» · SIGNAL-SYSTEM-REVIEW 꼴 6 · 외부 연구 CoDel sojourn expiry)
//
// S: a temporary crown/OP order («지금 배정하라») stayed live after the situation changed; a long-turn OP carried it out to
//    the end and collided with the steward (H2). Passive mail piled up unread for hours and was re-read every turn.
// C: structured fields only — never the body words. The store already hides a row whose `expires_at` passed from every
//    unread read (held list · MsgList · digest), so an expiry stamped at post time is enough for those paths.
// Q: which mail expires when, how is an order withdrawn, and how does the seat learn that it lapsed?
// A: `msg post` stamps `expiresAt` by kind (this table) · `--expires <dur>` overrides · `--standing` = 24 h · `--no-expiry`
//    = none. `--retracts <msgId>` stores `supersedes` and closes the original (its expiry becomes now). The turn-start
//    inbox snapshot shows a lapsed directive once as «expired: #id» and a count of lapsed passive mail.
//
// 세 얼굴: 관측 = debug.log('msg.post', 'retracted' | 'expiry-stamped') · 판단 근거 = {@link postExpiry} (kind ⊕ structured
// directive fields) · 수복과 인계 = the original's expiry closes it everywhere the unread filter runs; the goal pin closes too.

export const MINUTE_MS = 60_000;
/** info · notice · status — passive mail lapses after 30 min unread (CoDel-style sojourn expiry). */
export const PASSIVE_TTL_MS = 30 * MINUTE_MS;
/** coord · request — 2 h. */
export const REQUEST_TTL_MS = 120 * MINUTE_MS;
/** A directive (crown id · goal field · request from above) — 2 h. */
export const DIRECTIVE_TTL_MS = 120 * MINUTE_MS;
/** A directive marked standing (`--standing`) — 24 h. */
export const STANDING_TTL_MS = 24 * 60 * MINUTE_MS;

const PASSIVE_KINDS: ReadonlySet<string> = new Set(['info', 'notice', 'status']);
/**
 * BULLETIN-DELIVERY-WAKE (11-26) — a federal bulletin is the coordinators' standing picture until the next one replaces
 * it: it never lapses (the 30-min passive TTL dropped bulletins held behind a busy seat before they were read).
 */
const NO_EXPIRY_KINDS: ReadonlySet<string> = new Set(['bulletin']);
const REQUEST_KINDS: ReadonlySet<string> = new Set(['coord', 'request']);

export interface DirectiveFields {
  readonly crownDirective?: string | null;
  readonly goal?: string | null;
  readonly kind?: string | null;
  /** The sender sits above the recipient on the federation ladder (structured · hand-raise-ladder). */
  readonly senderAbove?: boolean;
}

/** A directive = a crown-directive id, a goal field, or a request from a seat above. Structured fields only. */
export function isDirective(m: DirectiveFields): boolean {
  if (typeof m.crownDirective === 'string' && m.crownDirective.trim() !== '') return true;
  if (typeof m.goal === 'string' && m.goal.trim() !== '') return true;
  return (m.kind ?? '').trim().toLowerCase() === 'request' && m.senderAbove === true;
}

/** `30m` · `2h` · `1d` · `90s` · `+2h` → ms. Throws on anything else (a bad flag never stores a message). */
export function parseExpiresDuration(text: string): number {
  const match = /^\+?(\d+)\s*(s|m|h|d)$/i.exec(text.trim());
  if (!match) throw new Error(`--expires needs a duration like 30m · 2h · 1d (got «${text}»)`);
  const n = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const ms = n * (unit === 's' ? 1000 : unit === 'm' ? MINUTE_MS : unit === 'h' ? 60 * MINUTE_MS : 24 * 60 * MINUTE_MS);
  if (!Number.isSafeInteger(ms) || ms < 1000) throw new Error('--expires must be at least 1s');
  return ms;
}

export interface PostExpiryInput extends DirectiveFields {
  readonly expires?: string;
  readonly standing?: boolean;
  /** commander `--no-expiry` → false. */
  readonly expiry?: boolean;
  readonly now: Date;
}

export type PostExpiry = { readonly expiresAt?: string; readonly rule: 'flag' | 'standing' | 'none' | 'directive' | 'request' | 'passive' | 'bulletin' | 'kind-unlisted' };

/** The expiry `msg post` stamps. Flags win over the kind table; an unlisted kind (question · decision · alert …) gets none. */
export function postExpiry(input: PostExpiryInput): PostExpiry {
  const flags = [input.expires !== undefined, input.standing === true, input.expiry === false].filter(Boolean).length;
  if (flags > 1) throw new Error('use one of --expires <dur> · --standing · --no-expiry');
  const at = (ms: number): string => new Date(input.now.getTime() + ms).toISOString();
  if (input.expiry === false) return { rule: 'none' };
  if (input.expires !== undefined) return { expiresAt: at(parseExpiresDuration(input.expires)), rule: 'flag' };
  if (input.standing === true) return { expiresAt: at(STANDING_TTL_MS), rule: 'standing' };
  const kind = (input.kind ?? '').trim().toLowerCase();
  if (NO_EXPIRY_KINDS.has(kind) && !input.crownDirective && !input.goal) return { rule: 'bulletin' };
  if (isDirective(input)) return { expiresAt: at(DIRECTIVE_TTL_MS), rule: 'directive' };
  if (REQUEST_KINDS.has(kind)) return { expiresAt: at(REQUEST_TTL_MS), rule: 'request' };
  if (PASSIVE_KINDS.has(kind)) return { expiresAt: at(PASSIVE_TTL_MS), rule: 'passive' };
  return { rule: 'kind-unlisted' };
}

/** Live = no expiry, or the expiry is still ahead. A retracted mail carries expiry = retraction time, so it is not live. */
export function isLive(m: { readonly expiresAt?: string | null }, now: number): boolean {
  if (!m.expiresAt) return true;
  const t = Date.parse(m.expiresAt);
  return !Number.isFinite(t) || t > now;
}

/** Who may retract a mail: its own sender, or OP / CLAUDE-OP (the federation HQ seats). */
export function mayRetract(retractor: string, originalSender: string): boolean {
  const r = retractor.trim().toUpperCase();
  return r === originalSender.trim().toUpperCase() || r === 'OP' || r === 'CLAUDE-OP';
}
