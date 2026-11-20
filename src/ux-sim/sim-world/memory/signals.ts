// Memory sim devices ④⑤⑥ (SIM-WORLD-MEMORY · signals) — the signal → collector → seat-key path of
// 내부 문서 `MEMORY-SIGNALS` («시그널 ≠ 기억 · 확인·교정·반복된 것만 기억»). Pure and deterministic: ids and times come
// from the injected clock (D7), no randomness, no wall clock, no product imports.
//   ④ SignalGenerator  — TA / tab / harness result-envelope shaped signals; a repeated shape or a one-off; origin count settable.
//   ⑤ reduceSignals    — the collector's reduce step: dedupe by eventId, count per (tenant, universe, signature), distinct origins,
//                        confidence (no LLM). Candidate only when count ≥ 3 inside one hour AND origins ≥ 2 (MEMORY-SIGNALS §3-2).
//   ⑥ seat key         — `seat:<SEAT>` is one els identity; a seat reads only its own space (MEMORY-SIGNALS §4-3).
import type { MemoryClock } from './store.js';

export type SignalKind = 'ta' | 'tab' | 'harness';
export type SignalOutcome = 'ok' | 'fail' | 'refused' | 'timeout';
/** MEMORY-SIGNALS §2-1: { eventId, kind, at, origin, subject, outcome, signature, refs } plus tenant/universe for the key. */
export interface SignalEnvelope {
  readonly eventId: string; readonly kind: SignalKind; readonly at: string; readonly tenant: string; readonly universe: 'sim' | 'real';
  readonly origin: string; readonly subject: string; readonly outcome: SignalOutcome; readonly signature: string;
  readonly refs: readonly string[];
}
export interface RepeatSpec { signature: string; count: number; origins: number; kind?: SignalKind; outcome?: SignalOutcome; spanMs?: number; subject?: string }

const ORIGIN_PREFIX: Readonly<Record<SignalKind, string>> = { ta: 'run', tab: 'pane', harness: 'child' };

export class SignalGenerator {
  private seq = 0;
  constructor(private readonly clock: MemoryClock & { advance(ms: number): void }, private readonly tenant = 't-x') {}

  /** One signal that never repeats. */
  once(signature: string, over: Partial<Pick<RepeatSpec, 'kind' | 'outcome' | 'subject'>> & { origin?: string } = {}): SignalEnvelope {
    const kind = over.kind ?? 'ta';
    return this.make(kind, signature, over.origin ?? `${ORIGIN_PREFIX[kind]}-1`, over.outcome ?? 'fail', over.subject ?? signature);
  }
  /** `count` signals of the same signature spread over `spanMs` (default 10 min), round-robin over `origins` distinct origins. */
  repeat(spec: RepeatSpec): SignalEnvelope[] {
    if (!(spec.count >= 1) || !(spec.origins >= 1)) throw new Error('repeat needs count ≥ 1 and origins ≥ 1');
    const kind = spec.kind ?? 'ta';
    const gap = spec.count > 1 ? Math.floor((spec.spanMs ?? 600_000) / (spec.count - 1)) : 0;
    const out: SignalEnvelope[] = [];
    for (let i = 0; i < spec.count; i++) {
      out.push(this.make(kind, spec.signature, `${ORIGIN_PREFIX[kind]}-${(i % spec.origins) + 1}`, spec.outcome ?? 'fail', spec.subject ?? spec.signature));
      if (i < spec.count - 1) this.clock.advance(gap);
    }
    return out;
  }
  private make(kind: SignalKind, signature: string, origin: string, outcome: SignalOutcome, subject: string): SignalEnvelope {
    this.seq++;
    return { eventId: `sig-${this.seq}`, kind, at: new Date(this.clock.now()).toISOString(), tenant: this.tenant, universe: 'sim',
      origin, subject, outcome, signature, refs: [] };
  }
}

export interface CandidateFact {
  readonly key: string; readonly count: number; readonly distinctOrigins: number; readonly firstAt: string; readonly lastAt: string;
  readonly evidence: readonly string[]; readonly confidence: number; readonly candidate: boolean; readonly why: string;
}
export const COLLECT_MIN_COUNT = 3;
export const COLLECT_WINDOW_MS = 3_600_000;
export const COLLECT_MIN_ORIGINS = 2;

/** Collector reduce: same eventId twice counts once; key = tenant|universe|signature; confidence is rounded to 2 decimals. */
export function reduceSignals(signals: readonly SignalEnvelope[]): CandidateFact[] {
  const seen = new Set<string>();
  const groups = new Map<string, SignalEnvelope[]>();
  for (const signal of signals) {
    if (seen.has(signal.eventId)) continue;
    seen.add(signal.eventId);
    const key = `${signal.tenant}|${signal.universe}|${signal.signature}`;
    groups.set(key, [...(groups.get(key) ?? []), signal]);
  }
  return [...groups].map(([key, group]) => {
    const sorted = [...group].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.eventId.localeCompare(b.eventId));
    const origins = new Set(sorted.map(signal => signal.origin)).size;
    const times = sorted.map(signal => Date.parse(signal.at));
    const dense = times.some((start, i) => times.slice(i).filter(t => t - start < COLLECT_WINDOW_MS).length >= COLLECT_MIN_COUNT);
    const contradicted = sorted.some(signal => signal.outcome === 'ok') && sorted.some(signal => signal.outcome !== 'ok');
    const confidence = Math.round(Math.min(1, Math.log1p(origins) / Math.log(6)) * (contradicted ? 0.5 : 1) * 100) / 100;
    const why = sorted.length < COLLECT_MIN_COUNT ? 'count-below-3' : !dense ? 'not-within-1h' : origins < COLLECT_MIN_ORIGINS ? 'single-origin' : 'repeated';
    return { key, count: sorted.length, distinctOrigins: origins, firstAt: sorted[0]!.at, lastAt: sorted.at(-1)!.at,
      evidence: sorted.slice(0, 20).map(signal => signal.eventId), confidence, candidate: why === 'repeated', why };
  });
}

// ── ⑥ seat key ──────────────────────────────────────────────────────────────────────────────────────────────────────
const SEAT_IDENTITY = /^[A-Z][A-Z0-9-]{1,15}$/;
export interface SeatKey { readonly namespace: 'seat'; readonly id: string }
/** A seat key is {namespace:'seat', id:<one els identity>}; `seat:<SEAT>` is display/doc notation only. A list, wildcard,
 *  lower-case name or an opaque pane-owner token is not an identity, so the key carries the seat name and nothing else. */
export function seatKey(identity: string): SeatKey {
  if (!SEAT_IDENTITY.test(identity)) throw new Error('seat key needs exactly one els identity');
  return { namespace: 'seat', id: identity };
}
export const seatDisplay = (key: SeatKey): string => `${key.namespace}:${key.id}`;
/** Storage id for D17: the store's id rule (no «:») stays untouched, so namespace and id are joined with a dot. */
export const seatStoreId = (key: SeatKey): string => `${key.namespace}.${key.id}`;
