// kit/crown-directive — CEO directives become memory cards and a pre-action check (ELN-OP-CROWN-MEMORY · 0.3.40 P0 · CEO 11-28
// 21:0x «중요 내용이면 바로 자발적으로 메모리 기록»).
//
// S: eln OP did not remember the CEO's directives: «MK = 문서 P0 전담» (19:1x) was broken three times — infra cells assigned to MK.
//    The words were in the ledger / a doc change log / mail; nothing stood between eln OP and the assign.
// C: the card is written by the same «decision → pointer» door as the bus pointer (kit/decision-bus · no turn has to ask) · the
//    check is structural (seat ⊕ cell id patterns · never keyword or NL matching) · every number is YAML
//    (graphs/policies/crown-directives.yaml) · no per-agent TS.
// Q: how does a CEO directive reach eln OP's memory at once, and stop an assignment that contradicts it before it happens?
// A: ① `directiveCardOf` — a card (words · scope · target seats · only/never cell patterns · guarded actions · expiry) per
//       source (decision:<id> · doc:<path>#<row> …) · recorded once in `<stateRoot>/crown-directives/cards.jsonl` ⊕ written to
//       eln OP's memory as a pinned card (`rememberDirective` · deterministic id = update, never a second row)
//    ② `directiveRefusal` — before assign / handoff: an active card naming the seat whose only-list misses the cell (or whose
//       never-list holds it) → the refusal line (card · words · expiry ⊕ the seat's role line from seat-state/<SEAT>/ROLE.md)
//    ③ expiry — past `expiresAt` the card stops refusing; `forgetExpired` removes its memory card.
//
// 세 얼굴: 관측 = debug.log('crown-directive', …) ⊕ cards.jsonl · 인지 = active card × seat × cell pattern (pure) ·
//          수복과 인계 = an unreadable ledger/policy never blocks an action (logged) · a memory write failure keeps the ledger card
//          (the check still holds) · the refusal names how it ends (expiry · a new directive).
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const CROWN = '\u{1F451}';

export interface CrownDirectivePolicy {
  readonly defaultExpiryH: number;
  readonly guardedActions: readonly string[];
  readonly memoryPinned: boolean;
  readonly memoryKind: string;
  readonly memoryScope: string;
  /** The seat store the cards go to (the coordinator that assigns · seat recall reads only its own store). */
  readonly memorySeat: string;
  /** S2 — `crown-` cards carried at the tail of every turn until they expire (count ⊕ chars). */
  readonly turnMaxCards: number;
  readonly turnMaxChars: number;
  /** S1 — index lines added since the session-start snapshot, carried at the turn tail (chars). */
  readonly updateMaxChars: number;
  readonly roleFile: string;
  readonly roleSummaryChars: number;
}

export const crownDirectivePolicyPath = (root = resolve(import.meta.dir, '../../..')): string => join(root, 'graphs', 'policies', 'crown-directives.yaml');

