// GET /v1/ops/seats?date=YYYY-MM-DD — one row per seat: latest channel line, PRs landed that day, red items, open decisions.
// A source that could not be read is null, never 0 («못 읽음» ≠ «없음»). Contract: 내부 문서 `DESIGN-ops3-seat-board-and-public-demo-2026-10-02` §1.
import { debug, redactSecretText } from '../../debug/log.js';
import type { ChecklistItem } from '../../release-loop/checklist.js';
import { canonicalSeatId } from '../../msg/msg-store.js';

export const SEATS = [
  { seat: 'OP', role: 'COO' }, { seat: 'TC', role: 'CTO' }, { seat: 'MK', role: 'CMO' }, { seat: 'UX', role: 'CXO' },
] as const;
export const SEATS_CACHE_MS = 60_000;

export interface ChannelComment { body: string; createdAt: string }
export interface MergedPr { number: number; title: string; body: string; mergedAt: string }
export interface SeatsSources {
  /** Coordination-channel comments created on `date` (KST) or later; null when unreadable. */
  channel(date: string): Promise<ChannelComment[] | null>;
  /** PRs merged on `date` (KST); null when unreadable. */
  merged(date: string): Promise<MergedPr[] | null>;
  /** Checklist items of the version being worked on (counts, red) and of every version known (id → owner). */
  checklist(): { current: ChecklistItem[]; all: ChecklistItem[] } | null;
  /** `raisedBy.agent` of every open decision. */
  openDecisionRaisers(): string[] | null;
}

export interface SeatRow {
  seat: string; role: string;
  now: { text: string; at: string } | null;
  landed: Array<{ pr: number; title: string; at: string; checklistId: string | null }> | null;
  blocked: Array<{ id: string; title: string; status: 'red' }> | null;
  pendingDecisions: number | null;
  checklist: { green: number; yellow: number; red: number; done: number } | null;
}

function seatOf(value: string | undefined): string | null {
  if (!value) return null;
  try { return canonicalSeatId(value); } catch { return null; }
}

const clip = (text: string, max: number) => redactSecretText(text).slice(0, max);

/** First checklist id that appears as a whole word in the title, else in the body. */
function checklistIdOf(pr: MergedPr, ids: string[]): string | null {
  for (const text of [pr.title, pr.body]) {
    const found = ids.map((id) => ({ id, at: text.search(new RegExp(`(?<![A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`)) }))
      .filter((hit) => hit.at >= 0).sort((a, b) => a.at - b.at || b.id.length - a.id.length);
    if (found.length) return found[0]!.id;
  }
  return null;
}

export async function buildSeatsBoard(date: string, sources: SeatsSources): Promise<{ date: string; seats: SeatRow[] }> {
  const [channel, merged] = await Promise.all([
    sources.channel(date).catch(() => null), sources.merged(date).catch(() => null),
  ]);
  let checklist: ReturnType<SeatsSources['checklist']> = null;
  try { checklist = sources.checklist(); } catch { checklist = null; }
  let raisers: string[] | null = null;
  try { raisers = sources.openDecisionRaisers(); } catch { raisers = null; }

  const owners = new Map<string, string>();
  for (const item of checklist?.all ?? []) { const seat = seatOf(item.owner); if (seat) owners.set(item.id, seat); }
  const ids = [...owners.keys()];
  const landedBySeat = new Map<string, NonNullable<SeatRow['landed']>>();
  for (const pr of merged ?? []) {
    const id = checklistIdOf(pr, ids);
    const seat = id ? owners.get(id) : undefined;
    if (!seat) continue; // ⛔ not by commit author — every seat lands through the same account.
    landedBySeat.set(seat, [...(landedBySeat.get(seat) ?? []), { pr: pr.number, title: clip(pr.title, 80), at: pr.mergedAt, checklistId: id }]);
  }

  const seats = SEATS.map(({ seat, role }): SeatRow => {
    const latest = channel?.filter((c) => c.body.trimStart().startsWith(`**[${seat}]**`)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const mine = checklist?.current.filter((item) => seatOf(item.owner) === seat);
    return {
      seat, role,
      now: latest ? { text: clip(latest.body.trimStart().split('\n')[0]!, 120), at: latest.createdAt } : null,
      landed: merged === null || checklist === null ? null : (landedBySeat.get(seat) ?? []).sort((a, b) => a.at.localeCompare(b.at)),
      blocked: mine ? mine.filter((item) => item.status === 'red').map((item) => ({ id: item.id, title: clip(item.title, 80), status: 'red' as const })) : null,
      pendingDecisions: raisers === null ? null : raisers.filter((agent) => seatOf(agent) === seat).length,
      checklist: mine ? {
        green: mine.filter((i) => i.status === 'green').length, yellow: mine.filter((i) => i.status === 'yellow').length,
        red: mine.filter((i) => i.status === 'red').length, done: mine.filter((i) => i.status === 'done').length,
      } : null,
    };
  });
  debug.log('ops.seats', 'built', {
    date, channel: channel === null ? 'unreadable' : channel.length, merged: merged === null ? 'unreadable' : merged.length,
    checklist: checklist !== null, decisions: raisers !== null,
  });
  return { date, seats };
}

/** KST calendar day → [start, end) in UTC ISO. */
export function kstDayRange(date: string): { start: string; end: string } {
  const start = new Date(`${date}T00:00:00+09:00`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
}

export function todayKst(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(now);
}

/** One snapshot per date for 60 s; concurrent requests share one build. */
export function createSeatsCache(sources: SeatsSources, now: () => number = Date.now, ttlMs = SEATS_CACHE_MS) {
  const slots = new Map<string, { at: number; value: Promise<{ date: string; seats: SeatRow[] }> }>();
  return (date: string) => {
    const slot = slots.get(date);
    if (slot && now() - slot.at < ttlMs) return slot.value;
    const value = buildSeatsBoard(date, sources);
    slots.set(date, { at: now(), value });
    value.catch(() => slots.delete(date));
    return value;
  };
}
