import { testFileOfId } from './gate-partial.js';

const SHA = /^[0-9a-f]{40}$/i;

/** Validate a cut-to-root first-parent chain and return (base, cut] in execution order. */
export function firstParentCommitsBetween(cutToRoot: readonly string[], baseCommit: string, cutCommit: string):
  { ok: true; commits: string[] } | { ok: false; reason: string } {
  if (!SHA.test(baseCommit) || !SHA.test(cutCommit) || cutToRoot[0] !== cutCommit ||
      cutToRoot.some((commit) => !SHA.test(commit)) || new Set(cutToRoot).size !== cutToRoot.length)
    return { ok: false, reason: 'invalid first-parent chain' };
  const baseIndex = cutToRoot.indexOf(baseCommit);
  if (baseIndex <= 0) return { ok: false, reason: 'baseline is not a first-parent ancestor of cut' };
  return { ok: true, commits: [...cutToRoot.slice(0, baseIndex)].reverse() };
}

export interface GateBisectPlan {
  kind: 'bisect';
  version: string;
  baseCommit: string;
  cutCommit: string;
  /** First-parent commits after base through cut, in execution order. */
  commits: string[];
  files: string[];
  introducedIds: string[];
  host: string;
}

export function planGateBisect(input: {
  version: string; baseCommit: string; cutCommit: string; firstParentCommits: readonly string[];
  introducedIds: readonly string[]; basePass: boolean; cutFail: boolean; host: string;
}): { ok: true; plan: GateBisectPlan } | { ok: false; reason: string } {
  if (!/^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(input.version)) return { ok: false, reason: 'invalid release version' };
  if (!SHA.test(input.baseCommit) || !SHA.test(input.cutCommit) || input.baseCommit === input.cutCommit) return { ok: false, reason: 'invalid base/cut commit range' };
  if (!input.basePass || !input.cutFail) return { ok: false, reason: 'bisect requires passing base and failing cut measurements' };
  if (input.firstParentCommits.length === 0 || input.firstParentCommits.at(-1) !== input.cutCommit ||
      input.firstParentCommits.some((commit) => !SHA.test(commit)) || new Set(input.firstParentCommits).size !== input.firstParentCommits.length ||
      input.firstParentCommits.includes(input.baseCommit)) return { ok: false, reason: 'invalid first-parent commit list' };
  if (!['mshq', 'node-c', 'aws1', 'gcp1'].includes(input.host))
    return { ok: false, reason: 'bisect requires an eligible non-gate host' };
  let files: string[];
  try { files = [...new Set(input.introducedIds.map(testFileOfId))].sort(); }
  catch (error) { return { ok: false, reason: String(error instanceof Error ? error.message : error) }; }
  if (!files.length) return { ok: false, reason: 'no introduced test files' };
  return { ok: true, plan: { kind: 'bisect', version: input.version, baseCommit: input.baseCommit, cutCommit: input.cutCommit,
    commits: [...input.firstParentCommits], files, introducedIds: [...new Set(input.introducedIds)].sort(), host: input.host } };
}

export interface GateBisectCursor { low: number; high: number; }

/** Return the next first-parent midpoint. Index 0 is the verified passing base; commits[0] is index 1. */
export function nextGateBisectCommit(commits: readonly string[], cursor: GateBisectCursor): string | null {
  if (!commits.length || !Number.isSafeInteger(cursor.low) || !Number.isSafeInteger(cursor.high) ||
      cursor.low < 0 || cursor.high > commits.length || cursor.high <= cursor.low) throw new Error('invalid bisect cursor');
  if (cursor.high - cursor.low <= 1) return null;
  return commits[Math.floor((cursor.low + cursor.high) / 2) - 1] ?? null;
}

export function advanceGateBisectCursor(cursor: GateBisectCursor, commits: readonly string[], failed: boolean): GateBisectCursor {
  const next = nextGateBisectCommit(commits, cursor);
  if (!next) throw new Error('bisect cursor is already complete');
  const midpoint = commits.indexOf(next) + 1;
  return failed ? { low: cursor.low, high: midpoint } : { low: midpoint, high: cursor.high };
}

export function foundGateBisectCommit(commits: readonly string[], cursor: GateBisectCursor): string | null {
  return cursor.high - cursor.low === 1 ? (cursor.high === 0 ? null : commits[cursor.high - 1] ?? null) : null;
}

export type GateBisectMeasurement = 'pass' | 'fail' | 'unmeasured';
export interface GateBisectFinding { file: string; firstFailingCommit: string; probes: number; }

