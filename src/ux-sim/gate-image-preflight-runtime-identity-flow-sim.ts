import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { releasePreflight, scanGateImageRuntimeIdentity } from '../../scripts/release-loop/preflight.js';
import { gateImagePinPath, prebuildGateImagePinAtCut } from '../../scripts/release-loop/gate-image-pin.js';
import { createGateRunner, judgeGate } from '../../scripts/release-loop/gate-runtime.js';
import { HostPoolLease } from '../../src/pod-lease/host-lease.js';
import { PodPoolScheduler, parsePodPool } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import { podCommandImageFor, runPodCommand } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import type { RunPodCommandOptions, PodCommandResult } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import type { GatePodExecutionIdentity } from '../../scripts/release-loop/gate-radius-live.js';
import type { GateRunner } from '../../scripts/release-loop/gate-types.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';

const CUT = '1'.repeat(40);
const LOCK = 'gate dependency layer lock fixture\n';
const LOCK_HASH = createHash('sha256').update(LOCK).digest('hex');
const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const BASE_DIGEST = `sha256:${'c'.repeat(64)}`;
const DRIFTED_DIGEST = `sha256:${'d'.repeat(64)}`;
const PREFLIGHT_POOL = 'pool-a@aws1:1#k3d-elanous-registry:5051,pool-b@aws2:1#k3d-elanous-registry:5052';
const GATE_POOL = 'pool-a:1#k3d-elanous-registry:5051,pool-b:1#k3d-elanous-registry:5052';
// Contexts are fixture identities only: the simulator injects image probes and never contacts these pools.
const MISMATCH_GATE_POOL = 'pool-node-b:1#k3d-elanous-registry:5051,pool-mshq:1#k3d-elanous-registry:5052';

type ProbeOverride = Partial<{ baseImageDigest: string; lockHash: string; sourceLockHash: string; bunVersion: string; os: string; architecture: string; checkoutSha: string }>;
export type GateImagePreflightIntegratedScenario = {
  readonly id: string;
  readonly probeOverrides?: Readonly<Partial<Record<'aws1' | 'aws2', ProbeOverride>>>;
  readonly tagDriftPool?: 'pool-a' | 'pool-b';
  readonly gatePoolDigestDrift?: boolean;
  readonly cutPreflightPin?: boolean;
  readonly preflightTagMovedAfterMeasure?: boolean;
  readonly podObservedDigest?: 'pinned' | 'drifted';
  readonly expected: 'pinned' | 'preflight-rejected' | 'gate-image-rejected' | 'pod-image-rejected' | 'preflight-pin-rejected';
  readonly detailIncludes?: string;
};

/** Exercises release preflight and judgeGate, then the production digest-only Pod image sync. */
export const GATE_IMAGE_PREFLIGHT_INTEGRATED_SCENARIOS: readonly GateImagePreflightIntegratedScenario[] = [
  { id: 'same-runtime-and-cut-checkout-create-one-run-pin', cutPreflightPin: true, expected: 'pinned' },
  { id: 'pod-source-checkout-must-equal-cut-sha', probeOverrides: { aws2: { checkoutSha: '2'.repeat(40) } },
    expected: 'preflight-rejected', detailIncludes: 'candidate checkout differs' },
  { id: 'dependency-layer-drift-cannot-create-a-run-pin', probeOverrides: { aws2: { baseImageDigest: `sha256:${'b'.repeat(64)}` } },
    expected: 'preflight-rejected', detailIncludes: 'runtime identity' },
  { id: 'mutable-tag-drift-keeps-the-run-pinned-to-its-digest', cutPreflightPin: true, tagDriftPool: 'pool-b', expected: 'pinned' },
  { id: 'observed-pod-image-must-match-the-run-pin', cutPreflightPin: true, podObservedDigest: 'drifted', expected: 'pod-image-rejected',
    detailIncludes: 'gate image pin mismatch' },
  { id: 'tag-moving-after-cut-preflight-refuses-before-pod-start', cutPreflightPin: true,
    preflightTagMovedAfterMeasure: true, expected: 'preflight-pin-rejected', detailIncludes: 'pinned-image-unavailable' },
  { id: 'registry-pool-digest-mismatch-refuses-before-writing-a-run-pin', gatePoolDigestDrift: true,
    expected: 'gate-image-rejected', detailIncludes: 'pool image digest mismatch (pool-mshq)' },
];

