/** LAND-GATE-REACH v0: portable, versioned input for gate test selection.
 * A producer may use changed files, import reach, and spawn lanes. Consumers only
 * add these tests to their existing selection; this document is not gate evidence. */
import { readFileSync } from 'node:fs';
export interface GateScenario {
  version: 1;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  selectedTests: { path: string; reasons: ('changed' | 'import' | 'spawn')[] }[];
  /** Selection reach only. Each changed path records all three lane investigations, including empty results.
   * `measured` is never a gate result or introduced=0 evidence. */
  coverage: {
    status: 'measured' | 'unmeasured';
    unmeasured: string[];
    reach: { path: string; changed: string[]; import: string[]; spawn: string[]; unmeasured: string[] }[];
  };
}

const sha = /^[0-9a-f]{40}$/;
const testPath = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const reasons = new Set(['changed', 'import', 'spawn']);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]): boolean =>
  Object.keys(value).sort().join('\0') === expected.sort().join('\0');
const safePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && !value.startsWith('/') && !value.startsWith('-') && !value.includes('\\') && !/[\x00-\x1f\x7f]/.test(value)
  && !value.split('/').some((part) => part === '' || part === '.' || part === '..');

/** Reject schema drift, unsafe paths, stale heads/diffs, and incomplete measurements before execution. */
export function parseGateScenario(input: unknown, expected: { baseSha: string; headSha: string; changedFiles: readonly string[] }): GateScenario {
  const fail = (reason: string): never => { throw new Error(`gate scenario invalid: ${reason}`); };
  if (!record(input)) throw new Error('gate scenario invalid: schema');
  if (!keys(input, ['version', 'baseSha', 'headSha', 'changedFiles', 'selectedTests', 'coverage'])) fail('schema');
  // The exact keys are known; validate every value below before returning this view.
  const raw = input as unknown as GateScenario;
  if (raw.version !== 1) fail('version');
  if (typeof raw.baseSha !== 'string' || !sha.test(raw.baseSha) || typeof raw.headSha !== 'string' || !sha.test(raw.headSha)) fail('sha');
  if (raw.baseSha !== expected.baseSha || raw.headSha !== expected.headSha) fail('stale head/base');
  if (!Array.isArray(raw.changedFiles) || !raw.changedFiles.every(safePath) || new Set(raw.changedFiles).size !== raw.changedFiles.length) fail('changed files');
  if (raw.changedFiles.slice().sort().join('\0') !== [...new Set(expected.changedFiles)].sort().join('\0')) fail('changed file mismatch');
  if (!Array.isArray(raw.selectedTests)) fail('selected tests');
  const seen = new Set<string>();
  for (const item of raw.selectedTests) {
    if (!record(item) || !keys(item, ['path', 'reasons']) || !safePath(item.path) || !testPath.test(item.path)) fail('test path');
    if (seen.has(item.path)) fail('duplicate test');
    seen.add(item.path);
    if (!Array.isArray(item.reasons) || item.reasons.length === 0 || !item.reasons.every((r: unknown) => typeof r === 'string' && reasons.has(r))
      || new Set(item.reasons).size !== item.reasons.length) fail('test reasons');
    if (item.reasons.includes('changed') && !raw.changedFiles.includes(item.path)) fail('changed reason mismatch');
  }
  if (!record(raw.coverage) || !keys(raw.coverage, ['status', 'unmeasured', 'reach'])
    || !['measured', 'unmeasured'].includes(String(raw.coverage.status))
    || !Array.isArray(raw.coverage.unmeasured) || !raw.coverage.unmeasured.every((x: unknown) => typeof x === 'string' && x.length > 0)) fail('coverage');
  if (!Array.isArray(raw.coverage.reach) || raw.coverage.reach.length !== raw.changedFiles.length) fail('reach incomplete');
  const reachPaths = new Set<string>();
  const reached = new Map<string, Set<string>>();
  for (const entry of raw.coverage.reach) {
    if (!record(entry) || !keys(entry, ['path', 'changed', 'import', 'spawn', 'unmeasured'])
      || !safePath(entry.path) || !raw.changedFiles.includes(entry.path) || reachPaths.has(entry.path)) fail('reach path');
    reachPaths.add(entry.path);
    if (!Array.isArray(entry.unmeasured) || !entry.unmeasured.every((x: unknown) => typeof x === 'string' && x.length > 0)) fail('reach unmeasured');
    if (entry.unmeasured.length > 0) fail(`unmeasured reach: ${entry.path}`);
    for (const lane of ['changed', 'import', 'spawn'] as const) {
      const paths = entry[lane];
      if (!Array.isArray(paths) || !paths.every((path: unknown) => safePath(path) && testPath.test(path))
        || new Set(paths).size !== paths.length) fail(`reach ${lane}`);
      if (lane === 'changed' && paths.some((path: string) => path !== entry.path)) fail('changed reach mismatch');
      for (const path of paths) {
        const laneSet = reached.get(path) ?? new Set<string>();
        laneSet.add(lane);
        reached.set(path, laneSet);
      }
    }
  }
  if (reachPaths.size !== raw.changedFiles.length) fail('reach incomplete');
  if (reached.size !== raw.selectedTests.length || raw.selectedTests.some((item: { path: string; reasons: string[] }) =>
    item.reasons.slice().sort().join('\0') !== [...(reached.get(item.path) ?? [])].sort().join('\0'))) fail('selected tests do not match reach');
  if (raw.coverage.status !== 'measured' || raw.coverage.unmeasured.length > 0) fail('unmeasured coverage');
  return raw;
}

export function readGateScenarioFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
