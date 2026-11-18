/** A cause is reported only when an OS error or an explicit probe measured it. */
export type PrebuildFailureCode = 'DISK_FULL' | 'STATE_DIR_MISSING' | 'MIRROR_PARTIAL' | 'PACK_MISSING_PWA' | 'REGISTRY_ABSENT';
export interface PrebuildFailureEvidence {
  readonly stage: string;
  readonly exit?: number | null;
  readonly reason?: string;
  readonly osErrorCode?: string;
  readonly stateDirExists?: boolean;
  readonly mirrorComplete?: boolean;
  readonly packagePwaPresent?: boolean;
  readonly registryPresent?: boolean;
}

/** Absence of a probe is unknown. The full list prevents a second observed failure being hidden by precedence. */
export function classifyPrebuildFailure(evidence: PrebuildFailureEvidence): { code: PrebuildFailureCode | 'UNKNOWN'; causes: PrebuildFailureCode[] } {
  const causes: PrebuildFailureCode[] = [];
  if (evidence.osErrorCode === 'ENOSPC') causes.push('DISK_FULL');
  if (evidence.stateDirExists === false) causes.push('STATE_DIR_MISSING');
  if (evidence.mirrorComplete === false) causes.push('MIRROR_PARTIAL');
  if (evidence.packagePwaPresent === false) causes.push('PACK_MISSING_PWA');
  if (evidence.registryPresent === false) causes.push('REGISTRY_ABSENT');
  return { code: causes[0] ?? 'UNKNOWN', causes };
}
