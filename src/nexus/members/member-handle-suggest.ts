// Handle recommendation + similar-address suggestion (MEMBER-JOURNEY-FRICTIONLESS S2). Pure and deterministic: the same input always gives
// the same output, nothing here reads a store, a clock or the network. The handle is the public address label `<handle>.elanous.app`,
// so the rules are the claim API's rules (PUT /v1/members/handle) plus the names the relay refuses as a bare handle.
//
// slugFromName is a deterministic character transform (Unicode -> [a-z0-9]), not a classifier of what a name means.

/** Public handle length bounds (claim API regex ^[a-z][a-z0-9]{2,19}$ and the relay's DNS user label). 출처: members-api.ts PUT /v1/members/handle. */
export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;
export const HANDLE_PATTERN = /^[a-z][a-z0-9]{2,19}$/;
/** Last-resort handle stem when neither the name nor the email gives three usable characters. */
export const HANDLE_FALLBACK = 'member';

/** Names that belong to us as a member handle. 출처: member-store.ts claimHandle (moved here unchanged so the suggester can see it). */
export const RESERVED_MEMBER_HANDLES: ReadonlySet<string> = new Set(['admin', 'user', 'ElanvitalAI', 'elanvital', 'monad', 'elanous']);

/**
 * Bare names the relay refuses as a user label or serves from a fixed route. The first six repeat the literal list in relay-server.ts
 * (bare handle check) and public-app-auto-registration.ts; `app` and `v1` are the web app and API path roots. A test pins the relay literal.
 * 출처: src/relay/relay-server.ts bare handle check.
 */
export const STATIC_DISPATCH_HANDLE_NAMES: ReadonlySet<string> = new Set(['www', 'docs', 'api', 'admin', 'relay', 'mail', 'app', 'v1']);

export function isReservedHandle(candidate: string, mayHoldJoosung = false): boolean {
  return STATIC_DISPATCH_HANDLE_NAMES.has(candidate)
    || (RESERVED_MEMBER_HANDLES.has(candidate) && !(candidate === 'user' && mayHoldJoosung));
}

/** True when the candidate satisfies the format and is not one of our own names (taken-ness is the caller's business). */
export function isAssignableHandleShape(candidate: string): boolean {
  return HANDLE_PATTERN.test(candidate) && !isReservedHandle(candidate);
}

// Revised Romanization of Korean, per jamo, without neighbour-sound-change rules (each syllable is spelled from its own jamo, so the
// result is stable and reversible enough for an address). 출처: National Institute of Korean Language, Revised Romanization (2000).
const INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'] as const;
const MEDIALS = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'] as const;
const FINALS = ['', 'k', 'kk', 'ks', 'n', 'nj', 'nh', 't', 'l', 'lk', 'lm', 'lb', 'ls', 'lt', 'lp', 'lh', 'm', 'p', 'ps', 't', 'ss', 'ng', 't', 't', 'k', 't', 'p', 't'] as const;
// Hangul syllable block layout. 출처: Unicode Standard ch.3.12 (Hangul Syllable Decomposition).
const SYLLABLE_BASE = 0xac00;
const SYLLABLE_LAST = 0xd7a3;
const MEDIAL_COUNT = 21;
const FINAL_COUNT = 28;

function romanizeSyllable(code: number): string {
  const offset = code - SYLLABLE_BASE;
  const initial = Math.floor(offset / (MEDIAL_COUNT * FINAL_COUNT));
  const medial = Math.floor((offset % (MEDIAL_COUNT * FINAL_COUNT)) / FINAL_COUNT);
  const final = offset % FINAL_COUNT;
  return (INITIALS[initial] ?? '') + (MEDIALS[medial] ?? '') + (FINALS[final] ?? '');
}

/** Any text -> lowercase [a-z0-9] only: Hangul romanized, accents stripped, everything else dropped. */
function toAlnum(text: string): string {
  let out = '';
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= SYLLABLE_BASE && code <= SYLLABLE_LAST) { out += romanizeSyllable(code); continue; }
    out += char.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  return out;
}

/** A handle must start with a letter: leading digits are dropped, then the 20-character limit applies. */
function shapeStem(alnum: string): string {
  return alnum.replace(/^[0-9]+/, '').slice(0, HANDLE_MAX);
}

/**
 * The recommended handle for a Google display name: romanize, keep [a-z0-9], start with a letter, at most 20 characters. When the name
 * leaves fewer than three usable characters the email local part (same transform) is used, then 'member'. Always matches HANDLE_PATTERN;
 * it may still be reserved or taken, which the caller checks.
 */
export function slugFromName(name: string, emailLocalPart?: string): string {
  const fromName = shapeStem(toAlnum(name ?? ''));
  if (fromName.length >= HANDLE_MIN) return fromName;
  const fromEmail = shapeStem(toAlnum(emailLocalPart ?? ''));
  if (fromEmail.length >= HANDLE_MIN) return fromEmail;
  return HANDLE_FALLBACK;
}

// Upper bound on suffixes tried, so a fully taken neighbourhood ends instead of looping. 출처: design choice, 3-digit suffix space.
const SUFFIX_LIMIT = 999;

/**
 * Up to `count` similar, valid, free handles: the base with a numeric suffix (1, 2, 3 ... 999), the stem trimmed so the whole stays within
 * 20 characters. Order is fixed. Never returns the base itself; `isTaken` is asked about every shape-valid candidate.
 */
export function suggestAlternatives(base: string, isTaken: (candidate: string) => boolean, count = 3): string[] {
  const stem = base.toLowerCase().replace(/[^a-z0-9]/g, '');
  const found: string[] = [];
  for (let n = 1; n <= SUFFIX_LIMIT && found.length < count; n++) {
    const suffix = String(n);
    const candidate = stem.slice(0, HANDLE_MAX - suffix.length) + suffix;
    if (candidate === base || found.includes(candidate)) continue;
    if (!isAssignableHandleShape(candidate) || isTaken(candidate)) continue;
    found.push(candidate);
  }
  return found;
}