export async function runGateImagePreflightIntegratedScenario(scenario: GateImagePreflightIntegratedScenario) {
  const root = mkdtempSync(join(tmpdir(), 'gate-image-runtime-flow-'));
  const probeHosts: string[] = [];
  const originalPath = process.env.PATH;
  const originalBaseDigest = process.env.ELANOUS_GATE_BASE_IMAGE_DIGEST;
  setElanousConfigDir(root);
  try {
    const preflight = await releasePreflight('0.3.8', {
      now: new Date('2026-11-09T00:00:00.000Z'), countdown: true, previousVersion: '0.3.7',
      runInput: async () => ({ input: { previousVersion: '0.3.7', gatePodPool: PREFLIGHT_POOL } }),
      schedule: () => null, freeze: () => null, graphRunsRoot: join(root, 'graph-runs'),
      exportCheck: async () => ({ mainSha: CUT, files: 1, leaks: 0, codeLiterals: 0 }),
      gitIgnoredExportCheck: async () => 0, releaseNotesCheck: async () => 1,
      pwaBuildCheck: async (commit) => ({ ok: true, commit, detail: 'simulated static export passed' }),
      manifest: () => ({ cutoff: { sha: CUT }, fragments: { byPr: 1, byNextMd: 0, unlinked: 0, unknown: 0 }, escalate: [] }),
      gateImageRuntimeCheck: (commit, pool) => scanGateImageRuntimeIdentity(commit, pool, {
        gitShow: (_sha, path) => path === 'bun.lock' ? { status: 0, stdout: LOCK }
          : path === '.bun-version' ? { status: 0, stdout: '1.4.2\n' } : { status: 1, stdout: '' },
        remoteRun: (host, command) => {
          if (command.includes('ELANOUS_GATE_IMAGE_PREFLIGHT')) probeHosts.push(host);
          if (command.includes('/tags/list')) return { status: 0, stdout: JSON.stringify({ tags: [CUT.slice(0, 12)] }), stderr: '' };
          const override = scenario.probeOverrides?.[host as 'aws1' | 'aws2'];
          const row = { baseImageDigest: BASE_DIGEST, lockHash: LOCK_HASH, sourceLockHash: LOCK_HASH,
            os: 'linux', architecture: 'x64', bunVersion: '1.4.2', checkoutSha: CUT, ...override };
          return { status: 0, stdout: `ELANOUS_GATE_IMAGE_PREFLIGHT ${JSON.stringify(row)}`, stderr: '' };
        },
      }),
    });
    const gateFinding = preflight.findings.find((finding) => finding.check === 'gate-image');
    if (scenario.expected === 'preflight-rejected') {
      return { outcome: gateFinding?.level === 'block' ? 'preflight-rejected' as const : 'preflight-unexpected-pass' as const,
        detail: gateFinding?.message ?? 'gate-image finding missing', probeHosts, pin: null };
    }
    if (gateFinding?.level !== 'ok') return { outcome: 'preflight-unexpected-block' as const,
      detail: gateFinding?.message ?? 'gate-image finding missing', probeHosts, pin: null };

    const bin = join(root, 'bin');
    mkdirSync(bin);
    const docker = join(bin, 'docker');
    writeFileSync(docker, `#!/bin/sh\nprintf '%s\\n' '${BASE_DIGEST}'\n`);
    chmodSync(docker, 0o755);
    const curl = join(bin, 'curl');
    const curlLog = join(root, 'registry-probes.log');
    const driftPort = scenario.tagDriftPool === 'pool-a' ? '5051' : scenario.tagDriftPool === 'pool-b' ? '5052' : '';
    const driftCase = driftPort ? `case \"$*\" in *localhost:${driftPort}*) digest='${DRIFTED_DIGEST}';; esac` : '';
    writeFileSync(curl, ['#!/bin/sh', `digest='${IMAGE_DIGEST}'`, driftCase,
      `printf '%s %s\\n' \"$*\" \"$digest\" >> '${curlLog}'`,
      `printf 'HTTP/1.1 200 OK\\r\\nDocker-Content-Digest: %s\\r\\n\\r\\n' \"$digest\"`].filter(Boolean).join('\n') + '\n');
    chmodSync(curl, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    const executionIdentity: GatePodExecutionIdentity = { imageDigest: IMAGE_DIGEST, bunVersion: '1.4.2', platform: 'linux',
      architecture: 'x64', envFingerprint: 'e'.repeat(64), baseImageDigest: BASE_DIGEST };
    const runner = { now: () => Date.now() } as unknown as GateRunner;
    const gateImageProbeCalls: string[] = [];
    const gateImageProbeRows: Array<{ context: string; digest: string }> = [];
    const gateImageProbe = (poolSpec: string) => {
      const context = poolSpec.split(/[@:#]/, 1)[0]!;
      const digest = scenario.preflightTagMovedAfterMeasure || (scenario.gatePoolDigestDrift && context === 'pool-mshq')
        ? DRIFTED_DIGEST : IMAGE_DIGEST;
      gateImageProbeCalls.push(context);
      gateImageProbeRows.push({ context, digest });
      return digest;
    };
    const gatePool = scenario.gatePoolDigestDrift ? MISMATCH_GATE_POOL : GATE_POOL;
    const pinPath = gateImagePinPath(root, '0.3.8', 'sim-gate-run');
    if (scenario.cutPreflightPin) {
      const preflightPin = await prebuildGateImagePinAtCut({
        root, version: '0.3.8', runId: 'sim-gate-run', commit: CUT,
        image: `${podCommandImageFor([], true).split(':')[0]}:${CUT.slice(0, 12)}`,
        members: parsePodPool(gatePool).map(({ context }) => ({ context })),
        probe: () => IMAGE_DIGEST,
        sync: async () => new Map(parsePodPool(gatePool).map(({ context }) => [context, { ok: true }])),
      });
      if (preflightPin.digest !== IMAGE_DIGEST) return { outcome: 'preflight-pin-digest-changed' as const, preflightPin };
    }
    const gateOptions = { commit: CUT, version: '0.3.8', baselineVersion: '0.3.7', graphRunId: 'sim-gate-run',
      imagePin: 'cut-commit' as const, imagePinPrepareOnly: true, scratchOnly: true, instanceRoot: root, ledgerRoot: root,
      repo: process.cwd(), pod: { pool: gatePool, shards: 1 } };
    if (scenario.expected === 'preflight-pin-rejected') {
      let detail = 'judgeGate accepted a gate tag that moved after cut preflight';
      let judged: Awaited<ReturnType<typeof judgeGate>> | undefined;
      const appliedJobImageRefs: string[] = [];
      let jobApplyCount = 0;
      let selectedPool = 0;
      const poolCandidates = parsePodPool(gatePool);
      const kubectl: NonNullable<RunPodCommandOptions['kubectl']> = (args, input) => {
        if (args.includes('apply')) jobApplyCount++;
        if (args.includes('apply') && input) {
          const manifest = JSON.parse(input) as { kind?: string; spec?: { template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } } };
          const image = manifest.spec?.template?.spec?.containers?.find((container) => container.name === 'child')?.image;
          if (manifest.kind === 'Job' && image) appliedJobImageRefs.push(image);
        }
        return { status: 0, stdout: '', stderr: '' };
      };
      const podCommand = (options: RunPodCommandOptions): Promise<PodCommandResult> => {
        const member = poolCandidates[selectedPool++ % poolCandidates.length]!;
        const scheduler = new PodPoolScheduler([member], {
          status: () => ({ recommended: 1, limitedBy: null, reason: null, capacitySlots: 1, memorySlots: 1,
            placeableSlots: 1, accountSlots: 1, running: 0, pending: 0 }),
          hostLease: new HostPoolLease('gate-image-preflight-refused-' + member.context, { dir: join(root, 'pool-leases') }),
          memberMemory: () => [], occupancy: () => ({ [member.context]: { occupied: 0 } }),
        });
        return runPodCommand({ ...options, kubectl, poolScheduler: scheduler, readGitHead: () => CUT, ghToken: () => '' });
      };
      const productionRunner = createGateRunner(process.cwd(), undefined, undefined, podCommand, undefined, undefined,
        { podCommand, kubectl });
      try {
        judged = await judgeGate({ ...gateOptions, imagePinPrepareOnly: false }, productionRunner,
          gateImageProbe, () => executionIdentity, async () => new Map());
        detail = judged.error ?? detail;
      } catch (error) { detail = error instanceof Error ? error.message : String(error); }
      const pin = existsSync(pinPath) ? JSON.parse(await Bun.file(pinPath).text()) as { digest?: string; commit?: string; runId?: string } : null;
      return { outcome: judged?.outcome === 'error' && detail.includes(scenario.detailIncludes!)
        && pin?.digest === IMAGE_DIGEST && pin.commit === CUT
        && pin.runId === 'sim-gate-run' && jobApplyCount === 0
        ? 'preflight-pin-rejected' as const : 'preflight-pin-rejection-invalid' as const,
        detail, pin, pinExists: existsSync(pinPath), gateImageProbeCalls, appliedJobImageRefs, jobApplyCount, probeHosts };
    }
    if (scenario.expected === 'gate-image-rejected') {
      let detail = 'judgeGate accepted the divergent per-pool registry digests';
      let judged: Awaited<ReturnType<typeof judgeGate>> | undefined;
      try { judged = await judgeGate(gateOptions, runner, gateImageProbe, () => executionIdentity, async () => new Map());
        detail = judged.error ?? detail; }
      catch (error) { detail = error instanceof Error ? error.message : String(error); }
      return { outcome: judged?.outcome === 'error' && detail.includes(scenario.detailIncludes!) && !existsSync(pinPath)
        ? 'gate-image-rejected' as const : 'gate-image-rejection-invalid' as const,
        detail, gateImageProbeCalls, gateImageProbeRows, pinExists: existsSync(pinPath), probeHosts };
    }
    const gate = await judgeGate(gateOptions, runner, gateImageProbe, () => executionIdentity, async () => new Map());
    if (!existsSync(pinPath)) return { outcome: 'pin-file-missing' as const, gate, pinPath, root };
    const pin = JSON.parse(await Bun.file(pinPath).text()) as { digest: string; commit: string; runId: string };
    const appliedJobImageRefs: string[] = [];
    const appliedJobs = new Map<string, string>();
    let selectedPool = 0;
    const artifactLine = (path: string, text: string) => {
      const token = Buffer.from(path).toString('base64url');
      return 'ELANOUS_POD_ARTIFACT ' + token + ' 1/1 ' + gzipSync(Buffer.from(text)).toString('base64');
    };
    // External Kubernetes boundary: production runPodCommand builds/applies the Job and consumes Pod status.
    // Record the manifest sent to kubectl verbatim; no production Pod execution callback is replaced.
    const poolCandidates = parsePodPool(gatePool);
    const kubectl: NonNullable<RunPodCommandOptions['kubectl']> = (args, input) => {
      const joined = args.join(' ');
      if (args.includes('apply') && input) {
        const manifest = JSON.parse(input) as { kind?: string; metadata?: { name?: string }; spec?: { template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } } };
        if (manifest.kind === 'Job' && manifest.metadata?.name) {
          const image = manifest.spec?.template?.spec?.containers?.find((container) => container.name === 'child')?.image;
          if (image) appliedJobs.set(manifest.metadata.name, image);
        }
        return { status: 0, stdout: '', stderr: '' };
      }
      if (joined.includes('get job ') && joined.includes('jsonpath=')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (joined.includes('terminated.exitCode')) return { status: 0, stdout: '0', stderr: '' };
      if (joined.includes('logs ')) {
        const logs = [artifactLine('install.rc', '0\n'), artifactLine('part-0.rc', '0\n'),
          artifactLine('part-0.log', '1 pass\n0 fail\n0 errors\nRan 1 test across 1 files.\n')].join('\n');
        return { status: 0, stdout: logs + '\n', stderr: '' };
      }
      if (joined.includes('get pods ') && joined.includes('-o json')) {
        const digest = scenario.podObservedDigest === 'drifted' ? DRIFTED_DIGEST : IMAGE_DIGEST;
        const selector = args.find((arg) => arg.startsWith('job-name='))?.slice('job-name='.length);
        const jobs = [...appliedJobs].filter(([name]) => !selector || name === selector);
        const items = jobs.map(([name, image]) => ({ metadata: { name: name + '-pod', uid: name + '-uid', labels: { 'job-name': name } },
          spec: { containers: [{ name: 'child', image }] },
          status: { phase: 'Succeeded', containerStatuses: [{ name: 'child', imageID: 'docker-pullable://' + image.split('@')[0] + '@' + digest,
            state: { terminated: { exitCode: 0 } } }] } }));
        return { status: 0, stdout: JSON.stringify({ items }), stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const podCommand = (options: RunPodCommandOptions): Promise<PodCommandResult> => {
      const member = poolCandidates[selectedPool++ % poolCandidates.length]!;
      const scheduler = new PodPoolScheduler([member], {
        status: () => ({ recommended: 1, limitedBy: null, reason: null, capacitySlots: 1, memorySlots: 1,
          placeableSlots: 1, accountSlots: 1, running: 0, pending: 0 }),
        hostLease: new HostPoolLease('gate-image-sim-' + member.context, { dir: join(root, 'pool-leases') }),
        memberMemory: () => [], occupancy: () => ({ [member.context]: { occupied: 0 } }),
      });
      return runPodCommand({ ...options, kubectl, poolScheduler: scheduler, readGitHead: () => CUT, ghToken: () => '' });
    };
    const podObservedDigest = scenario.podObservedDigest === 'drifted' ? DRIFTED_DIGEST : IMAGE_DIGEST;
    const podRunner = createGateRunner(root, undefined, undefined, podCommand, undefined, undefined,
      { podCommand, kubectl });
    let podError: string | undefined;
    let podResultRc: number | undefined;
    try {
      const runs = scenario.expected === 'pod-image-rejected' ? 1 : poolCandidates.length;
      for (let index = 0; index < runs; index++) {
        const podResults = await podRunner.recheckPodBatch!(['scripts/release-loop/gate-node.test.ts'], CUT,
          { pool: gatePool, shards: 1, pinnedImageDigest: gate.imagePinDigest, pinnedRunId: 'sim-gate-run' }, 30_000);
        podResultRc = podResults.get('scripts/release-loop/gate-node.test.ts')?.rc;
      }
    } catch (error) { podError = error instanceof Error ? error.message : String(error); }
    appliedJobImageRefs.push(...appliedJobs.values());
    const tagProbeRows = existsSync(curlLog) ? (await Bun.file(curlLog).text()).trim().split('\n').filter(Boolean).map((line) => {
      const digest = / (sha256:[a-f0-9]{64})$/u.exec(line)?.[1] ?? null;
      const registryPort = /localhost:(\d+)/u.exec(line)?.[1] ?? null;
      return { registryPort, digest };
    }) : [];
    if (scenario.expected === 'pod-image-rejected') return { outcome: podError?.includes(scenario.detailIncludes!)
        ? 'pod-image-rejected' as const : 'pod-image-rejection-invalid' as const, detail: podError ?? 'Pod image mismatch was accepted',
      pinExists: existsSync(pinPath), podObservedDigest, pinnedDigest: gate.imagePinDigest, appliedJobImageRefs, probeHosts };
    return { outcome: gate.imagePin === 'cut-commit' && podResultRc === 0 && !podError
        ? 'pinned' as const : 'pin-missing' as const, preflightLevel: gateFinding.level,
      gateOutcome: gate.outcome, pin, gateImageProbeCalls, appliedJobImageRefs, tagProbeRows,
      pinExists: existsSync(pinPath), podObservedDigest, probeHosts };
  } finally {
    process.env.PATH = originalPath;
    if (originalBaseDigest === undefined) delete process.env.ELANOUS_GATE_BASE_IMAGE_DIGEST;
    else process.env.ELANOUS_GATE_BASE_IMAGE_DIGEST = originalBaseDigest;
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
}
