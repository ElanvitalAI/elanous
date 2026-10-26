/** A hard rehearsal's immutable gate evidence may select the next release's cut tests, but never authorizes a carry. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { changedFilesBetween, planPartialRegate, testFileOfId, type PartialPlan } from './gate-partial.js';
import { CODE_FILE, gitClosureTree, testsReachingChanged } from './gate-closure.js';
import { versionOnlyBumps } from './gate-radius-shadow.js';
import { gateAssignableTestsAtCommit, gateBaselineReceipt, type GateBaselineReceipt } from './gate-baseline-receipt.js';
import { parsePodPool, remoteImageId } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import { podCommandImageFor } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';

const SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/i;
const TEST = /\.test\.(?:tsx?|jsx?|mts|cts)$/;

export function hardRehearsalGateVersion(version: string, runId: string): string {
  const id = /^hard-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(runId)?.[1];
  if (!/^\d+\.\d+\.\d+$/.test(version) || !id) throw new Error('invalid hard rehearsal gate identity');
  return `${version}-rc.${BigInt(`0x${id.replaceAll('-', '')}`).toString(10)}`;
}

export function hardRehearsalGateArgs(version: string, runId: string, commit: string, previous: string, pool: string): string[] {
  return ['scripts/release-loop/gate-node.ts', '--commit', commit, '--version', hardRehearsalGateVersion(version, runId),
    '--baseline-version', previous, '--executor', 'pod', '--pod-pool', pool, '--pod-shards', '12', '--rehearsal-baseline', '--json'];
}

export interface LiveRadiusDecision { plan: PartialPlan | null; reason: string; rehearsalRunId?: string }

/** Read the image ID on every candidate host before deciding. A later Job must still prove its actual image. */
export function preflightGateImageDigest(pool: string): string | null {
  try {
    const image = podCommandImageFor([], true);
    const members = parsePodPool(pool);
    if (!members.length) return null;
    const ids = members.map((member) => {
      if (member.sshHost) return remoteImageId(member, image);
      const result = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8', timeout: 30_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
      return result.status === 0 ? result.stdout.trim() : null;
    });
    return ids.every((id) => id && DIGEST.test(id) && id === ids[0]) ? ids[0]! : null;
  } catch { return null; }
}

/** The current sweep ID and exact root inventory prevent stale Pod logs from proving a new partial run's image. */
export function partialGateImagesMatch(root: string, version: string, digest: string, commit: string,
  sweep: { id: string; shards: number; files: readonly string[] } | undefined): boolean {
  if (!SHA.test(commit) || !sweep || !/^[0-9a-f-]{36}$/i.test(sweep.id)
    || !Number.isSafeInteger(sweep.shards) || sweep.shards < 1) return false;
  try {
    const dir = join(root, 'release', version, 'gate-logs', 'cut-partial');
    const names = readdirSync(dir).filter((name) => /^pod-\d+(?:-[\w-]+)?\.json$/.test(name));
    const allRows = names.map((name) => ({ name, ...JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
      commit?: string; sweepId?: string; shardCount?: number; files?: unknown; imageDigest?: string;
      attemptId?: string; parentAttempt?: string } }));
    const rows = allRows.filter((row) => row.sweepId === sweep.id);
    const roots = rows.filter((row) => /^pod-\d+\.json$/.test(row.name));
    if (roots.length !== sweep.shards || roots.some((row) => row.shardCount !== sweep.shards
      || row.commit !== commit || !Array.isArray(row.files) || !row.attemptId || row.imageDigest !== digest)) return false;
    if (allRows.some((row) => /^pod-\d+\.json$/.test(row.name)
      && row.commit === commit && row.sweepId !== sweep.id)) return false;
    if (allRows.some((row) => row.commit === commit && !row.sweepId)) return false;
    const indices = roots.map((row) => Number(/^pod-(\d+)\.json$/.exec(row.name)![1]));
    if (new Set(indices).size !== sweep.shards || indices.some((index) => index < 0 || index >= sweep.shards)) return false;
    const files = roots.flatMap((row) => row.files as string[]);
    if (files.some((file) => typeof file !== 'string')
      || JSON.stringify(files.sort()) !== JSON.stringify([...sweep.files].sort())) return false;
    const attempts = new Set(roots.map((row) => row.attemptId));
    let pending = allRows.filter((row) => !/^pod-\d+\.json$/.test(row.name));
    for (let count = 0; pending.length && count < allRows.length; count++) {
      const connected = pending.filter((row) => row.parentAttempt && attempts.has(row.parentAttempt));
      if (!connected.length) break;
      if (connected.some((row) => row.sweepId !== sweep.id || row.commit !== commit
        || !row.attemptId || row.imageDigest !== digest)) return false;
      for (const row of connected) attempts.add(row.attemptId);
      pending = pending.filter((row) => !connected.includes(row));
    }
    return !pending.some((row) => row.sweepId === sweep.id || (row.commit === commit && !row.sweepId));
  } catch { return false; }
}

