// ── Seat knowhow packs — RFC-seat-knowhow-packs-adaptive-knowledge-2026-10-11.md §A ──
//
// Loader for `내부 문서 `KNOWHOW`` v2 items plus the role charter
// `내부 문서 `<자리>``. Replaces the two duplicate role-file reads inside
// seat-loop.ts (gatherSeatInputs + inquire) — one loader, no 4,000-char cut
// on the charter, one overall budget cap instead.
//
// Injection rules (§A3 ⊕ review must-fix 1):
//   «사실»          = status active ⊕ last verification «참» ⊕ within half-life
//   «참고(검증 안 됨)» = unproven / unverifiable(못잼) / expired half-life
//   dropped          = any status outside active/unproven/unverifiable,
//                     last verification «거짓»/future/invalid date,
//                     상태 미선언 · 검증 미선언 — a card is injected
//                     only with an explicit 상태 AND an explicit 검증 line;
//                     a missing 상태 is never assumed to be `active`.
//
// Half-life (§A1): fact 14 · warning 30 · heuristic 90 · playbook 60 days,
// case unlimited; kind defaults to fact when a card does not declare one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { KNOWHOW_HALF_LIFE_DAYS, seatKnowhowCards, type KnowhowKind } from '../kit/knowhow/index.js';

// The card grammar (split · 상태 · 종류 · 검증) lives in kit/knowhow — this module keeps the seat pack policy only.
export type { KnowhowKind } from '../kit/knowhow/index.js';
export { KNOWHOW_HALF_LIFE_DAYS } from '../kit/knowhow/index.js';

/** One overall budget cap for the whole injected pack (RFC §A3 — value
 * unspecified in the ask; 32,000 chars adopted as the documented value for
 * this slice, replacing the old per-chunk 4,000-char cuts).
 *
 * Budget policy (review must-fix 3) — whole items only, `text.slice` is never
 * used: the charter, each block header, and each card enter the pack whole or
 * not at all.
 *   1. The charter is always kept whole and outranks every card.
 *   2. Cards are appended whole in top-k order while the running total stays
 *      within this cap; a card that would exceed it is skipped (a later,
 *      smaller card may still fit).
 *   3. A charter that alone exceeds the cap is still injected whole and both
 *      card blocks are dropped entirely — the seat keeps its charter; slicing
 *      the charter mid-way is exactly what this policy abolishes. */
export const SEAT_PACK_TOTAL_BUDGET_CHARS = 32_000;
export const DEFAULT_TOP_K = 8;

export interface KnowhowItem {
  kind: KnowhowKind;
  /** Declared 상태 — '' when the card states none (never assumed active). */
  status: string;
  verifiedAt: Date | null;
  /** true = 참 · false = 거짓 · null = 못잼/unproven */
  verified: boolean | null;
  text: string;
}

export interface SeatPack {
  charter: string;
  /** Card texts actually injected into `text` — never a superset of it. */
  facts: string[];
  refs: string[];
  /** Cards refused by classification (contradicted·stale·superseded·거짓·
   *  상태/검증 미선언). Cards skipped only by the budget are not counted. */
  dropped: number;
  text: string;
}

export interface SeatPackDeps {
  repo?: string;
  read?: (path: string) => string;
  now?: () => Date;
  topK?: number;
}

/** Seat cards via kit/knowhow (`K-<seat>-<N>` only — sub-track cards such as `K-OP-PR-01` are not seat pack cards). */
export function parseKnowhowItems(body: string, seat: string): KnowhowItem[] {
  return seatKnowhowCards(body, seat).map((card) => ({
    kind: card.kind,
    // Missing 상태 stays '' — the classifier refuses to inject it (must-fix 1).
    status: card.status,
    verifiedAt: card.verifiedAt,
    verified: card.verified,
    text: card.text,
  }));
}

function withinHalfLife(item: KnowhowItem, now: Date): boolean {
  if (!item.verifiedAt) return false;
  const ageMs = now.getTime() - item.verifiedAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return false;
  const days = KNOWHOW_HALF_LIFE_DAYS[item.kind];
  if (!Number.isFinite(days)) return true;
  return ageMs <= days * 24 * 60 * 60 * 1000;
}

/** «사실» vs «참고(검증 안 됨)» vs dropped(contradicted·stale·superseded·최근
 * 검증 거짓·상태/검증 미선언). Only active/unproven/unverifiable are admitted;
 * a future or invalid verification date is rejected. A card is injected only when it declares an
 * explicit 상태 AND an explicit 검증 line; a card whose most recent
 * verification is «거짓» is contradicted — dropped, never filed as
 * «검증 안 됨» (review must-fix 1). */
