/** Observation only: compare a proposed import radius with the full gate that actually ran. */
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { changedFilesBetween, planPartialRegate, testFileOfId } from './gate-partial';
import { gitClosureTree, testsReachingChanged } from './gate-closure';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';

const SHA = /^[0-9a-f]{40}$/i;
const VERSION = /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/;
const TEST = /\.test\.(?:tsx?|jsx?|mts|cts)$/;
const BUMP_FILES = new Set(['package.json', 'server.json', 'integrations/acp-registry/elanous/agent.json', 'bun.lock']);

export interface GateRadiusShadowPlan {
  schema: 1;
  version: string;
  priorCommit: string | null;
  forCommit: string;
  proposed: 'partial' | 'full';
  files: string[];
  totalTests: number | null;
  reason: string;
}

export interface GateRadiusShadowRecord {
  plan: GateRadiusShadowPlan;
  actual: { commit: string; outcome: 'ok' | 'regression' | 'error'; cutRc: number | null; introduced: string[];
    cutFailures: string[]; cutErrors: string[]; missedIntroduced: string[]; fullSweep: boolean;
    comparison: 'complete' | 'unmeasured' };
  recordedAt: string;
}

function blob(repo: string, commit: string, file: string): unknown {
  const run = spawnSync('git', ['show', `${commit}:${file}`], { cwd: repo, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  if (run.status !== 0 || run.error) throw new Error(`unreadable release blob ${file}`);
  return JSON.parse(run.stdout);
}

/** Remove only the fields version-node itself changes; any other JSON difference leaves a full shadow plan. */
function versionOnlyBumps(repo: string, from: string, to: string, version: string, changed: readonly string[]): string[] {
  if (!changed.includes('package.json')) return [];
  const prior = blob(repo, from, 'package.json') as Record<string, unknown>;
  const next = blob(repo, to, 'package.json') as Record<string, unknown>;
  if (typeof prior.version !== 'string' || prior.version === version || next.version !== version) return [];
  const inert: string[] = [];
  for (const file of changed.filter((name) => BUMP_FILES.has(name))) {
    const left = blob(repo, from, file) as Record<string, any>;
    const right = blob(repo, to, file) as Record<string, any>;
    const normalize = (row: Record<string, any>, expected: string): boolean => {
      if (file === 'package.json') { if (row.version !== expected) return false; row.version = '<version>'; }
      else if (file === 'server.json') {
        if (row.version !== expected || row.packages?.[0]?.version !== expected) return false;
        row.version = '<version>'; row.packages[0].version = '<version>';
      } else if (file.endsWith('/agent.json')) {
        if (row.version !== expected || row.distribution?.npx?.package !== `elanous@${expected}`) return false;
        row.version = '<version>'; row.distribution.npx.package = 'elanous@<version>';
      } else {
        if (row.workspaces?.['']?.version !== expected) return false;
        row.workspaces[''].version = '<version>';
      }
      return true;
    };
    if (normalize(left, prior.version) && normalize(right, version) && JSON.stringify(left) === JSON.stringify(right)) inert.push(file);
  }
  return inert;
}

export function planGateRadiusShadow(input: { repo: string; ledgerRoot: string; version: string;
  baselineVersion: string; forCommit: string; instanceRoot?: string; expectedBaselineCommit?: string }): GateRadiusShadowPlan {
  const { repo, ledgerRoot, version, baselineVersion, forCommit } = input;
  const full = (reason: string, priorCommit: string | null = null, totalTests: number | null = null): GateRadiusShadowPlan =>
    ({ schema: 1, version, priorCommit, forCommit, proposed: 'full', files: [], totalTests, reason });
  if (!VERSION.test(version) || !VERSION.test(baselineVersion) || !SHA.test(forCommit)) return full('invalid identity');
  try {
    const priorDir = join(ledgerRoot, 'release', baselineVersion);
    const verdict = JSON.parse(readFileSync(join(priorDir, 'gate-verdict.json'), 'utf8')) as { commit?: string; outcome?: string };
    const failures = JSON.parse(readFileSync(join(priorDir, 'gate-failures.json'), 'utf8')) as
      { commit?: string; failures?: string[]; errors?: string[] };
    const priorCommit = verdict.commit;
    const manifestPaths = [...new Set([ledgerRoot, input.instanceRoot].filter((root): root is string => !!root))]
      .map((root) => join(root, 'release', baselineVersion, 'release.json')).filter(existsSync);
    if (!manifestPaths.length) return full('prior release manifest absent', priorCommit ?? null);
    const manifestCommits = manifestPaths.map((path) =>
      (JSON.parse(readFileSync(path, 'utf8')) as { sourceCommit?: unknown }).sourceCommit);
    if (manifestCommits.some((commit) => typeof commit !== 'string' || !SHA.test(commit) || commit !== priorCommit)
      || (input.expectedBaselineCommit && input.expectedBaselineCommit !== priorCommit))
      return full('prior gate commit differs from release source', priorCommit ?? null);
    if (!priorCommit || !SHA.test(priorCommit) || failures.commit !== priorCommit || verdict.outcome !== 'ok'
      || !Array.isArray(failures.failures) || !Array.isArray(failures.errors ?? []))
      return full('prior gate evidence absent or not clean', priorCommit ?? null);
    const tree = gitClosureTree(repo, forCommit);
    const tests = tree.files.filter((file) => TEST.test(file));
    const changed = changedFilesBetween(repo, priorCommit, forCommit);
    const bump = versionOnlyBumps(repo, priorCommit, forCommit, version, changed);
    const effective = changed.filter((file) => !bump.includes(file));
    if (!effective.length && bump.length) {
      const rerun = [...new Set([...failures.failures, ...(failures.errors ?? [])].map(testFileOfId))].sort();
      if (rerun.some((file) => !tests.includes(file))) return full('prior failure file absent at cut', priorCommit, tests.length);
      return { schema: 1, version, priorCommit, forCommit, proposed: 'partial', files: rerun,
        totalTests: tests.length, reason: 'version-only candidate' };
    }
    const result = planPartialRegate({ version, priorCommit, forCommit, changedFiles: effective,
      priorFailures: failures.failures, priorErrors: failures.errors ?? [],
      existsAtTip: (file) => tree.files.includes(file),
      closure: (code) => testsReachingChanged(tree, code, tests) });
    if (!result.ok) return full(result.reason, priorCommit, tests.length);
    // Shadow only: this proposal is never passed to writePartialPlan/readPartialPlan or the sweep selector.
    return { schema: 1, version, priorCommit, forCommit, proposed: 'partial', files: result.plan.files,
      totalTests: tests.length, reason: result.plan.kind === 'carry' ? 'zero-file candidate' : 'import radius candidate' };
  } catch (error) { return full(`shadow evidence unreadable: ${String(error)}`); }
}

/** Append beside the gate verdict; a shadow write never changes a release decision. */
export function writeGateRadiusShadow(root: string, record: GateRadiusShadowRecord): string {
  const { plan, actual } = record;
  if (!VERSION.test(plan.version) || !SHA.test(plan.forCommit) || actual.commit !== plan.forCommit
    || !['ok', 'regression', 'error'].includes(actual.outcome)) throw new Error('invalid gate radius shadow');
  const path = join(root, 'release', plan.version, `gate-radius-shadow-${plan.forCommit}-${randomUUID()}.json`);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    linkSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
  return path;
}

export function shadowActual(input: { plan: GateRadiusShadowPlan; outcome: 'ok' | 'regression' | 'error';
  introduced: readonly string[]; cutFailures: readonly string[]; cutErrors: readonly string[]; cutRc: number | null;
  fullSweep: boolean }): GateRadiusShadowRecord['actual'] {
  const selected = new Set(input.plan.files);
  const missedIntroduced = input.plan.proposed === 'partial' && input.fullSweep
    ? input.introduced.filter((id) => { try { return !selected.has(testFileOfId(id)); } catch { return true; } }) : [];
  return { commit: input.plan.forCommit, outcome: input.outcome, cutRc: input.cutRc, introduced: [...input.introduced],
    cutFailures: [...input.cutFailures], cutErrors: [...input.cutErrors], missedIntroduced, fullSweep: input.fullSweep,
    comparison: input.fullSweep ? 'complete' : 'unmeasured' };
}