/** Every missing or mismatched proof returns a full gate. The caller uses this only when no explicit resume plan exists. */
export function planHardRehearsalRadius(input: { root: string; repo: string; version: string; forCommit: string;
  graphPins: { graphSha: string; recipeSha: string } | null; envFingerprint: string;
  imageDigest: string | null }): LiveRadiusDecision {
  const full = (reason: string): LiveRadiusDecision => ({ plan: null, reason });
  if (!/^\d+\.\d+\.\d+$/.test(input.version) || !SHA.test(input.forCommit)) return full('invalid release identity');
  if (!input.graphPins || !/^[0-9a-f]{64}$/i.test(input.envFingerprint) || !input.imageDigest || !DIGEST.test(input.imageDigest))
    return full('current graph, environment or Pod image identity unmeasured');
  try {
    const stamps = ['hard-5h', 'hard-mid'].map((step) => {
      const path = join(input.root, 'release', input.version, 'rehearsal', `${step}.json`);
      if (!existsSync(path)) return null;
      const stamp = JSON.parse(readFileSync(path, 'utf8')) as {
        version?: string; step?: string; outcome?: string; sha?: string; endedAt?: string; hardGateRunId?: string;
        hardGate?: { commit?: string; executor?: string; outcome?: string; introduced?: unknown[] };
      };
      return { step, stamp, ended: Date.parse(stamp.endedAt ?? '') };
    }).filter((row): row is NonNullable<typeof row> => row !== null);
    if (!stamps.length) return full('no clean hard rehearsal receipt');
    if (stamps.some((row) => !Number.isFinite(row.ended))) return full('hard rehearsal completion time unmeasured');
    stamps.sort((a, b) => b.ended - a.ended);
    if (stamps.length > 1 && stamps[0]!.ended === stamps[1]!.ended) return full('hard rehearsal order ambiguous');
    for (const { step, stamp } of stamps.slice(0, 1)) {
      if (stamp.version !== input.version || stamp.step !== step || stamp.outcome !== 'ok' || !stamp.sha || !SHA.test(stamp.sha)
        || stamp.hardGate?.outcome !== 'ok' || stamp.hardGate.commit !== stamp.sha || stamp.hardGate.executor !== 'pod'
        || !Array.isArray(stamp.hardGate.introduced) || stamp.hardGate.introduced.length)
        return full('latest hard rehearsal is not clean');
      let gateVersion: string;
      try { gateVersion = hardRehearsalGateVersion(input.version, stamp.hardGateRunId ?? ''); }
      catch { return full('hard rehearsal run identity invalid'); }
      const dir = join(input.root, 'release', gateVersion);
      const verdict = JSON.parse(readFileSync(join(dir, 'gate-verdict.json'), 'utf8')) as {
        commit?: string; outcome?: string; baselineReceipt?: GateBaselineReceipt };
      const failures = JSON.parse(readFileSync(join(dir, 'gate-failures.json'), 'utf8')) as {
        commit?: string; failures?: string[]; errors?: string[] };
      const receipt = verdict.baselineReceipt;
      if (verdict.commit !== stamp.sha || verdict.outcome !== 'ok' || failures.commit !== stamp.sha
        || !Array.isArray(failures.failures) || failures.failures.length !== 0
        || !Array.isArray(failures.errors) || failures.errors.length !== 0
        || !receipt || receipt.schema !== 1 || !receipt.valid || receipt.version !== gateVersion || receipt.commit !== stamp.sha
        || receipt.graphSha !== input.graphPins.graphSha || receipt.recipeSha !== input.graphPins.recipeSha
        || receipt.envFingerprint !== input.envFingerprint || receipt.imageDigest !== input.imageDigest.toLowerCase()
        || !Number.isSafeInteger(receipt.files) || receipt.files < 1 || !Number.isSafeInteger(receipt.shards) || receipt.shards < 1)
        return full('hard rehearsal receipt or current execution identity differs');
      const recomputed = gateBaselineReceipt({ root: input.root, version: gateVersion, commit: stamp.sha,
        fullSweep: true, graphPins: input.graphPins, envFingerprint: input.envFingerprint });
      if (!recomputed.valid || recomputed.imageDigest !== receipt.imageDigest || recomputed.files !== receipt.files
        || recomputed.shards !== receipt.shards) return full(`hard rehearsal Pod proof differs: ${recomputed.reason}`);
      const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', stamp.sha, input.forCommit], { cwd: input.repo, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
      if (ancestor.status !== 0 || ancestor.error) return full('hard rehearsal commit is not an ancestor');
      const expectedFiles = gateAssignableTestsAtCommit(input.repo, stamp.sha);
      const measuredFiles = readdirSync(join(dir, 'gate-logs', 'cut')).filter((name) => /^pod-\d+\.json$/.test(name))
        .flatMap((name) => {
          const row = JSON.parse(readFileSync(join(dir, 'gate-logs', 'cut', name), 'utf8')) as { files?: unknown };
          return Array.isArray(row.files) ? row.files : [];
        });
      if (!expectedFiles || JSON.stringify(measuredFiles.sort()) !== JSON.stringify(expectedFiles)
        || measuredFiles.length !== receipt.files)
        return full('hard rehearsal file inventory differs from receipt');
      const tree = gitClosureTree(input.repo, input.forCommit);
      const tests = tree.files.filter((file) => TEST.test(file));
      const changed = changedFilesBetween(input.repo, stamp.sha, input.forCommit);
      const bumps = versionOnlyBumps(input.repo, stamp.sha, input.forCommit, input.version, changed);
      const effective = changed.filter((file) => !bumps.includes(file));
      // A version-only JSON/lock bump is still observable to tests that read it. Follow those literal readers and
      // opaque tests before removing the bump from the ordinary code-only partial planner.
      const versionEnvReaders = bumps.includes('package.json')
        ? tree.files.filter((file) => CODE_FILE.test(file) && tree.read(file)?.includes('npm_package_version')) : [];
      const bumpRadius = bumps.length ? testsReachingChanged(tree, [...bumps, ...versionEnvReaders], tests) : null;
      if (bumpRadius && !bumpRadius.ok) return full(bumpRadius.reason);
      const planned = planPartialRegate({ version: input.version, priorCommit: stamp.sha, forCommit: input.forCommit,
        changedFiles: effective, priorFailures: failures.failures, priorErrors: failures.errors ?? [],
        existsAtTip: (file) => tree.files.includes(file),
        closure: (code) => testsReachingChanged(tree, code, tests),
        priorCutLogs: join(dir, 'gate-logs', 'cut') });
      if (!planned.ok && (effective.length || planned.reason.startsWith('executed-pod-image-digest-')))
        return full(planned.reason);
      let fileSet: string[];
      let base: PartialPlan;
      if (planned.ok) {
        if (planned.plan.kind === 'carry' && !bumpRadius?.ok) return full('docs-only carry requires full gate across releases');
        base = planned.plan.kind === 'carry' ? { ...planned.plan, kind: undefined } : planned.plan;
        fileSet = planned.plan.files;
      } else {
        let priorFiles: string[];
        try { priorFiles = [...failures.failures, ...(failures.errors ?? [])].map(testFileOfId); }
        catch { return full('hard rehearsal failure ids unreadable'); }
        base = { version: input.version, priorCommit: stamp.sha, forCommit: input.forCommit,
          files: [], priorFailures: failures.failures, priorErrors: failures.errors ?? [] };
        fileSet = priorFiles;
      }
      const files = [...new Set([...fileSet, ...(bumpRadius?.ok ? bumpRadius.tests : [])])].sort();
      if (!files.length || files.some((file) => !tests.includes(file))) return full('empty or missing rehearsal radius requires full gate');
      return { plan: { ...base, files }, reason: 'hard rehearsal receipt and import radius verified', rehearsalRunId: stamp.hardGateRunId };
    }
    return full('no clean hard rehearsal receipt');
  } catch (error) { return full(`hard rehearsal evidence unreadable: ${String(error)}`); }
}