/** Pure: pack text → policy. A missing value is a loud error (never a silent default). */
export function parseCrownDirectivePolicy(text: string): CrownDirectivePolicy {
  const y = (parseYaml(text) ?? {}) as { version?: unknown; card?: Record<string, unknown>; memory?: Record<string, unknown>; roles?: Record<string, unknown> };
  if (y.version !== 1) throw new Error('crown-directives policy: version must be 1');
  const pos = (o: Record<string, unknown> | undefined, k: string): number => { const v = o?.[k]; if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`crown-directives policy: ${k} must be a positive number`); return v; };
  const str = (o: Record<string, unknown> | undefined, k: string): string => { const v = o?.[k]; if (typeof v !== 'string' || !v.trim()) throw new Error(`crown-directives policy: ${k} must be a string`); return v.trim(); };
  const acts = y.card?.guarded_actions;
  if (!Array.isArray(acts) || !acts.length || !acts.every((a) => typeof a === 'string')) throw new Error('crown-directives policy: card.guarded_actions must be a list');
  if (typeof y.memory?.pinned !== 'boolean') throw new Error('crown-directives policy: memory.pinned must be true|false');
  return { defaultExpiryH: pos(y.card, 'default_expiry_h'), guardedActions: acts as string[], memoryPinned: y.memory.pinned,
    memoryKind: str(y.memory, 'kind'), memoryScope: str(y.memory, 'scope'), memorySeat: str(y.memory, 'seat').toUpperCase(),
    turnMaxCards: Math.floor(pos(y.memory, 'turn_max_cards')), turnMaxChars: Math.floor(pos(y.memory, 'turn_max_chars')), updateMaxChars: Math.floor(pos(y.memory, 'update_max_chars')),
    roleFile: str(y.roles, 'file'), roleSummaryChars: Math.floor(pos(y.roles, 'summary_chars')) };
}
export function loadCrownDirectivePolicy(path = crownDirectivePolicyPath()): CrownDirectivePolicy {
  return parseCrownDirectivePolicy(readFileSync(path, 'utf8'));
}

export interface DirectiveCard {
  readonly id: string;
  readonly source: string;
  readonly quote: string;
  readonly scope: string;
  /** Seats the directive binds (a seat binds its hands too: MK binds MK-H-*). Empty = memory only (no check). */
  readonly seats: readonly string[];
  /** Cell id patterns the seats may hold (exact id or a trailing `*` prefix). Empty = no allow-list. */
  readonly only: readonly string[];
  /** Cell id patterns the seats must never get. */
  readonly never: readonly string[];
  readonly actions: readonly string[];
  readonly expiresAt: string;
  readonly recordedAt: string;
}

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();
const clip = (s: string, n: number): string => { const f = flat(s); return Array.from(f).length <= n ? f : `${Array.from(f).slice(0, n - 1).join('')}…`; };
const list = (v: readonly string[] | undefined): string[] => [...new Set((v ?? []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean))];

/** The structured directive line a relay record carries in its decision (`scqa.q`): `지시 seats=MK only=DOCS-* never=… until=<ISO> actions=assign,handoff`. */
export const DIRECTIVE_LINE_PREFIX = '지시 ';
export interface DirectiveShape { readonly seats: readonly string[]; readonly only: readonly string[]; readonly never: readonly string[]; readonly until?: string; readonly actions?: readonly string[] }
export function directiveLine(d: DirectiveShape): string {
  return `${DIRECTIVE_LINE_PREFIX}seats=${d.seats.join(',')}${d.only.length ? ` only=${d.only.join(',')}` : ''}${d.never.length ? ` never=${d.never.join(',')}` : ''}${d.until ? ` until=${d.until}` : ''}${d.actions?.length ? ` actions=${d.actions.join(',')}` : ''}`;
}
export function parseDirectiveLine(line: string | undefined): DirectiveShape | null {
  if (!line?.startsWith(DIRECTIVE_LINE_PREFIX)) return null;
  const kv = Object.fromEntries(line.slice(DIRECTIVE_LINE_PREFIX.length).trim().split(/\s+/u).map((p) => { const i = p.indexOf('='); return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]; }));
  const seats = list([kv.seats ?? '']).map((s) => s.toUpperCase());
  if (!seats.length) return null;
  return { seats, only: list([kv.only ?? '']), never: list([kv.never ?? '']), ...(kv.until ? { until: kv.until } : {}), ...(kv.actions ? { actions: list([kv.actions]) } : {}) };
}