/** Execute the deterministic commit bisect. Unmeasured results stop that file instead of being guessed as pass/fail. */
export async function runGateBisect(plan: GateBisectPlan, measure: (file: string, commit: string, host: string) => Promise<GateBisectMeasurement>,
  onStep: (event: { file: string; commit: string; result: GateBisectMeasurement; host: string }) => void = () => {}): Promise<{
    findings: GateBisectFinding[]; unmeasured: Array<{ file: string; commit: string }>; } > {
  const findings: GateBisectFinding[] = [];
  const unmeasured: Array<{ file: string; commit: string }> = [];
  for (const file of plan.files) {
    const base = await measure(file, plan.baseCommit, plan.host);
    onStep({ file, commit: plan.baseCommit, result: base, host: plan.host });
    const cut = await measure(file, plan.cutCommit, plan.host);
    onStep({ file, commit: plan.cutCommit, result: cut, host: plan.host });
    if (base !== 'pass' || cut !== 'fail') {
      unmeasured.push({ file, commit: base !== 'pass' ? plan.baseCommit : plan.cutCommit });
      continue;
    }
    let cursor: GateBisectCursor = { low: 0, high: plan.commits.length };
    let probes = 0;
    while (true) {
      const commit = nextGateBisectCommit(plan.commits, cursor);
      if (!commit) break;
      const result = await measure(file, commit, plan.host);
      onStep({ file, commit, result, host: plan.host });
      if (result === 'unmeasured') { unmeasured.push({ file, commit }); break; }
      probes++;
      cursor = advanceGateBisectCursor(cursor, plan.commits, result === 'fail');
    }
    if (!unmeasured.some((item) => item.file === file)) {
      const found = foundGateBisectCommit(plan.commits, cursor);
      if (found) findings.push({ file, firstFailingCommit: found, probes });
      else unmeasured.push({ file, commit: plan.cutCommit });
    }
  }
  return { findings, unmeasured };
}

export interface ShadowOperationalState { mode: 'shadow' | 'operational'; agreements: number; }

/** Agreement is counted only when shadow and operational decisions are both measured and equal. */
export function advanceGateBisectMode(state: ShadowOperationalState, shadow: string | null, operational: string | null,
  requiredAgreements = 3): { state: ShadowOperationalState; event: 'shadow' | 'transition' | 'operational' | 'unmeasured' } {
  if (!Number.isSafeInteger(requiredAgreements) || requiredAgreements < 1) throw new Error('invalid shadow agreement threshold');
  if (state.mode === 'operational') return { state, event: 'operational' };
  if (shadow === null || operational === null) return { state: { ...state, agreements: 0 }, event: 'unmeasured' };
  if (shadow !== operational) return { state: { ...state, agreements: 0 }, event: 'shadow' };
  const agreements = state.agreements + 1;
  if (agreements >= requiredAgreements) return { state: { mode: 'operational', agreements }, event: 'transition' };
  return { state: { mode: 'shadow', agreements }, event: 'shadow' };
}

/** Reference decision used while shadowing: scan the first-parent chain in order and stop at the first failing commit. */
export async function runGateBisectLinear(plan: GateBisectPlan,
  measure: (file: string, commit: string, host: string) => Promise<GateBisectMeasurement>,
  onStep: (event: { file: string; commit: string; result: GateBisectMeasurement; host: string }) => void = () => {}): Promise<{
    findings: GateBisectFinding[]; unmeasured: Array<{ file: string; commit: string }>; }> {
  const findings: GateBisectFinding[] = [];
  const unmeasured: Array<{ file: string; commit: string }> = [];
  for (const file of plan.files) {
    const base = await measure(file, plan.baseCommit, plan.host);
    onStep({ file, commit: plan.baseCommit, result: base, host: plan.host });
    if (base !== 'pass') { unmeasured.push({ file, commit: plan.baseCommit }); continue; }
    const cut = await measure(file, plan.cutCommit, plan.host);
    onStep({ file, commit: plan.cutCommit, result: cut, host: plan.host });
    if (cut !== 'fail') { unmeasured.push({ file, commit: plan.cutCommit }); continue; }
    let found: string | null = null;
    for (const commit of plan.commits) {
      const result = await measure(file, commit, plan.host);
      onStep({ file, commit, result, host: plan.host });
      if (result === 'unmeasured') { unmeasured.push({ file, commit }); break; }
      if (result === 'fail') { found = commit; break; }
    }
    if (found) findings.push({ file, firstFailingCommit: found, probes: plan.commits.indexOf(found) + 1 });
    else if (!unmeasured.some((item) => item.file === file)) unmeasured.push({ file, commit: plan.cutCommit });
  }
  return { findings, unmeasured };
}