export function splitKnowhow(
  items: KnowhowItem[],
  now: Date,
): { facts: KnowhowItem[]; refs: KnowhowItem[]; dropped: number } {
  const facts: KnowhowItem[] = [];
  const refs: KnowhowItem[] = [];
  let dropped = 0;
  for (const item of items) {
    const allowedStatus = item.status === 'active' || item.status === 'unproven' || item.status === 'unverifiable';
    const verifiedAtMs = item.verifiedAt?.getTime();
    const lacksExplicitConditions = !Number.isFinite(verifiedAtMs) || item.verified === false
      || verifiedAtMs! > now.getTime();
    if (!allowedStatus || lacksExplicitConditions) {
      dropped += 1;
      continue;
    }
    if (item.verified === true && item.status === 'active' && withinHalfLife(item, now)) {
      facts.push(item);
    } else {
      refs.push(item);
    }
  }
  return { facts, refs, dropped };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0);
}

/** Top-k by word overlap with the query (default k = 8). Ties keep pack order. */
export function selectTopK(items: KnowhowItem[], query: string, k: number = DEFAULT_TOP_K): KnowhowItem[] {
  const tokens = new Set(tokenize(query));
  const scored = items.map((item, index) => {
    const itemTokens = new Set(tokenize(item.text));
    let score = 0;
    for (const token of itemTokens) if (tokens.has(token)) score += 1;
    return { item, score, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, Math.max(0, k)).map((s) => s.item);
}

/** Assemble the pack under SEAT_PACK_TOTAL_BUDGET_CHARS at whole-item
 * granularity — see the policy on the constant. The `facts`/`refs` arrays in
 * the result carry exactly the cards that made it into `text`. */
function assemblePack(
  charter: string,
  rankedItems: KnowhowItem[],
  factSet: ReadonlySet<KnowhowItem>,
): { text: string; facts: string[]; refs: string[] } {
  const SEP = '\n\n';
  let used = charter.length;
  const facts: string[] = [];
  const refs: string[] = [];
  // Budget in query rank order; rendering can still group facts before refs.
  for (const item of rankedItems) {
    const isFact = factSet.has(item);
    const out = isFact ? facts : refs;
    const header = isFact ? '### 사실 (검증된 노하우)' : '### 참고 (검증 안 됨)';
    const cost = out.length === 0
      ? (used > 0 ? SEP.length : 0) + header.length + SEP.length + item.text.length
      : SEP.length + item.text.length;
    if (used + cost > SEAT_PACK_TOTAL_BUDGET_CHARS) continue;
    out.push(item.text);
    used += cost;
  }
  let text = charter;
  if (facts.length > 0) text += `${text ? SEP : ''}### 사실 (검증된 노하우)${SEP}${facts.join(SEP)}`;
  if (refs.length > 0) text += `${text ? SEP : ''}### 참고 (검증 안 됨)${SEP}${refs.join(SEP)}`;
  return { text, facts, refs };
}

export function loadSeatPack(seat: string, query = '', deps: SeatPackDeps = {}): SeatPack {
  const repo = deps.repo ?? process.cwd();
  const read = deps.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const now = deps.now ?? (() => new Date());
  const charter = read(join(repo, 'docs', 'roles', `${seat}.md`)).trim();
  const knowhowPath = join(repo, 'docs', 'roles', seat, 'KNOWHOW.md');
  // NOTE: presence is decided by reading through `deps.read`, not existsSync —
  // tests mount a virtual reader; a disk probe would report the virtual path
  // missing and silently drop the whole KNOWHOW pack (observed: facts=0).
  let knowhowBody = '';
  try {
    knowhowBody = read(knowhowPath);
  } catch {
    knowhowBody = '';
  }
  const items = parseKnowhowItems(knowhowBody, seat);
  const { facts, refs, dropped } = splitKnowhow(items, now());
  const topK = deps.topK ?? DEFAULT_TOP_K;
  // One top-k pass over the whole candidate pool (facts ⊕ refs), then the
  // winners are split back into their blocks in score order — applying k per
  // block would inject up to 2k cards (review must-fix 2).
  const selected = selectTopK([...facts, ...refs], query, topK);
  const factSet = new Set(facts);
  const pack = assemblePack(charter, selected, factSet);
  debug.log('seat.loop', 'pack-loaded', {
    seat,
    facts: pack.facts.length,
    refs: pack.refs.length,
    dropped,
  });
  return { charter, facts: pack.facts, refs: pack.refs, dropped, text: pack.text };
}
