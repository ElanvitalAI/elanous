/**
 * BUS-SEAT-TURN (CEO 11-27 «제가 보내는 멘트는 모두 near 실시간으로 eln OP 도 알고 있나요?» · 11:0x «소화되지 않은 채 전달되면
 * 그것도 문제» · 11:1x «케이던스를 잘 조절해서 전달 · 원문은 기억에 남기고 조회되게») — the eln side of the OP context bus.
 *
 * S: #40283 built the bus (Claude OP posts every CEO line as `ceo-request`), but no eln seat turn read it: the digest
 *    was only printed by `eln bus digest`.
 * C: raw CEO words are CONTEXT ONLY (Claude OP digests them first); action comes only from digested items (handoff ·
 *    commitment · decision addressed to the seat, `--ref bus:<ceo id>`); wakes are coalesced (one per seat per 30 min ·
 *    `prio:P0` immediate · a raw line never wakes); the digest is bounded and never re-shows acked items; the raw words
 *    stay findable (surface_events ⊕ `eln bus search`).
 * Q: what does a seat turn carry from the bus, when does the bus wake a seat, and how is a CEO line recalled later?
 * A: `seatBusDigest` (pure over the read log) → one `<op_context_bus>` block per turn with «할 일(소화됨)» first, then
 *    «CEO 원문(맥락…)» (OP only), collapsed «처리됨», a few «참고» lines, «외 k건» counts and the OP-only «미소화 CEO 발화 n건»
 *    line (20 min+ without a disposition); the turn acks through `ackTo` after it completes. `createBusWakeGate` decides
 *    wakes. `recordCeoRequestMemory` persists a ceo-request into surface_events (text-deduped). `busSearch` finds words.
 *
 * 세 얼굴: 관측 = debug.log('bus', 'bus.seat-digest' | 'bus.seat-ack' | 'bus.wake' | 'bus.memory') ·
 *          인지 = seatBusDigest · busWakeKind · createBusWakeGate · busSearch (pure) ·
 *          수복과 인계 = fail-open everywhere (a broken bus never breaks a turn) · a missed raw line surfaces as «미소화» to OP.
 */
import type { BusItem, BusType } from './bus.js';
import { ackCursor, busAck, busSince, readAcks, readBus, BUS_DEFAULT_SPACE } from './bus.js';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { liveBusSpacesForSeat, type BusView, type SeatBusSpace } from './spaces.js';
import { MAIL_ROUTE_POLICY_DEFAULTS, mailBypassesWindow, readMailRoutePolicy, windowDue } from '../kit/mail-route/policy.js';

