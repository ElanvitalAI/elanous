// Land graph read model — the metrics one land tick leaves (ledger rows · tick decisions · finisher book · open PRs). Any loop
// agent on the `land-graph.tick` kind reads them through agent.yaml `kpis[].from: kpi.<field>` (CODE-BODY-TO-KIND · the
// thresholds, breach lines and their routing are YAML · src/loop-agent/v3/kpi-voice.ts). Pure: `now` is passed in.
import type { FinishBook } from './finisher.js';
import type { LedgerRow, PrInfo, TickResult } from './land-graph.js';
import { ageMin, HOUR_MS, inRange, inWindow, median } from '../kit/kpi/index.js';

export interface LandMetrics {
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

/** `now` = the measurement time (taken AFTER the body tick) · `today` = since local midnight of `now` · rows dated after `now` never count. */
export function landMetrics(i: { rows: readonly LedgerRow[]; tick: Pick<TickResult, 'decisions' | 'ready'>; book: FinishBook; prs: readonly PrInfo[]; now: Date }): LandMetrics {
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
