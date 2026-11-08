// Gate roster simulation uses the real judgeGate and sweep. Only repository commands,
// image probes/sync, and the remote Pod boundary are provided by the scenario.
import { gzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateRunner, judgeGate, mismatchedGateRosterImagePools } from '../../scripts/release-loop/gate-api-leaf.js';
import type { GateRunner } from '../../scripts/release-loop/gate-types.js';
import { resolveGateImagePin } from '../../scripts/release-loop/gate-image-pin.js';
import { gateEnvFingerprint } from '../../scripts/release-loop/gate-baseline-receipt.js';
import { POD_RESULT_MARKER, runPodCommand, type RunPodCommandOptions } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { parsePodPool, PodPoolScheduler, type PodPoolMember, type PoolImageSync } from '../task-orchestrator/surfaces/pod-pool.js';

export interface GateRosterScenario {
  readonly poolSpec: string;
  readonly imageDigests: Readonly<Record<string, string | null>>;
  /** Hosts fail only after the sweep has acquired them for an actual shard. */
  readonly unreachableHosts?: readonly string[];
  readonly fileCount?: number;
}

export interface GateRosterObservation {
  readonly verdict: 'pass' | 'image-fingerprint-mismatch' | 'measurement-unavailable' | 'gate-failed' | 'sweep-failed' | 'sweep-incomplete';
  readonly gateOutcome: 'ok' | 'regression' | 'error';
  readonly gateError: string | null;
  readonly pinnedDigest: string | null;
  readonly eligiblePools: readonly string[];
  readonly mismatchedPools: readonly string[];
  readonly placements: readonly { context: string; files: readonly string[]; available: boolean }[];
  readonly unavailableHosts: readonly string[];
  readonly reassignments: readonly { from: string; to: string; files: readonly string[] }[];
  readonly completedFiles: readonly string[];
  readonly sweep?: { rc: number; complete: boolean; expectedFiles: number; completedFiles: readonly string[] };
  readonly summary: string;
}

const CUT = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const DIGEST = `sha256:${'a'.repeat(64)}`;