/** Pure: one card per source (id = hash of the source · the same source twice = the same card). */
export function directiveCardOf(input: { source: string; quote: string; scope: string; shape?: DirectiveShape | null; recordedAt: string }, policy: Pick<CrownDirectivePolicy, 'defaultExpiryH' | 'guardedActions'>): DirectiveCard {
  const recorded = Date.parse(input.recordedAt);
  const until = input.shape?.until && Number.isFinite(Date.parse(input.shape.until)) ? new Date(Date.parse(input.shape.until)).toISOString() : new Date(recorded + policy.defaultExpiryH * 3_600_000).toISOString();
  return {
    id: `dc-${createHash('sha256').update(input.source).digest('hex').slice(0, 12)}`, source: input.source, quote: clip(input.quote, 600), scope: clip(input.scope, 200),
    seats: input.shape?.seats ?? [], only: input.shape?.only ?? [], never: input.shape?.never ?? [],
    actions: input.shape?.actions?.length ? input.shape.actions : policy.guardedActions, expiresAt: until, recordedAt: new Date(recorded).toISOString(),
  };
}

export const directiveCardsPath = (stateRoot: string): string => join(stateRoot, 'crown-directives', 'cards.jsonl');

/** Every card (first record per id wins — a card is never rewritten; a new directive is a new source). Torn lines skipped. */
export function readDirectiveCards(stateRoot: string): DirectiveCard[] {
  const path = directiveCardsPath(stateRoot);
  if (!existsSync(path)) return [];
  const seen = new Map<string, DirectiveCard>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const c = JSON.parse(line) as DirectiveCard; if (typeof c.id === 'string' && !seen.has(c.id)) seen.set(c.id, c); } catch { /* torn line */ }
  }
  return [...seen.values()];
}

/** Append the card unless its id is there. */
export function recordDirectiveCard(stateRoot: string, card: DirectiveCard): 'recorded' | 'duplicate' {
  if (readDirectiveCards(stateRoot).some((c) => c.id === card.id)) return 'duplicate';
  const path = directiveCardsPath(stateRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(card)}\n`, { mode: 0o600 });
  log('recorded', { id: card.id, source: card.source, seats: card.seats.length });
  return 'recorded';
}

export const isActive = (c: DirectiveCard, nowMs: number): boolean => Date.parse(c.expiresAt) > nowMs;
/** MK binds MK and its hands (MK-H-…). */
export const seatBound = (cardSeat: string, seat: string): boolean => { const a = cardSeat.toUpperCase(); const b = seat.toUpperCase(); return a === b || b.startsWith(`${a}-H-`); };
/** Exact id, or a trailing `*` prefix. */
export const cellMatches = (pattern: string, cellId: string): boolean => (pattern.endsWith('*') ? cellId.startsWith(pattern.slice(0, -1)) : cellId === pattern);

export interface DirectiveQuery { readonly seat: string; readonly cellId: string; readonly action: string }

/** Pure: the refusal line, or null. `role(seat)` = the seat's role line (YAML-SEAT-ROLES when it lands · ROLE.md today). */
export function directiveRefusal(cards: readonly DirectiveCard[], q: DirectiveQuery, nowMs: number, role?: (seat: string) => string | null): string | null {
  for (const c of cards) {
    if (!isActive(c, nowMs) || !c.actions.includes(q.action)) continue;
    const bound = c.seats.find((s) => seatBound(s, q.seat));
    if (!bound) continue;
    const denied = c.never.some((p) => cellMatches(p, q.cellId));
    const outside = c.only.length > 0 && !c.only.some((p) => cellMatches(p, q.cellId));
    if (!denied && !outside) continue;
    let roleLine: string | null = null;
    try { roleLine = role?.(bound) ?? null; } catch { roleLine = null; }
    const why = denied ? `${q.cellId} 는 ${bound} 에게 금지(${c.never.join(',')})` : `${q.cellId} 는 ${bound} 의 허용 칸(${c.only.join(',')}) 밖`;
    log('refused', { card: c.id, seat: q.seat, cell: q.cellId, action: q.action });
    return `${CROWN} 지시 ${c.id} «${clip(c.quote, 160)}» (범위 ${c.scope} · 만료 ${c.expiresAt}) — ${why}${roleLine ? ` · 자리 역할: ${roleLine}` : ''} · ${q.action} 거절 — 다른 자리로 · 지시가 끝나면(만료·새 지시) 다시`;
  }
  return null;
}

/** The seat's role line: the first prose line of `<seatState>/<SEAT>/<role file>` (headings, quotes and lists skipped). */
export function roleSummary(seatState: string, seat: string, policy: Pick<CrownDirectivePolicy, 'roleFile' | 'roleSummaryChars'>): string | null {
  const path = join(seatState, seat.toUpperCase(), policy.roleFile);
  if (!existsSync(path)) return null;
  const line = readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).find((l) => l && !/^(#|>|[-*|]|```|<!--)/u.test(l));
  return line ? clip(line, policy.roleSummaryChars) : null;
}

