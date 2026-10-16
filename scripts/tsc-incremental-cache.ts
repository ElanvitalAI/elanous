/** Opt-in compiler graph cache for an exclusive, stable remote gate checkout. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { normalizedDiagnosticSet } from './tsc-incremental-diagnostics.js';

export interface CachedTscRun { out: string; ran: boolean; why?: string; exitCode?: number }
type Reference = { schema: 1; key: string; out: string; exitCode: number; decision: boolean; head?: string };
export interface IncrementalCacheInput<T extends CachedTscRun> {
  cwd: string;
  base: string;
  head?: string;
  changed: ReadonlySet<string>;
  config: string;
  command: string;
  cacheDir: string;
  run: (command: string) => T;
  decision: (result: T) => boolean;
  log: (message: string) => void;
}

function compilerOutcome(result: CachedTscRun): 'clean' | 'diagnostics' | 'unmeasured' {
  if (!result.ran) return 'unmeasured';
  if (result.exitCode === 0) return 'clean';
  return result.exitCode === 1 || result.exitCode === 2 ? 'diagnostics' : 'unmeasured';
}

function equivalent<T extends CachedTscRun>(current: T, baseline: T, decide: (result: T) => boolean): boolean {
  const a = normalizedDiagnosticSet(current.out);
  const b = normalizedDiagnosticSet(baseline.out);
  return a !== null && a === b && compilerOutcome(current) !== 'unmeasured'
    && compilerOutcome(current) === compilerOutcome(baseline) && decide(current) === decide(baseline);
}

export function incrementalCacheKey(input: Pick<IncrementalCacheInput<CachedTscRun>, 'cwd' | 'base' | 'changed' | 'config'>): string {
  const files = [input.config, 'tsconfig.json', 'tsconfig.gate.json', 'tsconfig.pwa-env.json', 'apps/pwa/tsconfig.json', 'bun.lock', 'node_modules/typescript/package.json'];
  const hash = createHash('sha256');
  for (const field of [hostname(), input.cwd, input.base, ...[...input.changed].sort()]) hash.update(field + '\0');
  for (const file of files) {
    hash.update(file + '\0');
    try { hash.update(readFileSync(join(input.cwd, file))); }
    catch { hash.update('<missing>'); }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** A cache hit is accepted only when the prior cold reference still has the same diagnostic set and gate decision. */
export function runIncrementalCachedTsc<T extends CachedTscRun>(input: IncrementalCacheInput<T>): T {
  if (!isAbsolute(input.cacheDir) || !/^[-\w./]+$/.test(input.cacheDir) || !/^[0-9a-f]{40}$/.test(input.base)) return input.run(input.command);
  const key = incrementalCacheKey(input);
  try { mkdirSync(input.cacheDir, { recursive: true, mode: 0o700 }); }
  catch (cause) {
    input.log(`[tsc-cache] unavailable key=${key.slice(0, 12)} reason=${cause instanceof Error ? cause.message : String(cause)}; cold`);
    return input.run(input.command);
  }
  const buildInfo = join(input.cacheDir, `${key}.tsbuildinfo`);
  const metaFile = join(input.cacheDir, `${key}.json`);
  let reference: Reference | null = null;
  try {
    const parsed = JSON.parse(readFileSync(metaFile, 'utf8')) as Reference;
    if (parsed.schema === 1 && parsed.key === key && typeof parsed.out === 'string'
      && Number.isInteger(parsed.exitCode) && typeof parsed.decision === 'boolean' && existsSync(buildInfo)) reference = parsed;
  } catch { /* missing or damaged cache is a cold miss */ }
  const incremental = input.run(`${input.command} --incremental --tsBuildInfoFile '${buildInfo}'`);
  const prior = reference ? { out: reference.out, ran: true, exitCode: reference.exitCode } as T : null;
  if (prior && equivalent(incremental, prior, input.decision) && input.decision(prior) === reference!.decision) {
    input.log(`[tsc-cache] hit key=${key.slice(0, 12)} warmRc=${incremental.exitCode} coldRc=${prior.exitCode} warmGate=${input.decision(incremental) ? 'PASS' : 'FAIL'} coldGate=${reference!.decision ? 'PASS' : 'FAIL'}`);
    return incremental;
  }
  const cold = input.run(input.command);
  const matched = equivalent(incremental, cold, input.decision);
  input.log(`[tsc-cache] ${reference ? 'mismatch-cold' : 'miss-cold'} key=${key.slice(0, 12)} warmRc=${incremental.exitCode ?? 'unknown'} coldRc=${cold.exitCode ?? 'unknown'} warmGate=${incremental.ran ? input.decision(incremental) ? 'PASS' : 'FAIL' : 'unmeasured'} coldGate=${cold.ran ? input.decision(cold) ? 'PASS' : 'FAIL' : 'unmeasured'} normalized=${matched ? 'same' : 'different'}`);
  if (matched && cold.exitCode !== undefined) {
    const next: Reference = { schema: 1, key, out: cold.out, exitCode: cold.exitCode, decision: input.decision(cold), head: input.head };
    const temp = `${metaFile}.${process.pid}.tmp`;
    try { writeFileSync(temp, JSON.stringify(next), { mode: 0o600 }); renameSync(temp, metaFile); }
    catch {
      for (const path of [temp, metaFile, buildInfo]) { try { rmSync(path, { force: true }); } catch { /* next run must cold-check damaged cache */ } }
    }
  } else {
    for (const path of [metaFile, buildInfo]) { try { rmSync(path, { force: true }); } catch { /* invalid metadata remains a cold miss */ } }
  }
  return cold;
}