function captureFiles(options: RunPodCommandOptions): string[][] {
  return [...options.command[2]!.matchAll(/run_part \d+ ([^&]*)/g)]
    .map((match) => [...match[1]!.matchAll(/'\.\/([^']+)'/g)].map((file) => file[1]!));
}

function artifactLine(path: string, body: string): string {
  return `ELANOUS_POD_ARTIFACT ${Buffer.from(path).toString('base64url')} 1/1 ${gzipSync(Buffer.from(body)).toString('base64')}`;
}

/**
 * Exercise the production release verdict path, image pinning, scheduler, and Pod sweep.
 * The fixture never invokes git on a real checkout, kubectl, SSH, a registry, or a real Pod.
 */
export async function simGateRosterSecondPool(scenario: GateRosterScenario, tempParent = tmpdir()): Promise<GateRosterObservation> {
  const members = parsePodPool(scenario.poolSpec);
  const poolImages = new Map<string, readonly string[]>();
  for (const member of members) {
    const digest = scenario.imageDigests[member.context];
    poolImages.set(member.context, digest ? [digest] : []);
  }
  const initialDigest = [...poolImages.values()].flat()[0] ?? null;
  const pin = resolveGateImagePin({ initialDigest, poolImages });
  const mismatchedPools = mismatchedGateRosterImagePools(poolImages, initialDigest);
  const runRoot = mkdtempSync(join(tempParent, 'gate-roster-second-pool-'));
  const repo = join(runRoot, 'repo');
  const state = join(runRoot, 'state');
  const ledger = join(runRoot, 'ledger');
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(state, 'release', '0.3.4'), { recursive: true });
  const fileCount = scenario.fileCount ?? 16;
  const files = Array.from({ length: fileCount }, (_, index) => `src/roster-${String(index).padStart(2, '0')}.test.ts`);
  const placements: Array<{ context: string; files: string[]; available: boolean }> = [];
  const unavailableHosts = new Set<string>();
  const failedOnce = new Set<string>();
  const reassignments: Array<{ from: string; to: string; files: string[] }> = [];

  // A trustworthy cached baseline avoids a second test run while judgeGate still computes its normal verdict.
  writeFileSync(join(state, 'release', '0.3.4', 'release.json'), JSON.stringify({ sourceCommit: BASE }));
  writeFileSync(join(state, 'release', '0.3.4', 'gate-failures.json'), JSON.stringify({ commit: BASE, failures: [], errors: [] }));

  const command: GateRunner['command'] = async (cmd, args) => {
    if (cmd === 'rg') return { rc: 1, output: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: `${CUT}\n` };
    if (cmd === 'git' && args[0] === 'ls-files') return { rc: 0, output: `${files.join('\n')}\n` };
    return { rc: 0, output: '' };
  };
  const runPod = async (options: RunPodCommandOptions) => {
    const logsByJob = new Map<string, string>();
    let placed: { context: string; files: string[]; available: boolean } | undefined;
    const kubectl: NonNullable<RunPodCommandOptions['kubectl']> = (args, input) => {
      const context = args[0] === '--context' ? args[1]! : '';
      if (args.includes('apply') && input) {
        let resource: { kind?: string; metadata?: { name?: string; labels?: Record<string, string> } } | undefined;
        try { resource = JSON.parse(input) as typeof resource; } catch { /* secret payloads are opaque */ }
        if (resource?.kind === 'Job' && resource.metadata?.name) {
          const parts = captureFiles(options);
          placed = { context, files: parts.flat(), available: true };
          placements.push(placed);
          const artifactRows = [artifactLine('install.rc', '0\n'), artifactLine('runtime-identity.json', JSON.stringify({
            bunVersion: '1.4.2', platform: 'linux', architecture: 'x64', envFingerprint: gateEnvFingerprint({ NODE_ENV: 'test' }),
            baseImageDigest: 'sha256:' + 'd'.repeat(64),
          }))];
          for (const [index, part] of parts.entries()) {
            const log = `${part.map((file) => `${file}:\n(pass) simulated [1.00ms]`).join('\n')}\n${part.length} pass\n0 fail\nRan ${part.length} tests across ${part.length} files.\n`;
            artifactRows.push(artifactLine(`part-${index}.log`, log), artifactLine(`part-${index}.rc`, '0\n'));
          }
          const launch = resource.metadata.labels?.['elanous.launch'] ?? '';
          logsByJob.set(resource.metadata.name, `${artifactRows.join('\n')}\n${POD_RESULT_MARKER} ${launch} rc=0\n`);
        }
        return { status: 0, stdout: '', stderr: '' };
      }
      const jobIndex = args.indexOf('job');
      if (jobIndex >= 0 && args.some((arg) => arg.includes('.status.conditions'))) {
        if ((scenario.unreachableHosts ?? []).includes(context)) {
          unavailableHosts.add(context);
          failedOnce.add(context);
          if (placed) placed.available = false;
          return { status: 1, stdout: '', stderr: `Unable to connect to ${context}: dial tcp: i/o timeout` };
        }
        return { status: 0, stdout: 'Complete', stderr: '' };
      }
      if (args.includes('logs')) {
        if ((scenario.unreachableHosts ?? []).includes(context)) {
          unavailableHosts.add(context);
          failedOnce.add(context);
          if (placed) placed.available = false;
          return { status: 1, stdout: '', stderr: `Unable to read Job logs from ${context}: i/o timeout` };
        }
        const job = args.find((arg) => arg.startsWith('job/'))?.slice('job/'.length) ?? '';
        return { status: 0, stdout: logsByJob.get(job) ?? '', stderr: '' };
      }
      if (args.some((arg) => arg.includes('exitCode'))) return { status: 0, stdout: '0', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    return runPodCommand({ ...options, kubectl, imageCommit: CUT, env: { NODE_ENV: 'test' }, configHostMirror: () => undefined,
      ghToken: () => 'simulated-token', artifactsRoot: join(runRoot, 'pod-artifacts'), pollMs: 0,
      sleep: async () => {}, log: () => {},
      syncImages: async (syncMembers) => new Map(syncMembers.map((member) => [member.context, {
        ok: true, action: 'fresh' as const, detail: 'simulated pinned image available', ms: 0,
        imageRef: `registry.invalid/elanous-harness@${DIGEST}`,
      }])),
    });
  };
  const schedulerMembers: PodPoolMember[] = members.map((member) => ({ ...member, k3dCluster: 'elanous-pool' }));
  const scheduler = new PodPoolScheduler(schedulerMembers);
  const productionRunner = createGateRunner(repo, undefined, command, runPod, scheduler, () => '', {
    podImageDigest: () => DIGEST,
    kubectl: (() => ({ status: 0, stdout: '', stderr: '' })) as never,
  });
  const actualSweep = productionRunner.sweep.bind(productionRunner);
  let observedSweep: Awaited<ReturnType<GateRunner['sweep']>> | undefined;
  const runner: GateRunner = {
    ...productionRunner,
    async localCommand(cmd, args, cwd) { return command(cmd, args, cwd); },
    async add(tree) { mkdirSync(tree, { recursive: true }); },
    async snapshot(tree) { mkdirSync(tree, { recursive: true }); },
    async remove(tree) { rmSync(tree, { recursive: true, force: true }); },
    async removeSnapshot(tree) { rmSync(tree, { recursive: true, force: true }); },
    async sweep(...args) {
      observedSweep = await actualSweep(...args);
      return observedSweep;
    },
  };

  try {
    let gate: Awaited<ReturnType<typeof judgeGate>>;
    try { gate = await judgeGate({ commit: CUT, baselineCommit: BASE, baselineVersion: '0.3.4', version: '0.3.5-rc.1',
      graphRunId: `gate-roster-${Math.random().toString(36).slice(2)}`, repo, instanceRoot: state, ledgerRoot: ledger, full: true,
      pod: { pool: scenario.poolSpec, shards: scenario.fileCount === 1 ? 1 : 8, stallSeconds: 0, memberUnreadableSeconds: 0,
        probeMember: (member) => !(scenario.unreachableHosts ?? []).includes(member.context) || !failedOnce.has(member.context) } },
    runner, (memberSpec) => {
      const member = parsePodPool(memberSpec)[0];
      return member ? scenario.imageDigests[member.context] ?? null : null;
    }, () => null,
    async (syncMembers, _image, _localCommit) => new Map<string, PoolImageSync>(syncMembers.map((member) => [member.context,
      { ok: true, action: 'fresh', detail: 'simulated image probe completed without digest', ms: 0 }]))); }
    catch (error) {
      const gateError = String(error).replace(/^Error: /, '');
      if (!gateError.includes('HQ shard result batch is incomplete')) throw error;
      return { verdict: 'measurement-unavailable', gateOutcome: 'error', gateError, pinnedDigest: null,
        eligiblePools: pin.ok ? pin.eligiblePools : [], mismatchedPools, placements,
        unavailableHosts: [...unavailableHosts], reassignments, completedFiles: [], summary: gateError };
    }

    const retryRows = placements.reduce((byFiles, placement) => {
      const key = placement.files.join('\0');
      const rows = byFiles.get(key) ?? [];
      rows.push(placement);
      byFiles.set(key, rows);
      return byFiles;
    }, new Map<string, typeof placements>());
    for (const rows of retryRows.values()) {
      const failed = rows.find((row) => !row.available);
      const passed = rows.find((row) => row.available);
      if (failed && passed) reassignments.push({ from: failed.context, to: passed.context, files: failed.files });
    }
    const sweepResult = observedSweep;
    const completedFiles = [...new Set(sweepResult?.podSweep?.files ?? [])].sort();
    const allFilesCompleted = JSON.stringify(completedFiles) === JSON.stringify([...files].sort());
    const complete = sweepResult?.rc === 0 && sweepResult.validatedShards === true && !sweepResult.timedOut
      && !sweepResult.abortedShards && !sweepResult.stalledEnv?.length && allFilesCompleted;
    const mismatchObserved = gate.outcome === 'error' && gate.error?.includes('gate image pin refused: pool image digest mismatch') === true;
    const allHostsUnavailable = gate.outcome === 'error' && !!gate.stalledShards?.length && !sweepResult
      && gate.error?.startsWith('pod sweep incomplete: stalled shards ') === true;
    const imageNotMeasurable = gate.outcome === 'error' && !sweepResult
      && (gate.error?.includes('gate image pin refused: initial image sync failed') === true
        || gate.error?.includes('gate image pin refused: initial-image-digest-missing') === true);
    const verdict: GateRosterObservation['verdict'] = mismatchObserved ? 'image-fingerprint-mismatch'
      : imageNotMeasurable || allHostsUnavailable ? 'measurement-unavailable'
        : complete && gate.outcome === 'ok' ? 'pass'
          : gate.outcome === 'error' && !sweepResult ? 'gate-failed'
            : sweepResult?.rc !== 0 ? 'sweep-failed' : 'sweep-incomplete';
    return { verdict, gateOutcome: gate.outcome, gateError: gate.error ?? null, pinnedDigest: gate.outcome === 'ok' ? initialDigest : null,
      eligiblePools: pin.ok ? pin.eligiblePools : [], mismatchedPools,
      placements, unavailableHosts: [...unavailableHosts], reassignments,
      completedFiles,
      ...(sweepResult ? { sweep: { rc: sweepResult.rc, complete, expectedFiles: files.length, completedFiles } } : {}),
      summary: gate.error ?? (complete ? 'judgeGate accepted the complete production sweep' : `judgeGate ${gate.outcome}; sweep rc=${sweepResult?.rc ?? 'not-run'}, completed ${completedFiles.length}/${files.length}`) };
  } finally { rmSync(runRoot, { recursive: true, force: true, maxRetries: 0 }); }
}