/** The seat store for a state root: the live seat store when it is this process's universe, else `<stateRoot>/elanous/memory/seats/<SEAT>`. */
export function seatDirFor(stateRoot: string, seat: string): string {
  const { seatMemoryDir } = require('../../seat-memory/seat-memory.js') as typeof import('../../seat-memory/seat-memory.js');
  const { elanousStateRoot } = require('../../autopilot/state-paths.js') as typeof import('../../autopilot/state-paths.js');
  let live = false;
  try { live = resolve(elanousStateRoot()) === resolve(stateRoot); } catch { live = false; }
  return live ? seatMemoryDir(seat) : seatMemoryDir(seat, join(stateRoot, 'elanous', 'memory'));
}

/** The prefix of an actionable directive card's memory name (S2 carries these every turn until they expire). */
export const CROWN_CARD_PREFIX = 'crown-';
const slug = (s: string): string => s.toLowerCase().replace(/\*/gu, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
const kstDay = (iso: string): string => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(5, 10).replace('-', '');

/**
 * The card's memory name — seat recall scores NAME words (3 each · description ≤ 3 · body 1 · floor 2), so the name carries the
 * action words: `crown-<MMDD>-<seats>-<cells>-only|never-<id6>` (e.g. crown-1128-mk-docs-only-3fa2c1). A card that binds no seat
 * is memory-only: `ceo-decision-<MMDD>-<source>` (recalled by relevance, not carried every turn).
 */
export function crownCardName(c: DirectiveCard): string {
  const day = kstDay(c.recordedAt);
  if (!c.seats.length) return `ceo-decision-${day}-${slug(c.source)}`.slice(0, 96);
  const gist = c.only.length ? `${c.only.map(slug).filter(Boolean).slice(0, 2).join('-')}-only` : c.never.length ? `${c.never.map(slug).filter(Boolean).slice(0, 2).join('-')}-never` : 'directive';
  return `${CROWN_CARD_PREFIX}${day}-${c.seats.map(slug).join('-')}-${gist}-${c.id.slice(3, 9)}`.slice(0, 96);
}

/** The memory body (what eln OP reads when the card is carried). */
export function directiveMemoryBody(c: DirectiveCard): string {
  return [`${CROWN} 지시 카드 ${c.id} — ${c.scope}`, `원문: «${c.quote}»`,
    `대상 자리: ${c.seats.length ? c.seats.join(', ') : '(전체 · 행동 대조 없음)'}${c.only.length ? ` · 허용 칸 ${c.only.join(',')}` : ''}${c.never.length ? ` · 금지 칸 ${c.never.join(',')}` : ''}`,
    `만료: ${c.expiresAt} · 출처: ${c.source} · 배정/이관 직전 자동 대조(어긋나면 거절)`].join('\n');
}
/** The description carries the expiry in a fixed form (`만료 <ISO>`) — S2 reads it to stop carrying a card the sweep has not removed yet. */
export const directiveMemoryDescription = (c: DirectiveCard): string => `${c.scope} · 대상 ${c.seats.join(',') || '-'} · 만료 ${c.expiresAt}`;
export const expiryOfDescription = (d: string): number | null => { const m = /만료 (\d{4}-\d\d-\d\dT[\d:.]+Z)/u.exec(d); return m ? Date.parse(m[1]!) : null; };

/** Write (or update — same name) the card in the coordinator's SEAT store; an actionable card is also pinned (top of the index).
 *  Fail-open: the ledger card already holds the check. */
export function rememberDirective(c: DirectiveCard, seatDir: string, policy: Pick<CrownDirectivePolicy, 'memoryPinned' | 'memoryKind' | 'memoryScope' | 'memorySeat'>, now: Date): boolean {
  try {
    const { saveSeatMemory, pinSeatMemory } = require('../../seat-memory/seat-memory.js') as typeof import('../../seat-memory/seat-memory.js');
    const name = crownCardName(c);
    const r = saveSeatMemory({ name, description: directiveMemoryDescription(c), type: 'feedback', body: directiveMemoryBody(c) }, seatDir, policy.memorySeat,
      { origin: 'decision-bus', now, meta: { kind: policy.memoryKind as never, scope: policy.memoryScope as never, sourceEventId: c.source, reason: `${CROWN} 지시 자동 기록` } });
    if (!r.ok) { log('remember-refused', { id: c.id, name, error: r.error.slice(0, 160) }); return false; }
    if (policy.memoryPinned && c.seats.length) pinSeatMemory(name, seatDir);
    log('remembered', { id: c.id, name });
    return true;
  } catch (error) { log('remember-failed', { id: c.id, error: String(error).slice(0, 160) }); return false; }
}

/** Remove the seat memory card of every expired directive. Returns the names removed. */
export function forgetExpired(cards: readonly DirectiveCard[], seatDir: string, seat: string, nowMs: number): string[] {
  const { deleteSeatMemory } = require('../../seat-memory/seat-memory.js') as typeof import('../../seat-memory/seat-memory.js');
  const out: string[] = [];
  for (const c of cards) if (!isActive(c, nowMs)) { const name = crownCardName(c); try { if (deleteSeatMemory(name, seatDir, seat).ok) out.push(name); } catch { /* next sweep */ } }
  if (out.length) log('forgot', { names: out });
  return out;
}

/** The one door the «decision → pointer» path calls: record the card ⊕ remember it. Fail-open (never throws). */
export function noteDirective(stateRoot: string, input: { source: string; quote: string; scope: string; shape?: DirectiveShape | null }, now: Date, policy?: CrownDirectivePolicy): DirectiveCard | null {
  try {
    const p = policy ?? loadCrownDirectivePolicy();
    const card = directiveCardOf({ ...input, recordedAt: now.toISOString() }, p);
    const fresh = recordDirectiveCard(stateRoot, card) === 'recorded';
    const stored = readDirectiveCards(stateRoot).find((c) => c.id === card.id) ?? card;
    if (fresh && isActive(stored, now.getTime())) rememberDirective(stored, seatDirFor(stateRoot, p.memorySeat), p, now);
    return stored;
  } catch (error) { log('note-failed', { source: input.source, error: String(error).slice(0, 160) }); return null; }
}

/** Live check for an action door (seat assign · checklist owner): cards at the state root ⊕ the seat's ROLE.md line. Fail-open. */
export function liveDirectiveRefusal(q: DirectiveQuery, deps: { stateRoot: string; seatState: string; now?: Date }): string | null {
  try {
    const p = loadCrownDirectivePolicy();
    if (!p.guardedActions.includes(q.action)) return null;
    return directiveRefusal(readDirectiveCards(deps.stateRoot), q, (deps.now ?? new Date()).getTime(), (seat) => roleSummary(deps.seatState, seat, p));
  } catch (error) { log('check-failed', { seat: q.seat, cell: q.cellId, error: String(error).slice(0, 160) }); return null; }
}

function log(event: string, data: Record<string, unknown>): void {
  try { (require('../../debug/log.js') as typeof import('../../debug/log.js')).debug.log('crown-directive', event, data); } catch { /* fail-open */ }
}
