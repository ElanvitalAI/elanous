import { debug } from '../debug/log.js';

export interface AdoptionCandidate {
  readonly id: string;
  readonly grade: 'P1' | 'P2' | 'P3' | 'P4';
  readonly risk: number;
  readonly money: number;
  readonly security: number;
  readonly license: string | null;
  readonly touchesPatentCandidate: boolean;
}

export type AdoptShadowReason = 'grade' | 'risk' | 'money' | 'security' | 'license' | 'patent' | 'daily-cap';

export interface AdoptShadowVerdict {
  readonly id: string;
  readonly adopt: boolean;
  readonly reasons: readonly AdoptShadowReason[];
}

const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0',
]);

export function judgeAdoption(candidate: AdoptionCandidate, adoptedToday: number): AdoptShadowVerdict {
  const reasons: AdoptShadowReason[] = [];
  if (candidate.grade !== 'P1' && candidate.grade !== 'P2') reasons.push('grade');
  if (!(candidate.risk <= 1)) reasons.push('risk');
  if (candidate.money !== 0) reasons.push('money');
  if (candidate.security !== 0) reasons.push('security');
  if (candidate.license === null || !ALLOWED_LICENSES.has(candidate.license)) reasons.push('license');
  if (candidate.touchesPatentCandidate !== false) reasons.push('patent');
  if (!(adoptedToday < 5)) reasons.push('daily-cap');
  return { id: candidate.id, adopt: reasons.length === 0, reasons };
}

export function shadowAdopt(candidates: readonly AdoptionCandidate[]): AdoptShadowVerdict[] {
  const verdicts: AdoptShadowVerdict[] = [];
  let adoptedToday = 0;
  for (const candidate of candidates) {
    const verdict = judgeAdoption(candidate, adoptedToday);
    if (verdict.adopt) adoptedToday++;
    verdicts.push(verdict);
    debug.log('intake.adopt', 'shadow-verdict', {
      id: verdict.id, adopt: verdict.adopt, reasons: verdict.reasons,
    });
  }
  return verdicts;
}
