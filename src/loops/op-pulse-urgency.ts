// OP-PULSE burst entry — three triggers (CEO 11-25 20:2x «진입 계기 3종: 마감 예측 · 수요 급증 · 대표 긴급»).
//
//   deadline  — forecast(): the current digestion rate misses a deadline → smallest 2h/4h/8h preset that closes it
//               (proposal · OP decides)
//   demand    — demandSurge(): new P0/urgent cells or CEO requirements per hour far above baseline, many concurrent
//               active requirements, or the ready backlog growing fast → the pulse fires at once (not on the beat) and
//               re-forecasts; a proposal follows only when current capacity cannot absorb it
//   ceo       — a crown-directive mail carrying the STRUCTURED urgency field (`eln msg post --crown-directive <id>
//               --urgency urgent|all-in` → ref `urgency:<level>`). Never a regex on prose. all-in → immediate max burst
//               (8h · bottleneck chains to max · cloud still budget/card gated) · urgent → 4h proposal OP starts at once.
//               The CEO line id rides the burst state and its receipt.

export type Urgency = 'normal' | 'urgent' | 'all-in';
export const URGENCIES: readonly Urgency[] = ['normal', 'urgent', 'all-in'];

export function parseUrgency(raw: string): Urgency {
  const v = raw.trim().toLowerCase();
  if (!URGENCIES.includes(v as Urgency)) throw new Error(`--urgency must be normal | urgent | all-in (got ${raw})`);
  return v as Urgency;
}

/** The urgency field of a mail (its `urgency:<level>` ref); null when the mail carries none. */
export function urgencyOf(refs: readonly string[] | null | undefined): Urgency | null {
  for (const r of refs ?? []) if (r.startsWith('urgency:')) { try { return parseUrgency(r.slice(8)); } catch { return null; } }
  return null;
}

export interface CeoLine { msgId: number; crownDirective: string; urgency: Urgency; at: string }

/** Crown-directive mails with urgent/all-in newer than `sinceIso` (the strongest first, then newest). */
export function urgentCeoLines(mails: ReadonlyArray<{ id: number; crownDirective?: string | null; refs?: readonly string[] | null; createdAt: string }>, sinceIso: string | null): CeoLine[] {
  const since = sinceIso ? Date.parse(sinceIso) : -Infinity;
  return mails.flatMap(m => {
    const u = urgencyOf(m.refs);
    if (!m.crownDirective || !u || u === 'normal' || Date.parse(m.createdAt) <= since) return [];
    return [{ msgId: m.id, crownDirective: m.crownDirective, urgency: u, at: m.createdAt }];
  }).sort((a, b) => (a.urgency === b.urgency ? b.msgId - a.msgId : a.urgency === 'all-in' ? -1 : 1));
}

export interface DemandSignals {
  newP0PerH: number | null;
  baselineP0PerH: number | null;
  activeRequirements: number | null;
  readyBacklogGrowthPerH: number | null;
}

export interface DemandThresholds { surgeRatio: number; minNewPerH: number; activeRequirementsMax: number; backlogGrowthPerHMax: number }
export const DEFAULT_DEMAND: DemandThresholds = { surgeRatio: 3, minNewPerH: 4, activeRequirementsMax: 6, backlogGrowthPerHMax: 10 };

export function demandSurge(s: DemandSignals, t: DemandThresholds = DEFAULT_DEMAND): { surge: boolean; evidence: string } {
  const why: string[] = [];
  if (s.newP0PerH !== null && s.newP0PerH >= t.minNewPerH && s.newP0PerH >= t.surgeRatio * Math.max(1, s.baselineP0PerH ?? 0))
    why.push(`new P0/urgent ${s.newP0PerH}/h vs baseline ${s.baselineP0PerH ?? '?'}/h`);
  if (s.activeRequirements !== null && s.activeRequirements > t.activeRequirementsMax) why.push(`${s.activeRequirements} concurrent CEO requirements > ${t.activeRequirementsMax}`);
  if (s.readyBacklogGrowthPerH !== null && s.readyBacklogGrowthPerH > t.backlogGrowthPerHMax) why.push(`ready backlog +${s.readyBacklogGrowthPerH}/h > ${t.backlogGrowthPerHMax}`);
  return { surge: why.length > 0, evidence: why.join(' · ') || 'no demand surge' };
}

export type BurstEntry =
  | { trigger: 'ceo-all-in'; preset: '8h'; start: 'now'; allIn: true; ceoLine: CeoLine; why: string }
  | { trigger: 'ceo-urgent'; preset: '4h'; start: 'op-now'; allIn: false; ceoLine: CeoLine; why: string }
  | { trigger: 'demand-surge' | 'deadline'; preset: '2h' | '4h' | '8h'; start: 'propose'; allIn: false; why: string };

/**
 * Which entry wins this pulse (CEO all-in > CEO urgent > demand surge that the forecast says cannot be absorbed > deadline).
 * `forecastPreset` = the preset the forecast picked (null = no shortfall). A surge without a shortfall is not a burst.
 */
export function burstEntry(input: { ceoLines: readonly CeoLine[]; demand: { surge: boolean; evidence: string }; forecastPreset: '2h' | '4h' | '8h' | null; forecastWhy: string; burstActive: boolean }): BurstEntry | null {
  const top = input.ceoLines[0];
  if (top?.urgency === 'all-in') return { trigger: 'ceo-all-in', preset: '8h', start: 'now', allIn: true, ceoLine: top, why: `CEO all-in (crown ${top.crownDirective} · msg #${top.msgId})` };
  if (input.burstActive) return null;
  if (top?.urgency === 'urgent') return { trigger: 'ceo-urgent', preset: '4h', start: 'op-now', allIn: false, ceoLine: top, why: `CEO urgent (crown ${top.crownDirective} · msg #${top.msgId})` };
  if (input.demand.surge && input.forecastPreset) return { trigger: 'demand-surge', preset: input.forecastPreset, start: 'propose', allIn: false, why: `${input.demand.evidence} · ${input.forecastWhy}` };
  if (input.forecastPreset) return { trigger: 'deadline', preset: input.forecastPreset, start: 'propose', allIn: false, why: input.forecastWhy };
  return null;
}