/** One bus-driven wake per seat per this window (CEO 11:1x) — the bus wake window — the default of the shared mail-route policy (KIT mail-route · one cadence for every fold). */
export const BUS_WAKE_WINDOW_MS = MAIL_ROUTE_POLICY_DEFAULTS.windowMs;
/** A raw CEO line with no disposition after this long is counted as «미소화» for OP. */
export const BUS_STALE_RAW_MS = 20 * 60_000;
/** The «미소화» count looks back this far (older lines are history, not a missed item). */
export const BUS_STALE_LOOKBACK_MS = 24 * 60 * 60_000;
export const BUS_DIGEST_MAX_TODO = 5;
export const BUS_DIGEST_MAX_RAW = 3;
export const BUS_DIGEST_MAX_OTHER = 3;
/** The seat that sees raw CEO words and the «미소화» line in the OP space (other seats see only items addressed to them there). */
export const BUS_COORDINATOR_SEAT = 'OP';
/** CONTEXT-BUS-FEDERATION — block bounds: graphs/policies/context-bus.yaml `digest` (own space block · every further block). */
export interface BusDigestPolicy { readonly ownMaxChars: number; readonly otherMaxChars: number }
export const contextBusPolicyPath = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'policies', 'context-bus.yaml');
/** Pure: pack text → bounds. Throws on a missing / non-positive key (never a silent default). */
export function parseBusDigestPolicy(text: string): BusDigestPolicy {
  const y = (parseYaml(text) ?? {}) as { version?: unknown; digest?: Record<string, unknown> };
  if (y.version !== 1) throw new Error('context-bus policy: version must be 1');
  const num = (k: string): number => {
    const v = y.digest?.[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error(`context-bus policy: digest.${k} must be a positive integer`);
    return v;
  };
  return { ownMaxChars: num('own_max_chars'), otherMaxChars: num('other_max_chars') };
}
export function loadBusDigestPolicy(path = contextBusPolicyPath()): BusDigestPolicy {
  return parseBusDigestPolicy(readFileSync(path, 'utf8'));
}

const DIGESTED: ReadonlySet<string> = new Set<BusType>(['handoff', 'commitment', 'decision']);
const up = (s: string): string => s.trim().toUpperCase();
const oneLine = (s: string, n: number): string => { const f = s.replace(/\s+/gu, ' ').trim(); return f.length <= n ? f : `${f.slice(0, n - 1)}…`; };

/** Is this item addressed to `seat` (owner, or a `seat:<SEAT>` ref)? */
export function addressedTo(item: BusItem, seat: string): boolean {
  const s = up(seat);
  return (item.owner !== undefined && up(item.owner) === s) || item.refs.some((r) => up(r) === `SEAT:${s}`);
}

/** Marked urgent: a `prio:P0` (or `urgent`) ref — the kit's P0 rule (P0 never waits for the window). */
export function isUrgent(item: BusItem): boolean {
  return mailBypassesWindow({ refs: item.refs });
}

export interface Disposition { readonly by: string; readonly handled: boolean }

/** For every raw ceo-request id: the digested item that references it (`bus:<id>`), the newest wins; handled = «handled-by». */
export function dispositions(items: readonly BusItem[]): Map<string, Disposition> {
  const out = new Map<string, Disposition>();
  for (const i of items) {
    if (!DIGESTED.has(i.type)) continue;
    const handled = i.type === 'decision' && /handled-by/iu.test(i.body);
    for (const r of i.refs) {
      if (!r.toLowerCase().startsWith('bus:')) continue;
      const prev = out.get(r.slice(4));
      // A «handled-by» decision is final; otherwise the newest reference stands.
      if (prev?.handled && !handled) continue;
      out.set(r.slice(4), { by: i.id, handled });
    }
  }
  return out;
}

export interface SeatDigestOptions {
  readonly seat: string;
  readonly now: number;
  /** Override the seat's ack cursor (tests). */
  readonly sinceId?: string | null;
  readonly maxChars?: number;
  /** CONTEXT-BUS-FEDERATION — full = every item of the space (its own space · HQ for coordinators) · addressed = only items
   *  addressed to the seat. Default: full for OP, addressed for everyone else (the OP space as it always was). */
  readonly view?: BusView;
}

export interface SeatDigest {
  /** The block for the turn (null = nothing to carry). */
  readonly text: string | null;
  /** Ack through this id after the turn completes (null = nothing new). Every fresh item is shown or counted. */
  readonly ackTo: string | null;
  readonly counts: { readonly todo: number; readonly raw: number; readonly handled: number; readonly other: number; readonly stale: number };
}

/** Pure: the seat's digest over the full log `items` and its `acks`-derived cursor. */
export function buildSeatDigest(items: readonly BusItem[], cursor: string | null, opts: SeatDigestOptions, space = BUS_DEFAULT_SPACE): SeatDigest {
  const seat = up(opts.seat);
  const coordinator = opts.view ? opts.view === 'full' : seat === BUS_COORDINATOR_SEAT;
  const disp = dispositions(items);
  const fresh = busSince(items, opts.sinceId !== undefined ? opts.sinceId : cursor);
  const newest = (a: BusItem, b: BusItem) => (a.id < b.id ? 1 : -1);

  const todo = fresh.filter((i) => DIGESTED.has(i.type) && addressedTo(i, seat))
    .sort((a, b) => Number(isUrgent(b)) - Number(isUrgent(a)) || newest(a, b));
  const rawAll = fresh.filter((i) => i.type === 'ceo-request');
  const raw = coordinator ? rawAll.filter((i) => !disp.has(i.id)).sort(newest) : [];
  const handled = coordinator ? rawAll.filter((i) => disp.has(i.id)).sort(newest) : [];
  const other = fresh.filter((i) => !(DIGESTED.has(i.type) && addressedTo(i, seat)) && i.type !== 'ceo-request')
    // An addressed view sees only what is addressed to it; nobody is shown its own writes back.
    .filter((i) => coordinator && up(i.from) !== seat).sort(newest);
  const staleFloor = opts.now - BUS_STALE_LOOKBACK_MS;
  const stale = coordinator
    ? items.filter((i) => i.type === 'ceo-request' && !disp.has(i.id) && opts.now - Date.parse(i.at) >= BUS_STALE_RAW_MS && Date.parse(i.at) >= staleFloor).length
    : 0;
  const counts = { todo: todo.length, raw: raw.length, handled: handled.length, other: other.length, stale };
  const ackTo = fresh.length ? fresh.reduce((m, i) => (i.id > m ? i.id : m), fresh[0]!.id) : null;
  if (todo.length + raw.length + handled.length + other.length === 0 && stale === 0) return { text: null, ackTo, counts };

  const max = opts.maxChars ?? 2400;
  const lines: string[] = [`<op_context_bus space="${space}" seat="${seat}" new="${fresh.length}">`];
  const more = (shown: number, total: number) => (total > shown ? [`  … 외 ${total - shown}건 (eln bus since ${cursor ?? '-'})`] : []);
  const refs = (i: BusItem) => (i.refs.length ? ` [${i.refs.slice(0, 4).join(' ')}]` : '');
  if (todo.length) {
    lines.push('할 일(소화됨):');
    for (const i of todo.slice(0, BUS_DIGEST_MAX_TODO)) {
      const extra = i.type === 'commitment' ? ` (owner ${i.owner ?? '?'}${i.due ? ` · due ${i.due}` : ''} · done when ${oneLine(i.doneWhen ?? '?', 80)})` : '';
      lines.push(`- ${isUrgent(i) ? 'P0 ' : ''}${i.id} ${i.type} ${i.from}${extra}: ${oneLine(i.body, 240)}${refs(i)}`);
    }
    lines.push(...more(BUS_DIGEST_MAX_TODO, todo.length));
  }
  if (raw.length) {
    lines.push('CEO 원문(맥락 · Claude OP 소화 중 — 이것만 보고 행동하지 말 것):');
    for (const i of raw.slice(0, BUS_DIGEST_MAX_RAW)) lines.push(`- ${i.id} @${i.source ?? '?'}${i.alsoFrom.length ? `+${i.alsoFrom.join('+')}` : ''}: ${oneLine(i.body, 300)}`);
    lines.push(...more(BUS_DIGEST_MAX_RAW, raw.length));
  }
  if (handled.length) {
    lines.push(`처리됨(접음 · 행동 불필요): ${handled.slice(0, 6).map((i) => `${i.id}→${disp.get(i.id)!.handled ? 'handled' : disp.get(i.id)!.by}`).join(' · ')}${handled.length > 6 ? ` … 외 ${handled.length - 6}건` : ''}`);
  }
  if (other.length) {
    lines.push('참고:');
    for (const i of other.slice(0, BUS_DIGEST_MAX_OTHER)) lines.push(`- ${i.id} ${i.type} ${i.from}${i.conflictsWith ? ` ⚠ conflicts ${i.conflictsWith}` : ''}: ${oneLine(i.body, 160)}${refs(i)}`);
    lines.push(...more(BUS_DIGEST_MAX_OTHER, other.length));
  }
  if (stale) lines.push(`미소화 CEO 발화 ${stale}건 (20분+ 처분 없음 · 지시 아님 · eln bus search / eln bus since)`);
  lines.push('</op_context_bus>');
  // Bound: drop body lines from the end of the middle (head, tail and the first section header stay).
  while (lines.join('\n').length > max && lines.length > 4) lines.splice(lines.length - 3, 1);
  return { text: lines.join('\n'), ackTo, counts };
}

/** Impure: read the bus and build this seat's digest. Fail-open (null text). */
export function seatBusDigest(stateRoot: string, opts: SeatDigestOptions, space = BUS_DEFAULT_SPACE): SeatDigest {
  try {
    const items = readBus(stateRoot, space);
    const d = buildSeatDigest(items, ackCursor(readAcks(stateRoot, space), opts.seat), opts, space);
    if (d.text) log('bus.seat-digest', { seat: up(opts.seat), space, ...d.counts, chars: d.text.length });
    return d;
  } catch (error) {
    log('bus.seat-digest-failed', { seat: opts.seat, error: String(error).slice(0, 160) });
    return { text: null, ackTo: null, counts: { todo: 0, raw: 0, handled: 0, other: 0, stale: 0 } };
  }
}

/** After the turn completed: advance the seat's cursor to the digest's last item. Fail-open. */
export function ackSeatDigest(stateRoot: string, seat: string, ackTo: string | null, space = BUS_DEFAULT_SPACE): boolean {
  if (!ackTo) return false;
  try { busAck(stateRoot, ackTo, seat, { space }); log('bus.seat-ack', { seat: up(seat), id: ackTo }); return true; }
  catch (error) { log('bus.seat-ack-failed', { seat, error: String(error).slice(0, 160) }); return false; }
}

export interface SeatSpacesDigest {
  /** The blocks joined (own space first) — null when no space has anything to carry. */
  readonly text: string | null;
  /** Per space: ack through `ackTo` after the turn completes. */
  readonly blocks: readonly { readonly space: string; readonly view: BusView; readonly ackTo: string | null; readonly text: string | null }[];
}

/**
 * CONTEXT-BUS-FEDERATION — every space the seat reads (own space · HQ for coordinators · OP for the rest, addressed only),
 * one `<op_context_bus>` block each, own space first. `spaces` overrides the org-map resolution (tests · sims). Fail-open.
 */
export function seatBusDigests(stateRoot: string, opts: SeatDigestOptions & { readonly spaces?: readonly SeatBusSpace[] }): SeatSpacesDigest {
  let spaces: readonly SeatBusSpace[];
  try { spaces = opts.spaces ?? liveBusSpacesForSeat(opts.seat); } catch { spaces = [{ space: BUS_DEFAULT_SPACE, view: up(opts.seat) === BUS_COORDINATOR_SEAT ? 'full' : 'addressed' }]; }
  let bounds: BusDigestPolicy | null = null;
  if (opts.maxChars === undefined) {
    try { bounds = loadBusDigestPolicy(); } catch (error) { log('bus.digest-policy-unreadable', { seat: opts.seat, error: String(error).slice(0, 160) }); return { text: null, blocks: [] }; }
  }
  const blocks = spaces.map((s, i) => {
    const d = seatBusDigest(stateRoot, { seat: opts.seat, now: opts.now, view: s.view,
      maxChars: opts.maxChars ?? (i === 0 ? bounds!.ownMaxChars : bounds!.otherMaxChars) }, s.space);
    return { space: s.space, view: s.view, ackTo: d.ackTo, text: d.text };
  });
  const texts = blocks.flatMap((b) => (b.text ? [b.text] : []));
  return { text: texts.length ? texts.join('\n') : null, blocks };
}

/** After the turn completed: advance the seat's cursor in every space it read. Fail-open; returns the spaces acked. */
export function ackSeatDigests(stateRoot: string, seat: string, d: SeatSpacesDigest): string[] {
  return d.blocks.filter((b) => ackSeatDigest(stateRoot, seat, b.ackTo, b.space)).map((b) => b.space);
}

/** Does this new item wake `seat`? urgent = now · normal = coalesced · null = context only (raw CEO words never wake). */
export function busWakeKind(item: BusItem, seat: string): 'urgent' | 'normal' | null {
  if (item.type === 'ceo-request' || item.type === 'rollup') return null;
  if (!addressedTo(item, seat)) return null;
  if (isUrgent(item)) return 'urgent';
  return item.type === 'handoff' || item.type === 'commitment' ? 'normal' : null;
}

export type BusWakeAction = { readonly action: 'wake'; readonly reason: 'urgent' | 'normal' | 'deferred' } | { readonly action: 'defer'; readonly dueAt: number } | { readonly action: 'none' };

export interface BusWakeGate {
  /** New items arrived (each id is judged once). */
  offer(items: readonly BusItem[], now: number): BusWakeAction;
  /** A deferred wake whose window has passed (call at `dueAt`). */
  due(now: number): BusWakeAction;
  /** A turn carried the digest: whatever was pending rode it. */
  delivered(): void;
}

/** One bus-driven wake per seat per `windowMs`; `prio:P0` wakes now; items in between ride the next digest. */
export function createBusWakeGate(seat: string, windowMs: number = readMailRoutePolicy().windowMs): BusWakeGate {
  const seen = new Set<string>();
  let lastWakeAt: number | null = null;
  let pending = false;
  const wake = (now: number, reason: 'urgent' | 'normal' | 'deferred'): BusWakeAction => { lastWakeAt = now; pending = false; log('bus.wake', { seat: up(seat), reason }); return { action: 'wake', reason }; };
  return {
    offer(items, now) {
      let urgent = false;
      let normal = false;
      for (const i of items) {
        if (seen.has(i.id)) continue;
        seen.add(i.id);
        const k = busWakeKind(i, seat);
        if (k === 'urgent') urgent = true;
        else if (k === 'normal') normal = true;
      }
      if (urgent) return wake(now, 'urgent');
      if (normal) {
        if (windowDue(lastWakeAt, now, windowMs)) return wake(now, 'normal');
        pending = true;
      }
      return pending && lastWakeAt !== null ? { action: 'defer', dueAt: lastWakeAt + windowMs } : { action: 'none' };
    },
    due(now) {
      if (!pending || lastWakeAt === null) return { action: 'none' };
      if (now - lastWakeAt < windowMs) return { action: 'defer', dueAt: lastWakeAt + windowMs };
      return wake(now, 'deferred');
    },
    delivered() { pending = false; },
  };
}

export interface BusSearchOptions { readonly query: string; readonly type?: string; readonly sinceIso?: string; readonly limit?: number }

/** Keyword search over the bus (every word must appear, case folded) — newest first. Pure. */
export function busSearch(items: readonly BusItem[], opts: BusSearchOptions): BusItem[] {
  const words = opts.query.normalize('NFKC').toLowerCase().split(/\s+/u).filter(Boolean);
  const since = opts.sinceIso ? Date.parse(opts.sinceIso) : NaN;
  return items.filter((i) => {
    if (opts.type && i.type !== opts.type) return false;
    if (Number.isFinite(since) && Date.parse(i.at) < since) return false;
    const hay = `${i.body} ${i.refs.join(' ')} ${i.from}`.normalize('NFKC').toLowerCase();
    return words.every((w) => hay.includes(w));
  }).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, opts.limit ?? 50);
}

