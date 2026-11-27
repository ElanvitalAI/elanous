// 착지 집사 — KPI card (goal.yaml kpi) measured from the body's own records: ledger rows · tick result · finisher book.
import type { FinishBook } from '../land-graph/finisher.js';
import type { LedgerRow, PrInfo, TickResult } from '../land-graph/land-graph.js';
import type { StewardGoal } from './memory.js';
import { ageMin, HOUR_MS, inRange, inWindow, median, pct } from '../kit/kpi/index.js';

export interface Kpi {
  landsLastHour: number;
  landsToday: number;
  ready: number;
  judged: number;
  landableRatio: number | null;
  needsFinisherWaitP50Min: number | null;
  needsFinisherOpen: number;
  refusalsWithoutNext: number[];
  waitingForSlot: number;
}
export interface Breach { key: 'lands' | 'landable' | 'finisher-wait' | 'no-next'; line: string }


/** `now` = the measurement time (taken AFTER the body tick) · `today` = since local midnight of `now` · rows dated after `now` never count. */
export function measure(i: { rows: readonly LedgerRow[]; tick: Pick<TickResult, 'decisions' | 'ready'>; book: FinishBook; prs: readonly PrInfo[]; now: Date }): Kpi {
  const nowMs = i.now.getTime();
  const real = i.rows.filter(r => !r.synthetic);
  const landed = real.filter(r => r.event === 'landed');
  const midnight = new Date(i.now); midnight.setHours(0, 0, 0, 0);
  const judged = i.tick.decisions.length;
  const ready = i.tick.ready ?? i.tick.decisions.filter(d => d.action === 'land').length;
  // needs-finisher wait: ONE entry per open PR head that is still not landable this tick (a head the body now lands is
  // resolved) — a running finisher job or a needs-finisher card on that head, aged from the earliest of the two.
  const heads = new Map(i.prs.map(p => [p.number, p.head] as const));
  const pending = new Set(i.tick.decisions.filter(d => d.action !== 'land').map(d => `${d.pr}@${d.head}`));
  const since = new Map<string, number>();
  const note = (pr: number, head: string, at: string) => {
    const k = `${pr}@${head}`; const t = Date.parse(at);
    if (heads.get(pr) !== head || !pending.has(k) || !Number.isFinite(t)) return;
    since.set(k, Math.min(since.get(k) ?? t, t));
  };
  for (const j of Object.values(i.book.jobs)) if (j.state === 'running' || j.state === 'resolving') note(j.pr, j.head, j.at); // resolving = SMART-MERGE LLM capsule
  for (const r of real) if (r.event === 'card' && r.cls === 'needs-finisher') note(r.pr, r.head, r.at);
  const waits = [...since.values()].map(t => ageMin(t, nowMs)!); // clamp: a clock-skewed future start is 0, not negative
  return {
    landsLastHour: landed.filter(r => inWindow(r.doneAt ?? r.at, nowMs, HOUR_MS)).length,
    landsToday: landed.filter(r => inRange(r.doneAt ?? r.at, midnight.getTime(), nowMs)).length,
    ready, judged, landableRatio: judged ? ready / judged : null, // raw — judged raw, rounded only for display
    needsFinisherWaitP50Min: median(waits),
    needsFinisherOpen: waits.length,
    refusalsWithoutNext: i.tick.decisions.filter(d => d.action !== 'land' && !d.next).map(d => d.pr),
    waitingForSlot: i.tick.decisions.filter(d => d.action === 'wait' && /^slots \d+ full/.test(d.why)).length,
  };
}

export function breaches(k: Kpi, goal: StewardGoal): Breach[] {
  const g = goal.kpi; const out: Breach[] = [];
  if (k.landsLastHour < g.lands_per_hour_min) out.push({ key: 'lands', line: `착지 ${k.landsLastHour}/h < ${g.lands_per_hour_min} (준비 ${k.ready} · 슬롯 대기 ${k.waitingForSlot})` });
  if (k.landableRatio !== null && k.landableRatio < g.landable_ratio_min) out.push({ key: 'landable', line: `착지 가능 ${pct(k.landableRatio)} < ${pct(g.landable_ratio_min)} (${k.ready}/${k.judged})` });
  if (k.needsFinisherWaitP50Min !== null && k.needsFinisherWaitP50Min > g.needs_finisher_wait_p50_max_min) out.push({ key: 'finisher-wait', line: `마무리 대기 p50 ${Math.round(k.needsFinisherWaitP50Min)}분 > ${g.needs_finisher_wait_p50_max_min} (${k.needsFinisherOpen}건)` });
  if (k.refusalsWithoutNext.length > g.refusals_without_next_max) out.push({ key: 'no-next', line: `다음 행동 없는 거절 ${k.refusalsWithoutNext.length}건 (${k.refusalsWithoutNext.slice(0, 5).map(n => `#${n}`).join(' ')})` });
  return out;
}
