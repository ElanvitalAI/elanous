// RES-POLICY-GUARDIAN — shadow comparison: guardian «would decide» vs the RES tab's actual call (LOOP-AGENTS §2 rule 10).
//
// When the RES tab records a decision (`eln res shadow record`), the guardian's policy decision for the same request is
// written next to it with the same pairId, so the comparison never guesses which rows belong together.
// Retirement of the resident RES tab needs agreement ∧ samples (rule 10: 3 days ∧ 30 samples ∧ cross-seat verdict);
// the report prints the numbers, it does not decide.
import type { ResDecisionRow, ResourceLedgerEvent } from '../resource-ledger/resource-ledger.js';

export interface ShadowRow extends ResDecisionRow { readonly at: string }

export interface ShadowDisagreement {
  readonly pairId: string;
  readonly at: string;
  readonly action: string;
  readonly host: string;
  readonly guardian: string;
  readonly resTab: string;
  readonly rule: string;
  readonly ref?: string;
  /** Who took the actual decision (absent = the RES tab). */
  readonly actor?: string;
}

export interface ShadowReport {
  readonly since: string;
  readonly paired: number;
  readonly agreed: number;
  /** agreed / paired × 100, one decimal; null when nothing is paired. */
  readonly agreementPercent: number | null;
  readonly disagreements: readonly ShadowDisagreement[];
  /** Guardian decisions taken without asking the RES tab (in-policy, no RES row). */
  readonly guardianOnly: number;
  /** RES rows without a guardian twin (should be 0). */
  readonly resOnly: number;
  readonly days: number;
  readonly sampleTarget: number;
}

export function shadowRows(events: readonly ResourceLedgerEvent[]): ShadowRow[] {
  return events.flatMap((event) => event.event === 'res-decision' ? [{ ...event.row, at: event.at }] : []);
}

export function shadowReport(rows: readonly ShadowRow[], since: Date): ShadowReport {
  const window = rows.filter((row) => Date.parse(row.at) >= since.getTime());
  const byPair = new Map<string, { guardian?: ShadowRow; res?: ShadowRow }>();
  let guardianOnly = 0;
  for (const row of window) {
    if (!row.pairId) { if (row.source === 'guardian') guardianOnly += 1; continue; }
    const pair = byPair.get(row.pairId) ?? {};
    if (row.source === 'guardian') pair.guardian = row; else pair.res = row;
    byPair.set(row.pairId, pair);
  }
  let paired = 0, agreed = 0, resOnly = 0;
  const disagreements: ShadowDisagreement[] = [];
  const days = new Set<string>();
  for (const [pairId, pair] of byPair) {
    if (!pair.res) { guardianOnly += 1; continue; }
    if (!pair.guardian) { resOnly += 1; continue; }
    paired += 1;
    days.add(pair.res.at.slice(0, 10));
    if (pair.guardian.decision === pair.res.decision) { agreed += 1; continue; }
    disagreements.push({ pairId, at: pair.res.at, action: pair.res.action, host: pair.res.host,
      guardian: pair.guardian.decision, resTab: pair.res.decision, rule: pair.guardian.rule, ...(pair.res.ref ? { ref: pair.res.ref } : {}),
      ...(pair.res.actor ? { actor: pair.res.actor } : {}) });
  }
  return { since: since.toISOString(), paired, agreed,
    agreementPercent: paired === 0 ? null : Math.round((agreed / paired) * 1000) / 10,
    disagreements, guardianOnly, resOnly, days: days.size, sampleTarget: 30 };
}

export function formatShadowReport(report: ShadowReport): string {
  const head = `res shadow since ${report.since}: paired ${report.paired} · agreed ${report.agreed} · agreement ${report.agreementPercent === null ? 'n/a' : `${report.agreementPercent}%`}`
    + ` · guardian-only ${report.guardianOnly} · res-only ${report.resOnly} · samples ${report.paired}/${report.sampleTarget} · days ${report.days}/3`;
  const lines = report.disagreements.map((row) => `  ✗ ${row.at} ${row.action} ${row.host}: guardian=${row.guardian} res=${row.resTab}${row.actor ? `(${row.actor})` : ''} (rule ${row.rule}${row.ref ? ` · ${row.ref}` : ''})`);
  return [head, ...lines].join('\n');
}

// GUARDIAN-FINDINGS-VISIBLE ④ — acceptance for the dormant flip (대표 11-25 18:5x «--accept-min-samples 10»).
//   false-critical  = the guardian would have blocked (deny) what was actually allowed — it would have stopped real work.
//   missed-critical = the actual decision intervened (deny or ask) where the guardian would have allowed — RES acted
//                     where the guardian said nothing.
//   agreement       = agreed / paired ≥ 80%.
/** Source: 대표 11-25 18:5x «agreement ≥80%». */
export const SHADOW_ACCEPT_AGREEMENT_PERCENT = 80;

export interface ShadowAcceptance {
  readonly pass: boolean;
  readonly minSamples: number;
  readonly samples: number;
  readonly falseCritical: number;
  readonly missedCritical: number;
  readonly agreementPercent: number | null;
  readonly checks: ReadonlyArray<{ readonly name: string; readonly pass: boolean; readonly detail: string }>;
}

export function shadowAcceptance(report: ShadowReport, minSamples: number): ShadowAcceptance {
  const falseCritical = report.disagreements.filter((row) => row.guardian === 'deny' && row.resTab === 'allow').length;
  const missedCritical = report.disagreements.filter((row) => row.guardian === 'allow' && (row.resTab === 'deny' || row.resTab === 'ask')).length;
  const checks = [
    { name: 'samples', pass: report.paired >= minSamples, detail: `${report.paired}/${minSamples}` },
    { name: 'false-critical', pass: falseCritical === 0, detail: String(falseCritical) },
    { name: 'missed-critical', pass: missedCritical === 0, detail: String(missedCritical) },
    { name: 'agreement', pass: report.agreementPercent !== null && report.agreementPercent >= SHADOW_ACCEPT_AGREEMENT_PERCENT,
      detail: `${report.agreementPercent === null ? 'n/a' : `${report.agreementPercent}%`} ≥ ${SHADOW_ACCEPT_AGREEMENT_PERCENT}%` },
  ];
  return { pass: checks.every((check) => check.pass), minSamples, samples: report.paired, falseCritical, missedCritical,
    agreementPercent: report.agreementPercent, checks };
}

export function formatShadowAcceptance(acceptance: ShadowAcceptance): string {
  return `acceptance ${acceptance.pass ? 'PASS' : 'FAIL'} · ${acceptance.checks.map((check) => `${check.pass ? '✓' : '✗'} ${check.name} ${check.detail}`).join(' · ')}`;
}