type MemoryDb = import('bun:sqlite').Database;

/**
 * Persist a ceo-request into surface_events so `eln self recall` / `eln self utterances` find it. Deduped by text: a
 * row with the same words within a day (e.g. the hook's own `self utterance`) means it is already there. Fail-open.
 * Test runners never touch the production memory DB (same guard as recordInboundTurn).
 */
export function recordCeoRequestMemory(entry: BusItem | import('./bus.js').BusEntry, db?: MemoryDb): 'recorded' | 'duplicate' | 'skipped' {
  if (entry.type !== 'ceo-request') return 'skipped';
  try {
    const se = require('../domains/surface-events.js') as typeof import('../domains/surface-events.js');
    const testRunner = process.env.NODE_ENV === 'test' || process.env.BUN_TEST !== undefined;
    const own = db ?? (testRunner && !process.env.ELANOUS_STATE_DIR?.trim() ? null : se.openSurfaceEventsDb());
    if (!own) return 'skipped';
    try {
      const text = entry.body.trim();
      const from = new Date(Date.parse(entry.at) - 24 * 60 * 60_000).toISOString();
      const hit = ['events', 'signals'].some((t) => {
        try { return own.query(`SELECT 1 FROM ${t} WHERE trim(text) = ? AND ts >= ? LIMIT 1`).get(text, from) !== null; } catch { return false; }
      });
      if (hit) { log('bus.memory', { id: entry.id, result: 'duplicate' }); traceBusMemoryWrite(entry.id, 'duplicate'); return 'duplicate'; }
      se.recordEvent(own, {
        surface: entry.source ?? 'bus', direction: 'inbound', kind: 'utterance', category: 'utterance', domain: 'elanous',
        text, summary: text.slice(0, 150), importance: 6, ts: entry.at,
        refs: JSON.stringify({ origin: 'human', utteranceOrigin: 'human', bus: entry.id }), tags: 'origin:human ceo-request',
      });
      log('bus.memory', { id: entry.id, result: 'recorded' });
      traceBusMemoryWrite(entry.id, 'recorded');
      return 'recorded';
    } finally { if (!db) own.close(); }
  } catch (error) {
    log('bus.memory-failed', { id: entry.id, error: String(error).slice(0, 160) });
    return 'skipped';
  }
}

/** MEMORY-OBSERVABILITY — a CEO line persisted into the episodic store shows under `memory.write` too. */
function traceBusMemoryWrite(id: string, action: 'recorded' | 'duplicate'): void {
  try {
    (require('../seat-memory/memory-trace.js') as typeof import('../seat-memory/memory-trace.js'))
      .traceMemoryWrite({ store: 'surface-events', action, id, origin: 'bus' });
  } catch { /* fail-open */ }
}

function log(event: string, data: Record<string, unknown>): void {
  try { (require('../debug/log.js') as typeof import('../debug/log.js')).debug.log('bus', event, data); } catch { /* fail-open */ }
}
