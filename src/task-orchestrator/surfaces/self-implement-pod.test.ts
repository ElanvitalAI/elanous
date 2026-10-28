import { setDefaultTimeout, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { makePrManager, type CmdRunner } from '../../autopilot/pr-manager.js';
import { guardNewPr } from '../../pr-tool/census.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { appendRunLedgerEntry, loadRunLedger, runLedgerDir, runLedgerPath } from '../../self-implement/run-ledger.js';
import { recordClassifiedHarnessPodExit, recordHarnessPodStop } from '../../harness/harness-cli-command.js';
import { readRunExits } from '../../harness/harness-incidents.js';
import { tmpdir } from 'node:os';
import { tierModel } from '../../llm/model-defaults.js';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { parsePodArtifactChunks } from './pod-artifact-return.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { enableLandingFreeze } from '../../release-loop/landing-freeze.js';
import { CONTROL_INBOX_DIR_ENV } from '../../harness/control-inbox.js';
import { podFragmentFinished, readPodFragment } from '../../harness/self-send-target.js';
import { resetLiveDetailCacheForTesting } from '../../live/detail-switch.js';
import { LEASE_KUBECTL_MAX_BUFFER, measurePoolLease, recommendConcurrency } from './pod-lease.js';
import { POD_JOB_DEADLINE_SECONDS, POD_DEADLINE_AFTER_WAIT, POD_LOGS_KEEP_BYTES, POD_NO_RESULT_LOG_TAIL_LINES, POD_RESULT_FLATTEN, defaultKubectl, hostCredentials, k8sLabelValue, podDeadlineWatchdogScript, podNoResultLogTailLines, readPodNoResultLogTail, podRunLabels, hostGrokCredentials, podJobManifest, podJobName, podSalvageScript, podSalvageBundleScript, podEarlySalvageScript, podGithubWatchdogScript, podGitPushGuardScript, POD_GH_STALE_SECONDS, podJobFinishedTiming, podSelfImplementSpawn as realPodSelfImplementSpawn, recordPodSalvage, recordPodSourceIoSummary, parseMemSamples, podRunResultLine, type Kubectl } from './self-implement-pod.js';
import { stablePodRunGuard } from './pod-manifest-test-normalize.js';
import { POD_PROVENANCE_ENV_NAMES } from './pod-provenance.js';
import { makeScriptedKubectlDevice, type PodDeviceEvent } from '../../ux-sim/task-orchestrator-surfaces-self-implement-pod-device.js';
import type { PodSource } from './pod-source-receive.js';
import { defaultGrokModel } from '../../grok/models.js';
import { buildPodConfigSnapshot } from './pod-config-snapshot.js';

import { buildUserConfig, resetUserConfig, userConfigPath, type UserConfig } from '../../user-config.js';
import { worktreeAddTimeoutForRepo } from '../../git-fs/worktree.js';
import { getElanousConfigDirOverride, setElanousConfigDir, resetElanousConfigDir } from '../../elanous-config-dir.js';

// Unit fakes opt out explicitly; a supplied kubectl adapter in product code still measures on the host.
const podSelfImplementSpawn: typeof realPodSelfImplementSpawn = (options = {}) =>
  realPodSelfImplementSpawn(options.kubectl ? { budgetSnapshot: () => undefined, fallbackConfig: () => ({ llm: {} }) as UserConfig,
    openGatewayConfig: () => ({ llm: {} }) as UserConfig,
    lookupOpenPrByBranch: () => ({ status: 'not-found', reason: 'test-fixture' }), ...options } : options);
import { loadTokens } from '../../oauth/store.js';
import { resolveCodexAccount } from '../../oauth/codex-account.js';
import { statSync } from 'node:fs';
import { orchestrateSelfDev } from '../../self-dev/orchestrate.js';
import { mintGroundingToken } from '../../grounding/token.js';
import { handlePodGithubCredential, resetPodCredentialRateForTesting } from '../../nexus/api/pod-credential-api.js';

const CREDS = () => ({ elanousAuth: '{"m":1}', codexAuth: '{"c":1}', ghToken: 'gho_x' });

test('manifest config snapshot: allowlisted settings, deterministic hash and existing config preservation', async () => {
  const config = { llm: { fallbackChain: ['codex-rotate', 'grok'], zaiCodingPlan: { overage: 'balance', maxConcurrent: 9 },
    accessToken: 'do-not-copy', nested: { secret: 'do-not-copy' } },
    tools: { selfImplement: { podChildDefault: { provider: 'grok', model: 'grok-test', secret: 'do-not-copy' } } },
    secret: 'do-not-copy' } as unknown as UserConfig;
  const a = buildPodConfigSnapshot(config, { steps: ['codex-rotate', 'grok'], overage: 'balance', worktreeAddTimeoutSec: 1200 });
  const b = buildPodConfigSnapshot(config, { steps: ['codex-rotate', 'grok'], overage: 'balance', worktreeAddTimeoutSec: 1200 });
  expect(a).toEqual(b);
  expect(a.hash).toBe(createHash('sha256').update(JSON.stringify({ version: a.version, keys: a.keys, sources: a.sources })).digest('hex'));
  expect(JSON.parse(a.configJson)).toMatchObject({ llm: { fallbackChain: ['codex-rotate', 'grok'], zaiCodingPlan: { overage: 'balance' } },
    tools: { selfImplement: { podChildDefault: { provider: 'grok', model: 'grok-test' } } } });
  expect(a.envelopeJson).not.toMatch(/secret|token|do-not-copy/i);

  const { k, calls } = fakeKubectl(['Complete'], '');
  await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, fallbackConfig: () => config, env: {} })({ feature: 'config snapshot', spaceId: 'config-snapshot' }).done;
  const applied = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
  const secret = applied.find((m) => m.kind === 'Secret');
  const job = applied.find((m) => m.kind === 'Job');
  const effective = buildPodConfigSnapshot(config, { steps: ['codex-rotate', 'grok'], overage: 'balance', worktreeAddTimeoutSec: 1200 });
  expect(secret.stringData['llm-fallback-config.json']).toBe(effective.configJson);
  expect(secret.stringData['config-snapshot.json']).toBe(effective.envelopeJson);
  expect(job.metadata.annotations['elanous.config-snapshot-sha256']).toBe(effective.hash);
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'pod-config-snapshot-ledger-'));
  const parentRunId = 'run-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  try {
    const ledgerKubectl = fakeKubectl(['Complete'], '');
    await podSelfImplementSpawn({ kubectl: ledgerKubectl.k, credentials: CREDS, fallbackConfig: () => config,
      env: { ELANOUS_STATE_DIR: ledgerRoot, ELANOUS_RUN_ID: parentRunId } })({ feature: 'config snapshot', spaceId: 'config-snapshot-ledger' }).done;
    const snapshotRows = loadRunLedger(parentRunId, runLedgerDir(ledgerRoot))?.filter((entry) => entry.event === 'pod-config-snapshot');
    expect(snapshotRows).toHaveLength(1);
    expect(snapshotRows?.[0]?.data).toEqual({ job: podJobName('config-snapshot-ledger'), hash: effective.hash, keyCount: effective.keyCount });
  } finally { rmSync(ledgerRoot, { recursive: true, force: true }); }
  const script: string = job.spec.template.spec.containers[0].args[0];
  expect(script).toContain('readFileSync("/creds/config-snapshot.json"');
  expect(script).toContain('if (h !== e.hash || JSON.stringify(c) !== JSON.stringify(e.keys)) process.exit(1)');
  const install = script.split('\n').filter((line) => line.includes('install -m 600 /creds/llm-fallback-config.json'));
  expect(install).toHaveLength(1);
  expect(install[0]).toContain('[ -e "$HOME/.elanous/config.json" ] || [ -L "$HOME/.elanous/config.json" ] || install');
  const root = mkdtempSync(join(tmpdir(), 'pod-config-snapshot-'));
  try {
    mkdirSync(join(root, '.elanous'));
    writeFileSync(join(root, '.elanous', 'config.json'), 'preserve me');
    const creds = join(root, 'llm-fallback-config.json');
    writeFileSync(creds, effective.configJson);
    const command = install[0]!.replace('/creds/llm-fallback-config.json', creds);
    expect(Bun.spawnSync(['bash', '-c', command], { env: { ...process.env, HOME: root } }).exitCode).toBe(0);
    expect(readFileSync(join(root, '.elanous', 'config.json'), 'utf8')).toBe('preserve me');
    rmSync(join(root, '.elanous', 'config.json'));
    symlinkSync('missing-config.json', join(root, '.elanous', 'config.json'));
    expect(Bun.spawnSync(['bash', '-c', command], { env: { ...process.env, HOME: root } }).exitCode).toBe(0);
    expect(existsSync(join(root, '.elanous', 'missing-config.json'))).toBe(false);
    expect(readlinkSync(join(root, '.elanous', 'config.json'))).toBe('missing-config.json');
    rmSync(join(root, '.elanous', 'config.json'));
    expect(Bun.spawnSync(['bash', '-c', command], { env: { ...process.env, HOME: root } }).exitCode).toBe(0);
    expect(readFileSync(join(root, '.elanous', 'config.json'), 'utf8')).toBe(effective.configJson);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deadline watchdog emits a scoped result and stops only its child before the hard limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-deadline-watch-'));
  try {
    expect(Bun.spawnSync(['git', 'init', '-q', '-b', 'tc/work', join(root, 'repo')]).exitCode).toBe(0);
    const paths = (value: string) => value.replaceAll('/tmp/si.', `${root}/si.`);
    const watch = paths(podDeadlineWatchdogScript({ deadlineSeconds: 2, job: 'si-test', runId: 'run-test', prNumber: 31544 }));
    const afterWait = paths(POD_DEADLINE_AFTER_WAIT);
    const run = Bun.spawnSync(['bash', '-c', `set -u\ncd ${JSON.stringify(root)}\nprintf 'child-start\\n' > ${JSON.stringify(join(root, 'si.out'))}\n${watch}\nprintf 'run\\n' > ${JSON.stringify(join(root, 'si.stage'))}\nsleep 20 & si_pid=$!\nprintf '%s\\n' "$si_pid" > ${JSON.stringify(join(root, 'si.pid'))}\nwait "$si_pid"; rc=$?\n${afterWait}\nkill "$si_deadline_watch_pid" 2>/dev/null || true\nprintf 'rc=%s\\n' "$rc"`], { timeout: 4_000 });
    const output = run.stdout.toString();
    expect(run.exitCode).toBe(0);
    expect(output).toContain('ELANOUS_POD_DEADLINE_RESULT si-test run-test stop-cause=deadline stage=run pr=31544 branch=tc/work');
    expect(output).toContain('rc=124');
    expect(readFileSync(join(root, 'si.out'), 'utf8')).toContain('"stopCause":"deadline"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deadline watchdog leaves a completed child and its successful result alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-deadline-complete-'));
  try {
    const watch = podDeadlineWatchdogScript({ deadlineSeconds: 2, job: 'si-complete', runId: 'run-complete' })
      .replaceAll('/tmp/si.', `${root}/si.`);
    const run = Bun.spawnSync(['bash', '-c', `set -u\ncd ${JSON.stringify(root)}\n${watch}\nsleep 0.1 & si_pid=$!\nprintf '%s\\n' "$si_pid" > ${JSON.stringify(join(root, 'si.pid'))}\nwait "$si_pid"; rc=$?; touch ${JSON.stringify(join(root, 'si.finished'))}\nsleep 2\nkill "$si_deadline_watch_pid" 2>/dev/null || true\nprintf 'rc=%s\\n' "$rc"`], { timeout: 4_000 });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain('rc=0');
    expect(run.stdout.toString()).not.toContain('ELANOUS_POD_DEADLINE_RESULT');
    expect(existsSync(join(root, 'si.deadline-result'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('late deadline result cannot overwrite a successful child exit', () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-deadline-success-'));
  try {
    const afterWait = POD_DEADLINE_AFTER_WAIT.replaceAll('/tmp/si.', `${root}/si.`);
    const run = Bun.spawnSync(['bash', '-c', `printf 'success\\n' > ${JSON.stringify(join(root, 'si.out'))}\nprintf 'deadline\\n' > ${JSON.stringify(join(root, 'si.deadline-result'))}\nrc=0\n${afterWait}\nprintf 'rc=%s\\n' "$rc"`]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain('rc=0');
    expect(readFileSync(join(root, 'si.out'), 'utf8')).toBe('success\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function goalWithCompletionBoundary(body: string): string {
  return `${body}\n\n## ACCEPTANCE CRITERIA\n- 완료 경계 코드: Pod Job이 요청한 기능을 실행한다.\n- 완료 경계 실물: 실행 결과가 Job 로그에 기록된다.\n- 완료 경계 증거 명령: bun test src/task-orchestrator/surfaces/self-implement-pod.test.ts`;
}

test('three consecutive Job NotFound polls end the parent with a pod-vanished stop; API errors reset the count', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-vanished-'));
  const runId = 'run-pod-vanished-three-polls';
  const base = fakeKubectl([], '');
  const responses = [
    { status: 1, stdout: '', stderr: 'Error from server (NotFound): jobs.batch "gone" not found' },
    { status: 1, stdout: '', stderr: 'Unable to connect to the server: 503 Service Unavailable' },
    { status: 1, stdout: '', stderr: 'Error from server (NotFound): jobs.batch "gone" not found' },
    { status: 1, stdout: '', stderr: 'Error from server (NotFound): jobs.batch "gone" not found' },
    { status: 1, stdout: '', stderr: 'Error from server (NotFound): jobs.batch "gone" not found' },
  ];
  let polls = 0;
  const kubectl: Kubectl = (args, input) => args.includes('jsonpath={.status.conditions[*].type}')
    ? responses[polls++] ?? (() => { throw new Error('Job poll did not end'); })()
    : base.k(args, input);
  try {
    const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, pollMs: 1, sleep: async () => {},
      env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: runId } })({ feature: 'fix', spaceId: 'pod-vanished-test' }).done;
    expect(polls).toBe(5);
    expect(result.exitCode).toBe(1);
    expect(result.error?.code).toBe('pod-vanished');
    const stops = (loadRunLedger(runId, runLedgerDir(root)) ?? []).filter((entry) => entry.event === 'stop');
    expect(stops).toHaveLength(1);
    expect(stops[0]?.data).toMatchObject({ class: 'pod-vanished', site: 'pod-job-poll' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a live Job with ledger and worktree both unmeasurable emits one incident after 120 minutes and keeps running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-unmeasurable-'));
  const runId = 'run-pod-unmeasurable-live';
  const base = fakeKubectl([], '{"ok":true,"stage":"complete"}\n');
  let polls = 0;
  let clock = 0;
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: ++polls > 6 ? 'Complete' : '', stderr: '' };
    if (args.includes('exec')) return { status: 1, stdout: '', stderr: 'ledger/worktree unreadable' };
    return base.k(args, input);
  };
  const warn = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, pollMs: 1,
      sleep: async () => { clock += 30 * 60_000; }, now: () => clock,
      env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: runId } })({ feature: 'fix', spaceId: 'pod-unmeasurable-test' }).done;
    expect(polls).toBe(7);
    expect(result.exitCode).toBe(0);
    const incidents = (loadRunLedger(runId, runLedgerDir(root)) ?? []).filter((entry) => entry.event === 'pod-stall-unmeasurable-incident');
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.data).toMatchObject({ jobStatus: 'alive', ledgerRead: false, activityMeasured: false, unmeasurableMs: 120 * 60_000 });
    expect(warn).toHaveBeenCalled();
  } finally { warn.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

/** POD-LAUNCH-PROVENANCE — drop the launch-specific si-task provenance set so a baseline manifest compares the rest. */
function stripSiTaskProvenance(job: { metadata: { labels?: Record<string, string> }; spec: { template: { metadata: { labels?: Record<string, string>; annotations?: Record<string, string> }; spec: { containers: Array<{ env?: Array<{ name: string }> }> } } } }): void {
  for (const labels of [job.metadata.labels, job.spec.template.metadata.labels]) {
    for (const key of Object.keys(labels ?? {})) if (key.startsWith('elanous.ai/')) delete labels![key];
  }
  delete job.spec.template.metadata.annotations;
  for (const container of job.spec.template.spec.containers) {
    if (container.env) container.env = container.env.filter((entry) => !POD_PROVENANCE_ENV_NAMES.includes(entry.name));
  }
}

function fakeKubectl(conditions: string[], logs: string, containerExitCode?: number) {
  const calls: Array<{ args: string; input?: string }> = [];
  let polls = 0;
  const k: Kubectl = (args, input) => {
    calls.push({ args: args.join(' '), ...(input ? { input } : {}) });
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (containerExitCode !== undefined && args.includes('pods')
      && args.some((a) => a.includes('status.containerStatuses') || a.includes('.terminated.exitCode'))) {
      const row = containerExitCode === 0 ? 'Completed\t0' : `Error\t${containerExitCode}`;
      return { status: 0, stdout: `2026-10-21T04:00:00Z\t${row}\n`, stderr: '' };
    }
    if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };   // 재개 존재 확인 — 새 Job
    if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: conditions[Math.min(polls++, conditions.length - 1)] ?? '', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: logs, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { k, calls };
}

test('Pod Job records the selected image without attributing a different local commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-job-image-ledger-'));
  const parentRunId = 'run-job-image-ledger-fixture';
  const localImage = 'registry.example/harness:local';
  const selectedImage = 'registry.example/harness:remote';
  const imageCommit = 'a'.repeat(40);
  const { k } = fakeKubectl(['Complete'], '{"ok":true,"stage":"complete"}\n');
  const pool = { tryAcquire: () => ({ context: 'test-context', imageRef: selectedImage, capacity: 2 }), release: () => {}, snapshot: () => ({}) };
  try {
    await podSelfImplementSpawn({ kubectl: k, pool: pool as never, sleep: async () => {}, credentials: CREDS,
      image: localImage, imageCommit, env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: parentRunId } })({ feature: 'x', spaceId: 'job-image-ledger-fixture' }).done;
    const entries = loadRunLedger(parentRunId, runLedgerDir(root)) ?? [];
    expect(entries.find((entry) => entry.event === 'pod-job-image')?.data).toMatchObject({
      image: selectedImage, imageCommit: null, context: 'test-context',
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Pod Job records the supplied commit when the selected image is the local image', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-local-image-ledger-'));
  const parentRunId = 'run-local-image-ledger-fixture';
  const image = 'registry.example/harness:local';
  const imageCommit = 'a'.repeat(40);
  const { k } = fakeKubectl(['Complete'], '{"ok":true,"stage":"complete"}\n');
  try {
    await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS,
      image, imageCommit, env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: parentRunId } })({ feature: 'x', spaceId: 'local-image-ledger-fixture' }).done;
    const entries = loadRunLedger(parentRunId, runLedgerDir(root)) ?? [];
    expect(entries.find((entry) => entry.event === 'pod-job-image')?.data).toMatchObject({ image, imageCommit, context: 'test-context' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Pod slot wait records one correlated request, queue, and admission observation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-slot-observation-'));
  const parentRunId = 'run-pod-slot-observation';
  const { k } = fakeKubectl(['Complete'], '{"ok":true,"stage":"complete"}\n');
  const slotEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
  const debugSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
    if (category === 'pod.slot') slotEvents.push({ event, data: data as Record<string, unknown> });
  }) as typeof debug.log);
  let attempts = 0;
  const pool = {
    members: [{ context: 'pool-node-b', capacity: 3, k3dCluster: 'node-b' }],
    tryAcquire: (_skip: unknown, onEmpty: (reason: string) => void) => {
      attempts++;
      if (attempts === 1) { onEmpty('no free slot · free={"pool-node-b":0}'); return null; }
      return { context: 'pool-node-b', capacity: 3 };
    },
    release: () => {},
    snapshot: () => ({ 'pool-node-b': 2 }),
  };
  try {
    const result = await podSelfImplementSpawn({ kubectl: k, pool: pool as never, pollMs: 0,
      sleep: async () => {}, credentials: CREDS,
      env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: parentRunId } })({ feature: 'slot observation', spaceId: 'pod-slot-observation' }).done;
    expect(result.exitCode).toBe(0);
    const rows = (loadRunLedger(parentRunId, runLedgerDir(root)) ?? []).filter((entry) => entry.event === 'pod-slot-observation');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.data).toMatchObject({ outcome: 'requested', reasonCode: 'pending', poolCapacity: 3 });
    expect(rows[1]?.data).toMatchObject({ outcome: 'queued', reasonCode: 'no-free-slot', poolCapacity: 3, occupants: { 'pool-node-b': 2 } });
    expect(rows[2]?.data).toMatchObject({ outcome: 'admitted', reasonCode: 'no-free-slot', poolCapacity: 3, occupants: { 'pool-node-b': 2 } });
    expect(new Set(rows.map((row) => row.data.observationKey)).size).toBe(1);
    expect(slotEvents.map((row) => row.event)).toEqual(['requested', 'queued', 'admitted']);
    expect(slotEvents[1]?.data).toMatchObject({ observationKey: rows[0]?.data.observationKey, parentId: parentRunId, queued: true });
  } finally { debugSpy.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('aborted Pod slot wait retains the first reasonCode on its no-launch result and incident rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-slot-abort-'));
  const parentRunId = 'run-pod-slot-abort';
  const controller = new AbortController();
  const { k } = fakeKubectl([], '');
  let reasonEvents = 0;
  const pool = {
    members: [{ context: 'pool-node-b', capacity: 2, k3dCluster: 'node-b' }],
    tryAcquire: (_skip: unknown, onEmpty: (reason: string) => void) => { onEmpty('no free slot'); return null; },
    release: () => {}, snapshot: () => ({ 'pool-node-b': 2 }),
  };
  const debugSpy = spyOn(debug, 'log').mockImplementation(((category: string, _event: string) => {
    if (category === 'pod.slot') reasonEvents++;
  }) as typeof debug.log);
  try {
    const result = await podSelfImplementSpawn({ kubectl: k, pool: pool as never, pollMs: 0,
      sleep: async () => { controller.abort(); }, credentials: CREDS,
      env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: parentRunId } })
      ({ feature: 'slot abort', spaceId: 'pod-slot-abort', signal: controller.signal }).done;
    expect(result.error).toMatchObject({ code: 'aborted', reasonCode: 'no-free-slot' });
    const rows = (loadRunLedger(parentRunId, runLedgerDir(root)) ?? []).filter((entry) => entry.event === 'pod-slot-observation');
    expect(rows.map((row) => row.data.outcome)).toEqual(['requested', 'queued', 'rejected']);
    expect(new Set(rows.map((row) => row.data.observationKey)).size).toBe(1);
    expect(rows.at(-1)?.data.reasonCode).toBe('no-free-slot');
    const incidents = (loadRunLedger(parentRunId, runLedgerDir(root)) ?? []).filter((entry) => entry.event === 'pod-slot-incident');
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.data).toMatchObject({ observationKey: rows.at(-1)?.data.observationKey, runId: rows.at(-1)?.data.runId,
      host: rows.at(-1)?.data.host, requestedAt: rows.at(-1)?.data.requestedAt, waitedMs: rows.at(-1)?.data.waitedMs,
      queued: false, poolCapacity: 2, reasonCode: 'no-free-slot', parentId: parentRunId, outcome: 'rejected' });
    expect(reasonEvents).toBe(3);
  } finally { debugSpy.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('OOM retry records a fresh Pod slot wait observation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-slot-oom-retry-'));
  const parentRunId = 'run-pod-slot-oom-retry';
  let appliedJobs = 0;
  let now = 1_000;
  let abortRetry = false;
  let retryAbortController: AbortController | undefined;
  const slotEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
  const debugSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
    if (category === 'pod.slot') slotEvents.push({ event, data: data as Record<string, unknown> });
  }) as typeof debug.log);
  const k: Kubectl = (args, input) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.includes('apply') && input) {
      if ((JSON.parse(input) as { kind?: string }).kind === 'Job') appliedJobs++;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args.includes('get') && args.includes('job') && args.some((arg) => arg.includes('.metadata.uid'))) {
      return { status: 1, stdout: '', stderr: 'NotFound' };
    }
    if (args.includes('get') && args.includes('nodes')) return { status: 0, stdout: JSON.stringify({ items: [
      { metadata: { name: 'node-1' }, status: { allocatable: { memory: '64Gi', cpu: '8' }, conditions: [{ type: 'Ready', status: 'True' }] } },
    ] }), stderr: '' };
    if (args.includes('get') && args.includes('deployment') && args.includes('coredns')) {
      return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
    }
    if (args.includes('get') && args.includes('jobs')) return { status: 0, stdout: '{"items":[]}', stderr: '' };
    if (args.includes('create') || args.includes('wait')) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('get') && args.some((arg) => arg.startsWith('pod/elanous-dns-'))) {
      return { status: 0, stdout: JSON.stringify({ status: { phase: 'Succeeded', containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] } }), stderr: '' };
    }
    if (args.includes('get') && args.includes('pods') && args.some((arg) => arg.startsWith('jsonpath={range .items[*]}'))) {
      return { status: 0, stdout: appliedJobs === 1 ? '2026-10-27T00:00:00Z\tOOMKilled\t137\t2026-10-27T00:00:01Z\t\t\t|Failed\tjob-uid\n' : '', stderr: '' };
    }
    if (args.includes('get') && args.includes('job') && args.some((arg) => arg.includes('.status.conditions[*].type'))) {
      return { status: 0, stdout: appliedJobs === 1 ? 'Failed' : 'Complete', stderr: '' };
    }
    if (args.includes('get') && args.includes('job') && args.some((arg) => arg.startsWith('jsonpath={.status.conditions['))) {
      return { status: 0, stdout: 'BackoffLimitExceeded|\t10800\tjob-uid\t2026-10-27T00:00:00Z\t2026-10-27T00:00:01Z', stderr: '' };
    }
    if (args.includes('get') && args.includes('pods') && args.includes('json')) return { status: 0, stdout: '{"items":[]}', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: args.some((arg) => arg.startsWith('pod/elanous-dns-'))
      ? 'Name: kubernetes.default.svc.cluster.local\nAddress: 10.0.0.1\n'
      : '{"kind":"self","ok":true,"result":{"stage":"complete","ok":true}}\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  let slotRequests = 0;
  const pool = {
    members: [{ context: 'test-context', capacity: 1, k3dCluster: 'test' }],
    tryAcquire: (_skip: unknown, onEmpty: (reason: string) => void) => {
      slotRequests++;
      if (slotRequests === 1) { now += 3; onEmpty('no free slot'); return null; }
      if (slotRequests === 3) { now += 7; onEmpty('pod lease capacity unavailable'); return null; }
      return { context: 'test-context', capacity: 1 };
    },
    release: () => {}, snapshot: () => ({ 'test-context': 0 }),
  };
  try {
    const result = await podSelfImplementSpawn({ kubectl: k, pool: pool as never, pollMs: 0,
      sleep: async () => { now += 10; if (abortRetry && slotRequests === 3) retryAbortController?.abort(); }, credentials: CREDS, now: () => now,
      env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: parentRunId,
        ELANOUS_POD_MEMORY: '4Gi', ELANOUS_POD_MEMORY_HIGH: '8Gi' } })
      ({ feature: 'OOM retry slot observation', spaceId: 'pod-slot-oom-retry' }).done;
    const rows = (loadRunLedger(parentRunId, runLedgerDir(root)) ?? []).filter((entry) => entry.event === 'pod-slot-observation');
    expect(appliedJobs).toBe(2);
    expect(slotRequests).toBe(4);
    expect(result.error?.code).toBeUndefined();
    expect(rows.map((row) => row.data.outcome)).toEqual(['requested', 'queued', 'admitted', 'requested', 'queued', 'admitted']);
    const requests = rows.filter((row) => row.data.outcome === 'requested');
    const queues = rows.filter((row) => row.data.outcome === 'queued');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.data.observationKey).not.toBe(requests[1]?.data.observationKey);
    expect(queues.map((row) => row.data.reasonCode)).toEqual(['no-free-slot', 'capacity']);
    expect(queues.map((row) => row.data.waitedMs)).toEqual([3, 7]);
    expect(slotEvents.filter((row) => row.event === 'queued').map((row) => row.data.observationKey))
      .toEqual(requests.map((row) => row.data.observationKey));

    // The second Job OOMs, then the retry's queued slot request is aborted. It must still
    // write the same rejected observation and incident as an abort on the first acquisition.
    const abortRoot = mkdtempSync(join(tmpdir(), 'pod-slot-oom-retry-abort-'));
    const abortParentRunId = 'run-pod-slot-oom-retry-abort';
    appliedJobs = 0;
    slotRequests = 0;
    now = 1_000;
    slotEvents.length = 0;
    abortRetry = true;
    retryAbortController = new AbortController();
    try {
      const aborted = await podSelfImplementSpawn({ kubectl: k, pool: pool as never, pollMs: 0,
        sleep: async () => { now += 10; if (slotRequests === 3) retryAbortController?.abort(); }, credentials: CREDS, now: () => now,
        env: { ELANOUS_STATE_DIR: abortRoot, ELANOUS_RUN_ID: abortParentRunId,
          ELANOUS_POD_MEMORY: '4Gi', ELANOUS_POD_MEMORY_HIGH: '8Gi' } })
        ({ feature: 'OOM retry slot abort observation', spaceId: 'pod-slot-oom-retry-abort', signal: retryAbortController.signal }).done;
      expect(appliedJobs).toBe(1);
      expect(slotRequests).toBe(3);
      expect(aborted.error).toMatchObject({ code: 'aborted', reasonCode: 'capacity' });
      const abortRows = (loadRunLedger(abortParentRunId, runLedgerDir(abortRoot)) ?? []).filter((entry) => entry.event === 'pod-slot-observation');
      expect(abortRows.map((row) => row.data.outcome)).toEqual(['requested', 'queued', 'admitted', 'requested', 'queued', 'rejected']);
      const retryRows = abortRows.slice(3);
      expect(new Set(retryRows.map((row) => row.data.observationKey)).size).toBe(1);
      expect(retryRows.at(-1)?.data).toMatchObject({ reasonCode: 'capacity', outcome: 'rejected', queued: false });
      const abortIncidents = (loadRunLedger(abortParentRunId, runLedgerDir(abortRoot)) ?? []).filter((entry) => entry.event === 'pod-slot-incident');
      expect(abortIncidents).toHaveLength(1);
      expect(abortIncidents[0]?.data).toMatchObject({ observationKey: retryRows.at(-1)?.data.observationKey,
        reasonCode: 'capacity', outcome: 'rejected', parentId: abortParentRunId });
    } finally { retryAbortController = undefined; rmSync(abortRoot, { recursive: true, force: true }); }
  } finally { debugSpy.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('Pod image digest ledger distinguishes the first Pod from its final replacement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-image-digest-replacement-'));
  const parentRunId = 'run-image-digest-replacement';
  const finalId = `docker.io/example/harness@sha256:${'b'.repeat(64)}`;
  const { k: base } = fakeKubectl(['', 'Complete'], '{"ok":true,"stage":"complete"}\n');
  let jobName = '';
  const pod = (name: string, at: string, imageID: string, owner = jobName) => ({
    metadata: { name, uid: `${name}-uid`, creationTimestamp: at, ownerReferences: [{ kind: 'Job', name: owner, uid: 'job-uid' }] },
    status: { containerStatuses: [{ name: 'child', imageID }] },
  });
  let reads = 0;
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('apply') && input) {
      const resource = JSON.parse(input) as { kind?: string; metadata?: { name?: string } };
      if (resource.kind === 'Job') jobName = resource.metadata?.name ?? '';
    }
    if (args.includes('get') && args.includes('pods') && args.includes('json')) {
      reads++;
      const items = reads === 1
        ? [pod('pod-first', '2026-10-21T01:00:00Z', '')]
        : [pod('pod-first', '2026-10-21T01:00:00Z', ''),
          pod('pod-final', '2026-10-21T01:01:00Z', finalId),
          pod('pod-unrelated', '2026-10-21T01:02:00Z', finalId, 'other-job')];
      return { status: 0, stdout: JSON.stringify({ items }), stderr: '' };
    }
    return base(args, input);
  };
  try {
    await podSelfImplementSpawn({ kubectl, sleep: async () => {}, credentials: CREDS,
      env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: parentRunId } })({ feature: 'x', spaceId: 'image-digest-replacement' }).done;
    const records = (loadRunLedger(parentRunId, runLedgerDir(root)) ?? [])
      .filter((entry) => entry.event === 'pod-image-digest').map((entry) => entry.data);
    expect(records).toEqual([
      expect.objectContaining({ podName: 'pod-first', podUid: 'pod-first-uid',
        podCreatedAt: '2026-10-21T01:00:00Z', imageID: '', digest: null,
        digestUnavailable: 'image-id-missing', final: false }),
      expect.objectContaining({ podName: 'pod-final', podUid: 'pod-final-uid',
        podCreatedAt: '2026-10-21T01:01:00Z', imageID: finalId,
        digest: `sha256:${'b'.repeat(64)}`, final: true }),
    ]);
    expect(reads).toBeGreaterThanOrEqual(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Pod image digest ledger preserves unrecognized imageID and a missing-ID reason', async () => {
  for (const imageID of ['containerd://unrecognized', '']) {
    const root = mkdtempSync(join(tmpdir(), 'pod-image-digest-unavailable-'));
    const parentRunId = `run-image-digest-${imageID ? 'nonstandard' : 'missing'}`;
    const { k: base } = fakeKubectl(['Complete'], '{"ok":true,"stage":"complete"}\n');
    let jobName = '';
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('apply') && input) {
        const resource = JSON.parse(input) as { kind?: string; metadata?: { name?: string } };
        if (resource.kind === 'Job') jobName = resource.metadata?.name ?? '';
      }
      if (args.includes('get') && args.includes('pods') && args.includes('json')) return { status: 0,
        stdout: JSON.stringify({ items: [{ metadata: { name: 'pod-final', creationTimestamp: '2026-10-21T01:00:00Z',
          ownerReferences: [{ kind: 'Job', name: jobName }] }, status: { containerStatuses: [{ name: 'child', imageID }] } }] }), stderr: '' };
      return base(args, input);
    };
    try {
      await podSelfImplementSpawn({ kubectl, sleep: async () => {}, credentials: CREDS,
        env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: parentRunId } })({ feature: 'x', spaceId: 'image-digest-unavailable' }).done;
      const final = (loadRunLedger(parentRunId, runLedgerDir(root)) ?? [])
        .filter((entry) => entry.event === 'pod-image-digest' && entry.data.final).at(-1)?.data;
      expect(final).toMatchObject({ podName: 'pod-final', imageID, digest: null,
        digestUnavailable: imageID ? 'nonstandard-image-id' : 'image-id-missing', final: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('Pod image digest ledger observes a Pod that appears after three empty polls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-image-digest-late-'));
  const parentRunId = 'run-image-digest-late';
  const imageID = `docker.io/example/harness@sha256:${'c'.repeat(64)}`;
  const { k: base } = fakeKubectl(['', '', '', '', 'Complete'], '{"ok":true,"stage":"complete"}\n');
  let jobName = '';
  let reads = 0;
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('apply') && input) {
      const resource = JSON.parse(input) as { kind?: string; metadata?: { name?: string } };
      if (resource.kind === 'Job') jobName = resource.metadata?.name ?? '';
    }
    if (args.includes('get') && args.includes('pods') && args.includes('json')) {
      const items = ++reads > 3 ? [{ metadata: { name: 'pod-late', uid: 'pod-late-uid',
        creationTimestamp: '2026-10-21T01:04:00Z', ownerReferences: [{ kind: 'Job', name: jobName }] },
      status: { containerStatuses: [{ name: 'child', imageID }] } }] : [];
      return { status: 0, stdout: JSON.stringify({ items }), stderr: '' };
    }
    return base(args, input);
  };
  try {
    await podSelfImplementSpawn({ kubectl, sleep: async () => {}, credentials: CREDS,
      env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: parentRunId } })({ feature: 'x', spaceId: 'image-digest-late' }).done;
    const records = (loadRunLedger(parentRunId, runLedgerDir(root)) ?? [])
      .filter((entry) => entry.event === 'pod-image-digest').map((entry) => entry.data);
    expect(records[0]).toMatchObject({ podName: 'pod-late', podUid: 'pod-late-uid', imageID, final: false });
    expect(records.at(-1)).toMatchObject({ podName: 'pod-late', podUid: 'pod-late-uid', imageID, final: true });
    expect(reads).toBeGreaterThan(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Pod image digest ledger records first and final rows when Pod appears at terminal read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-image-digest-terminal-'));
  const parentRunId = 'run-image-digest-terminal';
  const imageID = `docker.io/example/harness@sha256:${'d'.repeat(64)}`;
  const { k: base } = fakeKubectl(['Complete'], '{"ok":true,"stage":"complete"}\n');
  let jobName = '';
  let reads = 0;
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('apply') && input) {
      const resource = JSON.parse(input) as { kind?: string; metadata?: { name?: string } };
      if (resource.kind === 'Job') jobName = resource.metadata?.name ?? '';
    }
    if (args.includes('get') && args.includes('pods') && args.includes('json')) {
      const items = ++reads === 1 ? [] : [{ metadata: { name: 'pod-terminal', uid: 'pod-terminal-uid',
        creationTimestamp: '2026-10-21T01:05:00Z', ownerReferences: [{ kind: 'Job', name: jobName }] },
      status: { containerStatuses: [{ name: 'child', imageID }] } }];
      return { status: 0, stdout: JSON.stringify({ items }), stderr: '' };
    }
    return base(args, input);
  };
  try {
    await podSelfImplementSpawn({ kubectl, sleep: async () => {}, credentials: CREDS,
      env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: parentRunId } })({ feature: 'x', spaceId: 'image-digest-terminal' }).done;
    const records = (loadRunLedger(parentRunId, runLedgerDir(root)) ?? [])
      .filter((entry) => entry.event === 'pod-image-digest').map((entry) => entry.data);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ podName: 'pod-terminal', podUid: 'pod-terminal-uid', imageID, final: false });
    expect(records[1]).toMatchObject({ podName: 'pod-terminal', podUid: 'pod-terminal-uid', imageID, final: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('Pod kubectl output limit', () => {
  test('defaultKubectl passes the lease maxBuffer to spawnSync and names ENOBUFS as oversized output', () => {
    const original = childProcess.spawnSync;
    const calls: Array<{ command: string; args: string[]; options: SpawnSyncOptionsWithStringEncoding }> = [];
    const spy = spyOn(childProcess, 'spawnSync').mockImplementation(((command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
      calls.push({ command, args, options });
      return { status: null, stdout: '', stderr: '', output: [], pid: 0, signal: null, error: Object.assign(new Error('maxBuffer exceeded'), { code: 'ENOBUFS' }) } as ReturnType<typeof original>;
    }) as typeof original);
    try {
      const result = defaultKubectl(['get', 'pods']);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ command: 'kubectl', args: ['get', 'pods'], options: { encoding: 'utf8', timeout: 120_000, maxBuffer: LEASE_KUBECTL_MAX_BUFFER } });
      defaultKubectl(['get', 'jobs'], undefined, 15_000);
      expect(calls[1]).toMatchObject({ command: 'kubectl', args: ['get', 'jobs'], options: { timeout: 15_000 } });
      expect(result.status).toBeNull();
      expect(result.stderr).toContain('출력 너무 큼 (ENOBUFS');
    } finally { spy.mockRestore(); }
  });

  test('defaultKubectl reads fake kubectl output larger than the Node 1MiB default without ENOBUFS', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-kubectl-buffer-'));
    const oldPath = process.env.PATH;
    try {
      const fake = join(root, 'kubectl');
      writeFileSync(fake, '#!/bin/sh\nhead -c 1048577 /dev/zero | tr "\\\\000" x\n');
      chmodSync(fake, 0o755);
      process.env.PATH = `${root}:${oldPath ?? ''}`;
      const result = defaultKubectl(['get', 'pods']);
      expect(result.status).toBe(0);
      expect(result.stdout.length).toBe(1_048_577);
      expect(result.stderr).toBe('');
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('lease measurement keeps all namespaces for node reservations; a run-label selector would falsely admit high memory', () => {
    const calls: string[][] = [];
    const kubectl: Kubectl = (args) => {
      calls.push([...args]);
      const resource = args[args.indexOf('get') + 1];
      if (resource === 'nodes') return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'node-a' }, status: { allocatable: { memory: '64Gi', cpu: '8' }, conditions: [{ type: 'Ready', status: 'True' }] } }] }), stderr: '' };
      if (resource === 'jobs') return { status: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
      if (resource === 'pods') return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'unrelated', namespace: 'other', labels: {} }, status: { phase: 'Running' }, spec: { nodeName: 'node-a', containers: [{ resources: { requests: { memory: '40Gi' } } }] } }] }), stderr: '' };
      throw new Error(`unexpected kubectl call: ${args.join(' ')}`);
    };
    const measurement = measurePoolLease([{ context: 'ctx', capacity: 1, k3dCluster: '' }], { kubectl, dns: () => 'ready' });
    expect(calls.find((args) => args.includes('get') && args.includes('jobs'))).toEqual(expect.arrayContaining(['-l', 'elanous.substrate=pod']));
    const podQuery = calls.find((args) => args.includes('get') && args.includes('pods'))!;
    expect(podQuery).toContain('--all-namespaces');
    expect(podQuery).not.toContain('-l');
    expect(measurement.members[0]?.availableMemoryByNodeBytes).toEqual([24 * 1024 ** 3]);
    expect(recommendConcurrency(measurement, { capacity: 1, perGoalMemory: '32Gi', accounts: 0, perAccount: 0 }).placeableSlots).toBe(0);
  });
});

describe('pod source delivery', () => {
  test('records source IO marker as one debug event and warns on malformed marker', () => {
    const rows: Array<{ category: string; event: string; data: Record<string, unknown>; options?: { level?: string } }> = [];
    const log = (category: string, event: string, data: Record<string, unknown>, options?: { level?: string }) => rows.push({ category, event, data, options });
    recordPodSourceIoSummary('noise\nELANOUS_POD_SOURCE_IO {"originCalls":2,"checkoutFiles":17,"sourceVia":"github","sourceSeconds":3,"sourceStatus":"complete","pushCalls":null,"installRan":null,"installSeconds":null}\n', 'job-1', 'run-1', 'pod-launch-child-run-id', log, 1);
    expect(rows).toEqual([{ category: 'pod.source', event: 'io-summary', data: {
      job: 'job-1', runId: 'run-1', runIdSource: 'pod-launch-child-run-id', hostOriginCalls: 1, originCalls: 2, checkoutFiles: 17, sourceVia: 'github', sourceSeconds: 3,
      sourceStatus: 'complete', pushCalls: null, installRan: null, installSeconds: null,
    }, options: undefined }]);
    rows.length = 0;
    recordPodSourceIoSummary('ELANOUS_POD_SOURCE_IO {bad-json}\n', 'job-1', null, 'pod-launch-child-run-id', log);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: 'pod.source', event: 'io-summary-invalid', data: { job: 'job-1', runId: null, runIdSource: 'pod-launch-child-run-id' }, options: { level: 'warn' } });
  });

  const bundle: PodSource = { kind: 'bundle', bundlePath: '/host/source.bundle', sha256: 'ab'.repeat(32), sizeBytes: 12, headCommit: 'cd'.repeat(20) };

  function sourceKubectl(phase: string) {
    const calls: string[] = [];
    const k: Kubectl = (args) => {
      calls.push(args.join(' '));
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.includes('pods')) return { status: 0, stdout: `si-pod ${phase}\n`, stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    return { k, calls };
  }

  test('bundle source applies the Job, then cp, then touch /tmp/source.ready', async () => {
    const { k, calls } = sourceKubectl('Running');
    await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS, source: bundle })({ feature: 'x', spaceId: 'src-bundle' }).done;
    const applyAt = calls.findIndex((c) => c.endsWith('apply -f -') && calls.filter((x) => x.endsWith('apply -f -')).length >= 1 && c === calls.filter((x) => x.endsWith('apply -f -'))[1]);
    const cpAt = calls.findIndex((c) => c.includes(' cp ') && c.includes('/tmp/source.bundle') && c.includes('-c child'));
    const touchAt = calls.findIndex((c) => c.includes('exec') && c.includes('touch /tmp/source.ready'));
    expect(applyAt).toBeGreaterThanOrEqual(0);
    expect(cpAt).toBeGreaterThan(applyAt);
    expect(touchAt).toBeGreaterThan(cpAt);
  });

  test('omitted source never calls kubectl cp', async () => {
    const { k, calls } = sourceKubectl('Running');
    await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS })({ feature: 'x', spaceId: 'src-default' }).done;
    expect(calls.filter((c) => c.includes(' cp '))).toHaveLength(0);
  });
});

describe('pod codex rotation credentials', () => {
  // 2026-09-27 measured: default over the 60% cap left only `third` → the pod store had no base
  // `openai-codex` entry and `auto` answered «No LLM provider available» on the first call.
  test('a single named account still gets the base openai-codex entry the auto resolver reads', async () => {
    const { k, calls } = fakeKubectl(['Complete'], '');
    const creds = (account: string) => ({
      elanousAuth: JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: `access-${account}`, refreshToken: '' } } } }),
      codexAuth: JSON.stringify({ tokens: { access_token: `access-${account}`, refresh_token: '' } }), ghToken: 'gh',
    });
    await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, accountBroker: () => 'third', rotationAccounts: ['third'], credentials: creds, env: {} })({ feature: 'x', spaceId: 'single-named', autoDrive: 'safe', signal: new AbortController().signal } as never).done.catch(() => {});
    const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
    const script: string = job.spec.template.spec.containers[0].args[0];
    const home = mkdtempSync(join(tmpdir(), 'pod-single-home-'));
    try {
      const mount = join(home, 'creds'); mkdirSync(mount);
      for (const [key, value] of Object.entries(secret.stringData) as Array<[string, string]>) writeFileSync(join(mount, key), value);
      const block = script.slice(script.indexOf('mkdir -p "$HOME/.elanous"'), script.indexOf('\nexport GH_TOKEN='));
      const run = Bun.spawnSync(['bash', '-c', block.replaceAll('/creds/', `${mount}/`)], { env: { ...process.env, HOME: home } });
      expect(run.exitCode).toBe(0);
      const store = JSON.parse(readFileSync(join(home, '.elanous', 'auth.json'), 'utf8'));
      expect(Object.keys(store.providers).sort()).toEqual(['openai-codex', 'openai-codex:third']);
      expect(loadTokens('openai-codex', join(home, '.elanous', 'auth.json'))?.tokens.accessToken).toBe('access-third');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('brokered allocation packages every usable account separately, reconstructs the account store and keeps explicit account single', async () => {
    const { k, calls } = fakeKubectl(['Complete'], '');
    const selected: string[] = [];
    const creds = (account: string) => {
      selected.push(account);
      return {
        elanousAuth: JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: `access-${account}`, refreshToken: '' } } } }),
        codexAuth: JSON.stringify({ tokens: { access_token: `access-${account}`, refresh_token: '' } }), ghToken: 'gh',
      };
    };
    await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, accountBroker: () => 'third', rotationAccounts: ['default', 'team', 'third'], credentials: creds, env: {} })({ feature: 'x', spaceId: 'rotation-pack' }).done;
    const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
    expect(selected).toEqual(['third', 'default', 'team']);
    expect(Object.keys(secret.stringData).filter((key) => key.startsWith('codex-')).sort()).toEqual(['codex-0.json', 'codex-1.json', 'codex-2.json']);
    expect(secret.stringData['codex-auth.json']).toBeUndefined();
    expect(job.spec.template.spec.volumes[0].secret.defaultMode).toBe(0o400);
    const script: string = job.spec.template.spec.containers[0].args[0];
    expect(script).toContain("export ELANOUS_CODEX_ACCOUNT='third'");
    const home = mkdtempSync(join(tmpdir(), 'pod-rotation-home-'));
    try {
      const mount = join(home, 'creds'); mkdirSync(mount);
      for (const [key, value] of Object.entries(secret.stringData) as Array<[string, string]>) writeFileSync(join(mount, key), value);
      const block = script.slice(script.indexOf('mkdir -p "$HOME/.elanous"'), script.indexOf('\nexport GH_TOKEN='));
      const run = Bun.spawnSync(['bash', '-c', block.replaceAll('/creds/', `${mount}/`)], { env: { ...process.env, HOME: home } });
      expect(run.exitCode).toBe(0);
      const store = JSON.parse(readFileSync(join(home, '.elanous', 'auth.json'), 'utf8'));
      expect(Object.keys(store.providers)).toEqual(['openai-codex:third', 'openai-codex', 'openai-codex:team']);
      expect(statSync(join(home, '.elanous', 'auth.json')).mode & 0o777).toBe(0o600);
      for (const [i, name] of ['third', 'default', 'team'].entries()) {
        const key = name === 'default' ? 'openai-codex' : `openai-codex:${name}`;
        expect(store.providers[key].codexHome).toBe(join(home, '.elanous', 'codex-accounts', String(i)));
        expect(loadTokens(key, join(home, '.elanous', 'auth.json'))?.tokens.accessToken).toBe(`access-${name}`);
        const resolved = resolveCodexAccount({ ELANOUS_CODEX_ACCOUNT: name } as NodeJS.ProcessEnv, { storedHome: (storeKey) => loadTokens(storeKey, join(home, '.elanous', 'auth.json'))?.codexHome });
        expect(resolved.name).toBe(name);
        if (name !== 'default') expect(resolved.home).toBe(store.providers[key].codexHome);
        const authFile = join(store.providers[key].codexHome, 'auth.json');
        expect(JSON.parse(readFileSync(authFile, 'utf8')).tokens.access_token).toBe(`access-${name}`);
        expect(statSync(authFile).mode & 0o777).toBe(0o600);
      }
      expect(JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')).tokens.access_token).toBe('access-third');
    } finally { rmSync(home, { recursive: true, force: true }); }
    const single = fakeKubectl(['Complete'], '');
    await podSelfImplementSpawn({ kubectl: single.k, account: 'team', credentials: creds, env: {} })({ feature: 'x', spaceId: 'rotation-explicit' }).done;
    const [singleSecret, singleJob] = single.calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
    expect(singleSecret.stringData['codex-auth.json']).toBeDefined();
    expect(singleSecret.stringData['codex-1-auth.json']).toBeUndefined();
    expect(singleJob.spec.template.spec.containers[0].args[0]).toContain('cp /creds/codex-auth.json ~/.codex/auth.json');
    const second = fakeKubectl(['Complete'], '');
    await podSelfImplementSpawn({ kubectl: second.k, accountBroker: () => 'team', rotationAccounts: ['default', 'team', 'third'], credentials: creds, env: {} })({ feature: 'x', spaceId: 'rotation-second-allocation' }).done;
    const secondSecret = second.calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!))[0];
    expect(JSON.parse(secondSecret.stringData['codex-0.json']).codexAuth).toContain('access-team');
    expect(JSON.parse(secondSecret.stringData['codex-1.json']).codexAuth).toContain('access-default');
    expect(JSON.parse(secondSecret.stringData['codex-2.json']).codexAuth).toContain('access-third');
    const invalid = fakeKubectl(['Complete'], '');
    const bad = await podSelfImplementSpawn({ kubectl: invalid.k, accountBroker: () => 'third', rotationAccounts: ['third', 'third'], credentials: creds, env: {} })({ feature: 'x', spaceId: 'rotation-duplicate' }).done;
    expect(bad.error?.message).toContain('서로 다른 codex 계정');
    expect(invalid.calls.filter((c) => c.args.endsWith('apply -f -'))).toHaveLength(0);
  });

  test('every account is checked on the host and no account refresh token enters the Secret', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-rotation-host-'));
    try {
      const providers: Record<string, unknown> = {};
      const token = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
      for (const [i, name] of ['team', 'third'].entries()) {
        const codexHome = join(root, `home-${i}`);
        mkdirSync(codexHome);
        writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: token(Math.floor(Date.now() / 1000) + 200 * 3600), refresh_token: `cli-refresh-${name}`, account_id: `id-${name}` } }));
        providers[`openai-codex:${name}`] = { codexHome, tokens: { accessToken: 'stale', refreshToken: `store-refresh-${name}`, expiresAt: 1 } };
      }
      const store = join(root, 'auth.json');
      writeFileSync(store, JSON.stringify({ version: 1, providers }));
      const credentials = (name: string) => hostCredentials(name, store, () => 'gh');
      const { k, calls } = fakeKubectl(['Complete'], '');
      const result = await podSelfImplementSpawn({ kubectl: k, accountBroker: () => 'third', rotationAccounts: ['team', 'third'], credentials, env: {} })({ feature: 'x', spaceId: 'rotation-redaction' }).done;
      expect(result.exitCode).toBe(0);
      const secret = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!))[0];
      expect(JSON.stringify(secret)).not.toMatch(/cli-refresh-|store-refresh-/);
      for (const i of [0, 1]) {
        const account = JSON.parse(secret.stringData[`codex-${i}.json`]);
        expect(JSON.parse(account.codexAuth).tokens.refresh_token).toBe('');
        expect(JSON.parse(account.elanousAuth).providers['openai-codex'].tokens.refreshToken).toBe('');
      }
      const unredacted = fakeKubectl(['Complete'], '');
      const bad = await podSelfImplementSpawn({ kubectl: unredacted.k, accountBroker: () => 'third', rotationAccounts: ['team', 'third'], credentials: (name) => name === 'team' ? { ...credentials(name), codexAuth: JSON.stringify({ tokens: { refresh_token: 'unsafe' } }) } : credentials(name), env: {} })({ feature: 'x', spaceId: 'rotation-unredacted' }).done;
      expect(bad.error?.message).toContain('refresh');
      expect(unredacted.calls.filter((c) => c.args.endsWith('apply -f -'))).toHaveLength(0);
      const expired = join(root, 'home-0', 'auth.json');
      writeFileSync(expired, JSON.stringify({ tokens: { access_token: token(Math.floor(Date.now() / 1000) + 60), refresh_token: 'cli-refresh-team' } }));
      // POD-TOKEN-PREREFRESH (10-06): an expiring rotation candidate is dropped (no lease ⇒ no refresh), not fatal.
      const dropped = fakeKubectl(['Complete'], '');
      const kept = await podSelfImplementSpawn({ kubectl: dropped.k, accountBroker: () => 'third', rotationAccounts: ['team', 'third'], credentials, env: {} })({ feature: 'x', spaceId: 'rotation-expired' }).done;
      expect(kept.exitCode).toBe(0);
      const keptSecret = dropped.calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!))[0];
      expect(Object.keys(keptSecret.stringData).filter((key) => key.startsWith('codex-'))).toEqual(['codex-0.json']);
      writeFileSync(join(root, 'home-1', 'auth.json'), JSON.stringify({ tokens: { access_token: token(Math.floor(Date.now() / 1000) + 60), refresh_token: 'cli-refresh-third' } }));
      const rejected = fakeKubectl(['Complete'], '');
      const failure = await podSelfImplementSpawn({ kubectl: rejected.k, accountBroker: () => 'third', rotationAccounts: ['team', 'third'], credentials, env: {} })({ feature: 'x', spaceId: 'rotation-expired-all' }).done;
      expect(failure.error?.message).toContain('3시간 안에 만료');
      expect(rejected.calls.filter((c) => c.args.endsWith('apply -f -'))).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('pod terminal usage-limit retry', () => {
  const quota = JSON.stringify({ stage: 'abandoned', ok: false, error: '429 usage_limit_reached' });
  const success = JSON.stringify({ stage: 'pr-opened', ok: true, worktreePath: '/pod/only' });
  const credentials = (name: string) => ({
    elanousAuth: JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: name, refreshToken: '' } } } }),
    codexAuth: JSON.stringify({ tokens: { access_token: name, refresh_token: '' } }), ghToken: 'gh',
  });
  function simulation(results: string[]) {
    const applied: Array<Record<string, any>> = [];
    const calls: string[] = [];
    let attempt = -1;
    const kubectl: Kubectl = (args, input) => {
      const cmd = args.join(' ');
      calls.push(cmd);
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (cmd.includes('jsonpath={.metadata.uid} ')) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (cmd.endsWith('apply -f -')) {
        const manifest = JSON.parse(input!);
        applied.push(manifest);
        if (manifest.kind === 'Job') attempt++;
      }
      if (args.includes('logs')) return { status: 0, stdout: results[attempt] ?? '', stderr: '' };
      if (cmd.includes('get job') && cmd.includes('status.conditions[*].type')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    return { kubectl, applied, calls };
  }
  test('terminal 429 retries one chunk once on next remaining account; failed account is absent from retry Secret', async () => {
    const { kubectl, applied, calls } = simulation([quota, success]);
    const events: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-usage-limit-retry', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'usage-limit-retry') events.push(record.data as Record<string, unknown>);
    } });
    try {
      const result = await podSelfImplementSpawn({ kubectl, credentials, accountBroker: () => 'team', rotationAccounts: ['default', 'team', 'third'], env: {} })({ feature: 'same chunk', spaceId: 'quota-retry' }).done;
      expect(result.exitCode).toBe(0);
      expect(result.disposition).toMatchObject({ stage: 'pr-opened', worktreePath: undefined });
      const jobs = applied.filter((m) => m.kind === 'Job');
      const secrets = applied.filter((m) => m.kind === 'Secret');
      expect(jobs).toHaveLength(2);
      expect(secrets[0].stringData.feature).toBe(secrets[1].stringData.feature);
      expect(JSON.parse(secrets[1].stringData['codex-0.json']).codexAuth).toContain('default');
      expect(Object.keys(secrets[1].stringData).filter((key) => key.startsWith('codex-')).map((key) => JSON.parse(secrets[1].stringData[key]).codexAuth)).not.toContainEqual(expect.stringContaining('"access_token":"team"'));
      expect(Object.keys(secrets[1].stringData).filter((key) => key.startsWith('codex-'))).toHaveLength(2);
      expect(jobs[1].spec.template.spec.containers[0].args[0]).toContain("export ELANOUS_CODEX_ACCOUNT='default'");
      expect(jobs[0].spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value)
        .not.toBe(jobs[1].spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value);
      expect(calls.some((c) => c.includes('delete job') && c.includes('--wait=true'))).toBe(true);
      expect(events).toEqual([expect.objectContaining({ from: 'team', to: 'default' })]);
    } finally { off(); }
  });
  test('executed Pod child command: terminal 429 with a Complete Job still retries once without the failed account', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-quota-child-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'elanous'), `#!/bin/sh
[ "$1" = self ] && [ "$2" = implement ] && [ "$3" = 'same chunk' ] || exit 8
case "$ELANOUS_CODEX_ACCOUNT" in
  team) printf '%s\\n' '${quota}'; exit 0 ;;
  default) printf '%s\\n' '${success}'; exit 0 ;;
  *) exit 9 ;;
esac
`);
    chmodSync(join(bin, 'elanous'), 0o755);
    const applied: Array<Record<string, any>> = [];
    const executions: Array<{ account: string; feature: string; exitCode: number; state: string; terminal: Record<string, unknown> }> = [];
    const calls: string[] = [];
    let active: { state: string; log: string } | undefined;
    const kubectl: Kubectl = (args, input) => {
      const cmd = args.join(' ');
      calls.push(cmd);
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (cmd.includes('jsonpath={.metadata.uid} ')) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (cmd.endsWith('apply -f -')) {
        const manifest = JSON.parse(input!);
        applied.push(manifest);
        if (manifest.kind === 'Job') {
          const secret = applied.filter((item) => item.kind === 'Secret').at(-1)!;
          const featureFile = join(home, 'feature');
          const outputFile = join(home, 'si.out');
          writeFileSync(featureFile, secret.stringData.feature);
          const script: string = manifest.spec.template.spec.containers[0].args[0];
          const accountLine = script.split('\n').find((line) => line.startsWith('export ELANOUS_CODEX_ACCOUNT='))!;
          const command = script.split('\n').find((line) => line.includes('elanous self implement '))!;
          const runnable = command.replace(/^export ELANOUS_HARNESS_ENTRANCE=self-implement; /, '');
          const child = Bun.spawnSync(['bash', '-c', `${accountLine}\n${runnable.replace('/creds/feature', featureFile).replaceAll('/tmp/si.out', outputFile)}\ncat ${outputFile}\ntail -n 1 ${outputFile}\nexit $rc`], {
            cwd: home, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
          });
          const log = child.stdout.toString();
          const terminal = JSON.parse(log.trimEnd().split('\n').at(-1)!) as Record<string, unknown>;
          const state = child.exitCode === 0 ? 'Complete' : 'Failed';
          active = { state, log };
          executions.push({ account: /'([^']+)'/.exec(accountLine)![1]!, feature: secret.stringData.feature, exitCode: child.exitCode, state, terminal });
        }
      }
      if (cmd.includes('get job') && cmd.includes('status.conditions[*].type')) return { status: 0, stdout: active?.state ?? '', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: active?.log ?? '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, credentials, accountBroker: () => 'team', rotationAccounts: ['team', 'default'], env: {} })({ feature: 'same chunk', spaceId: 'quota-executed-child' }).done;
      expect(executions.map(({ account, feature, exitCode, state, terminal }) => ({ account, feature, exitCode, state, terminal }))).toEqual([
        { account: 'team', feature: 'same chunk', exitCode: 0, state: 'Complete', terminal: JSON.parse(quota) },
        { account: 'default', feature: 'same chunk', exitCode: 0, state: 'Complete', terminal: JSON.parse(success) },
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.disposition?.stage).toBe('pr-opened');
      expect(applied.filter((item) => item.kind === 'Job')).toHaveLength(2);
      const retrySecret = applied.filter((item) => item.kind === 'Secret')[1]!;
      expect(Object.keys(retrySecret.stringData).filter((key) => key.startsWith('codex-'))).toEqual(['codex-0.json']);
      expect(JSON.parse(JSON.parse(retrySecret.stringData['codex-0.json']).codexAuth).tokens.access_token).toBe('default');
      expect(calls.filter((cmd) => cmd.includes('delete job') && cmd.includes('--wait=true'))).toHaveLength(1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('second 429 is returned without another launch; non-terminal and explicit-account failures do not rotate', async () => {
    const twice = simulation([quota, quota]);
    const failed = await podSelfImplementSpawn({ kubectl: twice.kubectl, credentials, accountBroker: () => 'team', rotationAccounts: ['team', 'third'], env: {} })({ feature: 'chunk', spaceId: 'quota-twice' }).done;
    expect(failed.exitCode).toBe(1);
    expect(failed.disposition?.error).toBe('429 usage_limit_reached');
    expect(twice.applied.filter((m) => m.kind === 'Job')).toHaveLength(2);
    const noSpare = simulation([quota]);
    await podSelfImplementSpawn({ kubectl: noSpare.kubectl, credentials, accountBroker: () => 'team', rotationAccounts: ['team'], env: {} })({ feature: 'chunk', spaceId: 'quota-no-spare' }).done;
    expect(noSpare.applied.filter((m) => m.kind === 'Job')).toHaveLength(1);
    const other = simulation([JSON.stringify({ stage: 'abandoned', ok: false, error: '429 different_error' })]);
    await podSelfImplementSpawn({ kubectl: other.kubectl, credentials, accountBroker: () => 'team', rotationAccounts: ['team', 'third'], env: {} })({ feature: 'chunk', spaceId: 'quota-other' }).done;
    expect(other.applied.filter((m) => m.kind === 'Job')).toHaveLength(1);
    const explicit = simulation([quota]);
    await podSelfImplementSpawn({ kubectl: explicit.kubectl, credentials, account: 'team', env: {} })({ feature: 'chunk', spaceId: 'quota-explicit' }).done;
    expect(explicit.applied.filter((m) => m.kind === 'Job')).toHaveLength(1);
    const nonTerminal = simulation([`${quota}\n{"stage":"abandoned","ok":false,"error":"different_error"}`]);
    await podSelfImplementSpawn({ kubectl: nonTerminal.kubectl, credentials, accountBroker: () => 'team', rotationAccounts: ['team', 'third'], env: {} })({ feature: 'chunk', spaceId: 'quota-not-terminal' }).done;
    expect(nonTerminal.applied.filter((m) => m.kind === 'Job')).toHaveLength(1);
  });
});

describe('pod grok credentials', () => {
  test('POD4: a token expiring within 3 h is refreshed on the host before the copy, and only then shipped', () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-grok-refresh-'));
    try {
      mkdirSync(join(home, '.grok'));
      const authPath = join(home, '.grok', 'auth.json');
      writeFileSync(authPath, JSON.stringify({ 'https://auth.x.ai::client': { key: 'old-access', expires_at: new Date(Date.now() + 60_000).toISOString(), refresh_token: 'r' } }));
      let refreshed = 0;
      const out = hostGrokCredentials({ home, env: {}, ghToken: () => 'gh', refresh: () => {
        refreshed += 1;
        writeFileSync(authPath, JSON.stringify({ 'https://auth.x.ai::client': { key: 'new-access', expires_at: new Date(Date.now() + 6 * 3600_000).toISOString(), refresh_token: 'r' } }));
      } });
      expect(refreshed).toBe(1);
      expect(out.grokAuth).toContain('new-access');
      expect(out.grokAuth).not.toContain('old-access');
      expect(out.grokAuth).not.toContain('refresh_token');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('POD4: when the host refresh cannot extend it, the copy is refused with a reason instead of shipping a dying token', () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-grok-stale-'));
    try {
      mkdirSync(join(home, '.grok'));
      writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({ 'https://auth.x.ai::client': { key: 'old-access', expires_at: new Date(Date.now() - 60_000).toISOString(), refresh_token: 'r' } }));
      expect(() => hostGrokCredentials({ home, env: {}, ghToken: () => 'gh', refresh: () => {} })).toThrow('남은 시간 만료됨');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('POD4: a token with hours to spare is not refreshed', () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-grok-fresh-'));
    try {
      mkdirSync(join(home, '.grok'));
      writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({ 'https://auth.x.ai::client': { key: 'fresh', expires_at: new Date(Date.now() + 5 * 3600_000).toISOString() } }));
      let refreshed = 0;
      const out = hostGrokCredentials({ home, env: {}, ghToken: () => 'gh', refresh: () => { refreshed += 1; } });
      expect(refreshed).toBe(0);
      expect(out.grokAuth).toContain('fresh');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('subscription: copies access token and expiry, not refresh; fake kubectl receives no codex credentials', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-grok-'));
    try {
      mkdirSync(join(home, '.grok'));
      const authPath = join(home, '.grok', 'auth.json');
      const original = JSON.stringify({ 'https://auth.x.ai::client': { key: 'access-x', expires_at: '2030-01-01T00:00:00Z', refresh_token: 'refresh-x', user_id: 'u' } });
      writeFileSync(authPath, original);
      const { k, calls } = fakeKubectl(['Complete'], '');
      await podSelfImplementSpawn({ provider: 'grok', kubectl: k, sleep: async () => {}, grokCredentials: () => hostGrokCredentials({ home, env: { XAI_API_KEY: 'paid-key' }, ghToken: () => 'gh' }), passEnv: ['XAI_API_KEY'], env: { XAI_API_KEY: 'paid-key' } })({ feature: 'x', spaceId: 'grok-sub' }).done;
      const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
      expect(Object.keys(secret.stringData)).toContain('grok-auth.json');
      expect(Object.keys(secret.stringData)).not.toContain('codex-auth.json');
      expect(Object.keys(secret.stringData)).not.toContain('elanous-auth.json');
      expect(secret.stringData['grok-auth.json']).toContain('access-x');
      expect(secret.stringData['grok-auth.json']).toContain('expires_at');
      expect(secret.stringData['grok-auth.json']).not.toMatch(/refresh/i);
      expect(JSON.stringify(secret)).not.toContain('paid-key');
      expect(secret.stringData['env-XAI_API_KEY']).toBeUndefined();
      expect(readFileSync(authPath, 'utf8')).toBe(original);
      const script: string = job.spec.template.spec.containers[0].args[0];
      expect(script).toContain('install -m 600 /creds/grok-auth.json ~/.grok/auth.json');
      // Pod 안 하니스 «부모»(리뷰·감독)도 grok 으로 — codex 자격이 없으니 이게 없으면 부모가 죽는다.
      expect(script).toContain('export ELANOUS_LLM_PROVIDER=grok');
      expect(script).not.toContain('export XAI_API_KEY');
      expect(script).not.toContain('/creds/codex-auth.json');
      expect(job.spec.template.spec.containers[0].env.map((entry: { name: string }) => entry.name)).not.toContain('XAI_API_KEY');
      expect(script).toContain(`'--child-llm-provider' 'grok' '--child-llm-model' '${defaultGrokModel().id}'`);
      expect(secret.stringData['env-ELANOUS_POD_CREDENTIAL_TOKEN']).toBeUndefined();
      expect(job.spec.template.spec.containers[0].env.map((entry: { name: string }) => entry.name)).not.toContain('ELANOUS_POD_CREDENTIAL_URL');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('POD-GROK-VALIDITY-FIT: without a relay the Job deadline is cut to the shipped token life minus 15 min', async () => {
    const now = Date.parse('2030-01-01T00:00:00Z');
    // a key-less scope with a later expiry must not stretch the deadline past the shipped access
    const grokAuth = JSON.stringify({ 'https://auth.x.ai::client': { key: 'access-fit', expires_at: new Date(now + 2 * 3600_000).toISOString() }, 'https://auth.x.ai::other': { expires_at: new Date(now + 10 * 3600_000).toISOString() } });
    const { k, calls } = fakeKubectl(['Complete'], '');
    await podSelfImplementSpawn({ provider: 'grok', kubectl: k, sleep: async () => {}, now: () => now, grokCredentials: () => ({ grokAuth, ghToken: 'gh' }), env: {} })({ feature: 'x', spaceId: 'grok-fit' }).done;
    const job = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!))[1];
    expect(job.spec.activeDeadlineSeconds).toBe(6300);
  });

  test('POD-GROK-VALIDITY-FIT: a token that fell below the minimum Job by launch time is refused, no Job applied', async () => {
    const now = Date.parse('2030-01-01T00:00:00Z');
    const grokAuth = JSON.stringify({ 'https://auth.x.ai::client': { key: 'access-short', expires_at: new Date(now + 30 * 60_000).toISOString() } });
    const { k, calls } = fakeKubectl(['Complete'], '');
    const out = await podSelfImplementSpawn({ provider: 'grok', kubectl: k, sleep: async () => {}, now: () => now, grokCredentials: () => ({ grokAuth, ghToken: 'gh' }), env: {} })({ feature: 'x', spaceId: 'grok-fit-short' }).done;
    expect(out.error?.message).toContain('grok login');
    expect(calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!)).some((m) => m.kind === 'Job')).toBe(false);
    expect(calls.some((call) => call.args.includes('delete secret'))).toBe(true);
  });

  test('a caller cannot inject a refresh token or an unapproved API key into a Grok Secret', async () => {
    const { k, calls } = fakeKubectl(['Complete'], '');
    const opts = { provider: 'grok' as const, kubectl: k, sleep: async () => {}, env: {} };
    const rejected = await podSelfImplementSpawn({ ...opts, grokCredentials: () => ({ grokAuth: JSON.stringify({ scope: { key: 'access', refresh_token: 'refresh' } }), ghToken: 'gh' }) })({ feature: 'x', spaceId: 'grok-bad-sub' }).done;
    expect(rejected.error?.message).toContain('refresh');
    const paid = await podSelfImplementSpawn({ ...opts, grokCredentials: () => ({ grokApiKey: 'paid-key', ghToken: 'gh' }) })({ feature: 'x', spaceId: 'grok-bad-key' }).done;
    expect(paid.error?.message).toContain('opt-in');
    expect(calls.some((call) => call.args.endsWith('apply -f -'))).toBe(false);
  });

  test('API key alone fails closed, opt-in mounts key only without Codex credentials', async () => {
    expect(() => hostGrokCredentials({ home: '/nonexistent-grok-home', env: { XAI_API_KEY: 'paid-key' }, ghToken: () => 'gh' })).toThrow('opt-in 꺼짐');
    const { k, calls } = fakeKubectl(['Complete'], '');
    await podSelfImplementSpawn({ provider: 'grok', grokApiKeyOptIn: true, kubectl: k, sleep: async () => {}, grokCredentials: () => hostGrokCredentials({ home: '/nonexistent-grok-home', env: { XAI_API_KEY: 'paid-key' }, apiKeyOptIn: true, ghToken: () => 'gh' }), passEnv: ['XAI_API_KEY'], env: { XAI_API_KEY: 'paid-key' } })({ feature: 'x', spaceId: 'grok-api' }).done;
    const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
    expect(secret.stringData['grok-api-key']).toBe('paid-key');
    expect(secret.stringData['codex-auth.json']).toBeUndefined();
    expect(secret.stringData['env-XAI_API_KEY']).toBeUndefined();
    expect(job.spec.template.spec.containers[0].args[0]).toContain('install -m 600 /creds/grok-api-key ~/.grok/api-key');
    expect(job.spec.template.spec.containers[0].args[0]).toContain('export XAI_API_KEY="$(cat ~/.grok/api-key)"');
    expect(job.spec.template.spec.containers[0].args[0]).toContain('export ELANOUS_LLM_PROVIDER=grok');
    expect(secret.stringData['env-ELANOUS_POD_CREDENTIAL_TOKEN']).toBeUndefined();
    expect(job.spec.template.spec.containers[0].env.map((entry: { name: string }) => entry.name)).not.toContain('ELANOUS_POD_CREDENTIAL_URL');
  });
});

describe('pod memory inheritance from parent goal', () => {
  test('document launch selects an actual 2Gi Job request and records the chosen reason with its run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-document-memory-'));
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'pod-document-memory-test', emit: (record) => {
      if (record.category === 'self-implement.pod' && (record.event === 'memory-limit' || record.event === 'memory-request')) {
        events.push({ event: record.event, data: record.data as Record<string, unknown> });
      }
    } });
    try {
      const { k, calls } = fakeKubectl(['Complete'], '');
      const parentRunId = 'run-document-memory-test';
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS,
        env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: parentRunId, ELANOUS_POD_MEMORY_TIER: 'lite',
          ELANOUS_POD_MEMORY_REASON: 'goal-type-default', ELANOUS_POD_GOAL_TYPE: 'document' } })(
        { feature: 'Write the guide', spaceId: 'document-memory' }).done;
      expect(result.exitCode).toBe(0);
      const jobs = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!))
        .filter((item) => item.kind === 'Job');
      expect(jobs).toHaveLength(1);
      const resources = jobs[0]!.spec.template.spec.containers[0].resources;
      expect(resources.requests.memory).toBe('2Gi');
      expect(resources.limits.memory).toBe('2Gi');
      expect(events).toContainEqual({ event: 'memory-limit', data: expect.objectContaining({ tier: 'lite', reason: 'goal-type-default', memoryLimit: '2Gi' }) });
      expect(events).toContainEqual({ event: 'memory-request', data: expect.objectContaining({ tier: 'lite', reason: 'goal-type-default', memoryRequest: '2Gi' }) });
      expect(loadRunLedger(parentRunId, join(root, 'run-ledger'))).toContainEqual(expect.objectContaining({
        event: 'pod-memory-selected', data: expect.objectContaining({ tier: 'lite', reason: 'goal-type-default', limit: '2Gi', request: '2Gi' }),
      }));
    } finally { off(); rmSync(root, { recursive: true, force: true }); }
  });
  test('a pathless PWA shard inherits 32Gi from the goal body, not its execution ledger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-memory-parent-'));
    const previous = process.cwd();
    const goal = 'docs/goals/pwa.md';
    const feature = 'Implement SchemaForm.tsx using flattenSchema and validateSchema';
    const events: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-parent-memory-test', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'memory-limit') events.push(record.data as Record<string, unknown>);
    } });
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      process.chdir(root);
      const spawn = async (spaceId: string, env: NodeJS.ProcessEnv, text = feature) => {
        const { k, calls } = fakeKubectl(['Complete'], '');
        const stamp = { orchestrationId: 'a5096ecf-cb0b-4dd9-84eb-bfdffa07a280', shardId: 'task:abcdef', totalShards: 1, position: 1, summary: text.trim().replace(/\s+/g, ' '), siblings: [] };
        await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env })({ feature: `${text}\n\n## Shard identity\n${JSON.stringify(stamp)}`, spaceId }).done;
        const job = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!)).find((m) => m.kind === 'Job');
        expect(job.spec.template.spec.containers[0].args[0]).toContain('elanous self implement "$(cat /creds/feature)" --json');
        return job.spec.template.spec.containers[0].resources.limits.memory as string;
      };
      const env = { ELANOUS_POD_GOAL_DOC: goal };
      writeFileSync(join(root, goal), '# PWA goal\n대상 경로: apps/pwa/src/components/workflows/SchemaForm.tsx\n\n## 실행 기록\nPod 메모리: standard\n');
      expect(await spawn('parent-pwa', env)).toBe('32Gi');
      expect(events.at(-1)).toMatchObject({ tier: 'high', source: 'parent-pwa-auto', memoryLimit: '32Gi', inheritedFrom: goal });
      writeFileSync(join(root, goal), '# unrelated goal\n대상 경로: packages/ui/SchemaForm.tsx\n\n## 실행 기록\n대상 경로: apps/pwa/old.tsx\n');
      expect(await spawn('parent-other', env)).toBe('16Gi');
      expect(events.at(-1)).toMatchObject({ tier: 'standard', source: 'default', memoryLimit: '16Gi' });
      writeFileSync(join(root, goal), '# goal\nPod 메모리: high\n');
      expect(await spawn('parent-line', env)).toBe('32Gi');
      expect(events.at(-1)).toMatchObject({ tier: 'high', source: 'parent-goal-line', memoryLimit: '32Gi', inheritedFrom: goal });
      writeFileSync(join(root, goal), '# goal\nPod 메모리: standard\n대상 경로: apps/pwa/src/foo.tsx\n');
      expect(await spawn('parent-standard', env)).toBe('16Gi');
      expect(events.at(-1)).toMatchObject({ tier: 'standard', source: 'parent-goal-line', memoryLimit: '16Gi', inheritedFrom: goal });
      expect(await spawn('option-first', { ...env, ELANOUS_POD_MEMORY_TIER: 'standard' })).toBe('16Gi');
      expect(events.at(-1)).toMatchObject({ tier: 'standard', source: 'option', memoryLimit: '16Gi' });
      expect(await spawn('shard-standard', env, `${feature}\nPod 메모리: standard`)).toBe('16Gi');
      expect(events.at(-1)).toMatchObject({ tier: 'standard', source: 'goal-line', memoryLimit: '16Gi' });
      expect(await spawn('shard-high', env, `대상 경로: apps/pwa/SchemaForm.tsx\n${feature}`)).toBe('32Gi');
      expect(events.at(-1)).toMatchObject({ tier: 'high', source: 'pwa-auto', memoryLimit: '32Gi' });
    } finally { off(); process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('unreadable parent is observed without changing the shard memory decision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-memory-unreadable-'));
    const previous = process.cwd();
    const events: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-parent-unreadable-test', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'memory-limit') events.push(record.data as Record<string, unknown>);
    } });
    try {
      execFileSync('git', ['init', '-q', root]);
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: 'missing.md' } })({ feature: 'Implement SchemaForm.tsx using flattenSchema and validateSchema', spaceId: 'missing-parent' }).done;
      expect(events).toEqual([expect.objectContaining({ tier: 'standard', source: 'default', memoryLimit: '16Gi', parentGoal: 'unreadable' })]);
      expect(calls.some((call) => call.args.endsWith('apply -f -'))).toBe(false);
    } finally { off(); process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });
});

test('the host detail switch reaches only matching Pod runs before expiry without changing the Job script or Secret', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-live-detail-'));
  const path = join(root, 'detail.json');
  const parent = 'run-detail-parent';
  const until = Date.now() + 30 * 60_000;
  const launch = async (spaceId: string) => {
    resetLiveDetailCacheForTesting();
    const { k, calls } = fakeKubectl(['Complete'], '');
    const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_RUN_ID: parent, ELANOUS_LIVE_DETAIL_UNTIL: String(until) }, passEnv: ['ELANOUS_LIVE_DETAIL_UNTIL'], armEnv: { ELANOUS_LIVE_DETAIL_UNTIL: String(until) }, liveDetailFile: path })({ feature: 'fix it', spaceId }).done;
    expect(result.exitCode).toBe(0);
    const [secret, job] = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!));
    expect([secret.kind, job.kind]).toEqual(['Secret', 'Job']);
    const child = job.spec.template.spec.containers[0];
    const detailEnv = child.env.filter((entry: { name: string }) => entry.name === 'ELANOUS_LIVE_DETAIL_UNTIL');
    const snapshotHash = job.metadata.annotations?.['elanous.config-snapshot-sha256'];
    expect(snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    const baseline = podJobManifest({ name: job.metadata.name, namespace: 'elanous-test', image: 'elanous-harness:local', workIdentity: { work: 'harness' }, repoUrl: 'https://github.com/ElanvitalAI/elanous', args: ['--open-pr', '--no-supervise'], passEnv: [], deadlineSeconds: POD_JOB_DEADLINE_SECONDS, runId: child.env.find((entry: { name: string }) => entry.name === 'ELANOUS_RUN_ID').value, parentRunId: parent, hostId: child.env.find((entry: { name: string }) => entry.name === 'ELANOUS_HOST_ID')?.value, fallbackChain: { steps: ['codex-rotate', 'grok'], source: 'default' }, configSnapshotHash: snapshotHash });
    expect(job.metadata.labels['elanous.work']).toBe('harness');
    expect(job.spec.template.metadata.labels['elanous.work']).toBe('harness');
    const preserved = structuredClone(job);
    preserved.spec.template.spec.containers[0].env = child.env.filter((entry: { name: string }) => entry.name !== 'ELANOUS_LIVE_DETAIL_UNTIL');
    // POD9 execution identity annotations are launch-specific; the rest must match the baseline manifest.
    expect(preserved.metadata.annotations?.['elanous.dev/attempt']).toBe('1');
    preserved.metadata.annotations = { 'elanous.config-snapshot-sha256': snapshotHash };
    // POD-LAUNCH-PROVENANCE — the launch-specific provenance set is asserted in pod-launch-history.test.ts; the rest matches.
    stripSiTaskProvenance(preserved);
    expect(preserved).toEqual(baseline);
    expect(secret.stringData['env-ELANOUS_LIVE_DETAIL_UNTIL']).toBeUndefined();
    return detailEnv;
  };
  try {
    expect(await launch('detail-off')).toEqual([]);
    writeFileSync(path, '{broken');
    expect(await launch('detail-invalid')).toEqual([]);
    writeFileSync(path, JSON.stringify({ scope: 'all', until: Date.now() - 1, since: 0 }));
    expect(await launch('detail-expired')).toEqual([]);
    writeFileSync(path, JSON.stringify({ scope: 'all', until: Date.now(), since: 0 }));
    expect(await launch('detail-at-boundary')).toEqual([]);
    writeFileSync(path, JSON.stringify({ scope: 'run-unrelated', until, since: 0 }));
    expect(await launch('detail-other-run')).toEqual([]);
    writeFileSync(path, JSON.stringify({ scope: parent, until, since: 0 }));
    expect(await launch('detail-parent')).toEqual([{ name: 'ELANOUS_LIVE_DETAIL_UNTIL', value: String(until) }]);
    writeFileSync(path, JSON.stringify({ scope: 'all', until, since: 0 }));
    expect(await launch('detail-all')).toEqual([{ name: 'ELANOUS_LIVE_DETAIL_UNTIL', value: String(until) }]);
    const { k, calls } = fakeKubectl(['Complete'], '');
    resetLiveDetailCacheForTesting();
    await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {}, liveDetailFile: path })({ feature: 'fix it', spaceId: 'detail-child-run' }).done;
    const job = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!)).find((manifest) => manifest.kind === 'Job');
    const childEnv = job.spec.template.spec.containers[0].env as Array<{ name: string; value?: string }>;
    const childId = childEnv.find((entry) => entry.name === 'ELANOUS_RUN_ID')!.value!;
    writeFileSync(path, JSON.stringify({ scope: childId, until, since: 0 }));
    const another = fakeKubectl(['Complete'], '');
    resetLiveDetailCacheForTesting();
    await podSelfImplementSpawn({ kubectl: another.k, credentials: CREDS, env: {}, liveDetailFile: path })({ feature: 'fix it', spaceId: 'detail-distinct-child' }).done;
    const distinct = another.calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!)).find((manifest) => manifest.kind === 'Job');
    expect(distinct.spec.template.spec.containers[0].env.some((entry: { name: string }) => entry.name === 'ELANOUS_LIVE_DETAIL_UNTIL')).toBe(false);
  } finally { resetLiveDetailCacheForTesting(); rmSync(root, { recursive: true, force: true }); }
});

test('POD-WORKTREE-TIMEOUT-PASS: Pod child Job receives a load-safe worktree timeout while host timeout selection stays unchanged', async () => {
  const previousConfigDir = getElanousConfigDirOverride();
  const restoreConfigDir = () => {
    if (previousConfigDir === undefined) resetElanousConfigDir();
    else setElanousConfigDir(previousConfigDir);
    resetUserConfig();
  };
  const launch = async (configured?: number) => {
    const { k, calls } = fakeKubectl(['Complete'], '{"ok":true,"stage":"complete"}\n');
    const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {},
      fallbackConfig: () => ({ llm: {}, harness: configured === undefined ? {} : { worktreeAddTimeoutSec: configured } }) as UserConfig,
    })({ feature: 'create worktree', spaceId: `pod-timeout-${configured ?? 'default'}` }).done;
    expect(result.exitCode).toBe(0);
    const [secret, job] = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!));
    expect([secret.kind, job.kind]).toEqual(['Secret', 'Job']);
    const script: string = job.spec.template.spec.containers[0].args[0];
    expect(script).toContain('install -m 600 /creds/llm-fallback-config.json "$HOME/.elanous/config.json"');
    const childDir = mkdtempSync(join(tmpdir(), 'pod-child-worktree-timeout-'));
    try {
      const installed = join(childDir, 'config.json');
      writeFileSync(installed, secret.stringData['llm-fallback-config.json']);
      const seconds = buildUserConfig(installed).harness?.worktreeAddTimeoutSec;
      const expectedSeconds = configured === 720 ? 720 : 1200;
      expect(seconds).toBe(expectedSeconds);
      setElanousConfigDir(childDir);
      try {
        resetUserConfig();
        let trackedFileCounts = 0;
        expect(worktreeAddTimeoutForRepo(childDir, () => { trackedFileCounts++; return 1; }))
          .toEqual({ ms: expectedSeconds * 1000, trackedFileCount: null, source: 'config' });
        expect(trackedFileCounts).toBe(0);
      } finally { restoreConfigDir(); }
      return seconds;
    } finally { rmSync(childDir, { recursive: true, force: true }); }
  };
  expect(await launch()).toBe(1200);
  expect(await launch(720)).toBe(720);
  expect(await launch(-1)).toBe(1200);
  const configDir = mkdtempSync(join(tmpdir(), 'pod-host-worktree-timeout-'));
  setElanousConfigDir(configDir);
  try {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ harness: { worktreeAddTimeoutSec: 720 } }));
    resetUserConfig();
    expect(worktreeAddTimeoutForRepo(configDir, () => { throw new Error('configured host must not count files'); }))
      .toEqual({ ms: 720_000, trackedFileCount: null, source: 'config' });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({}));
    resetUserConfig();
    expect(worktreeAddTimeoutForRepo(configDir, () => 1))
      .toEqual({ ms: 300_000, trackedFileCount: 1, source: 'tracked-files' });
  } finally {
    restoreConfigDir();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('host seat reaches the actual Pod Job as a non-secret environment value', async () => {
  const { k, calls } = fakeKubectl(['Complete'], '');
  await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_HARNESS_SEAT: 'UX' } })({ feature: 'fix it', spaceId: 'seat-stamped' }).done;
  const job = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!))
    .find((manifest) => manifest.kind === 'Job');
  expect(job.spec.template.spec.containers[0].env).toContainEqual({ name: 'ELANOUS_HARNESS_SEAT', value: 'UX' });
});

test('a host-recorded dispatch marker reaches the actual Pod Job without altering its launch script', async () => {
  const { k, calls } = fakeKubectl(['Complete'], '');
  await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_DISPATCH_RECORDED: '1' } })({ feature: 'fix it', spaceId: 'dispatch-recorded' }).done;
  const job = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!))
    .find((manifest) => manifest.kind === 'Job');
  expect(job.spec.template.spec.containers[0].env).toContainEqual({ name: 'ELANOUS_DISPATCH_RECORDED', value: '1' });
  const base = { name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: ['--open-pr'], passEnv: [], deadlineSeconds: 60 };
  const plain = podJobManifest(base) as { spec: { template: { spec: { containers: Array<{ args: string[]; env: Array<{ name: string }> }> } } } };
  const marked = podJobManifest({ ...base, armEnv: { ELANOUS_DISPATCH_RECORDED: '1' } }) as typeof plain;
  expect(plain.spec.template.spec.containers[0]!.env.some((item) => item.name === 'ELANOUS_DISPATCH_RECORDED')).toBe(false);
  expect(marked.spec.template.spec.containers[0]!.args).toEqual(plain.spec.template.spec.containers[0]!.args);
  expect(job.spec.template.spec.containers[0].args[0]).toContain('elanous self implement');
});

test('TA card slot reaches the actual Pod Job from the host launch environment', async () => {
  const { k, calls } = fakeKubectl(['Complete'], '');
  await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_SLOT_ID: 'TA-DRAFT-NO-LEFTOVER', ELANOUS_TASK_BOUND_PR: '29365' } })
    ({ feature: 'fix it', spaceId: 'ta-card-slot' }).done;
  const job = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!))
    .find((manifest) => manifest.kind === 'Job');
  expect(job.spec.template.spec.containers[0].env).toContainEqual({ name: 'ELANOUS_POD_SLOT_ID', value: 'TA-DRAFT-NO-LEFTOVER' });
  expect(job.spec.template.spec.containers[0].env).toContainEqual({ name: 'ELANOUS_TASK_BOUND_PR', value: '29365' });
});

test('TA card slot reaches the Pod child as an explicit environment value', () => {
  const manifest = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60,
    workIdentity: { work: 'harness', taskCard: 'ta-20261017-123456', slotId: 'TA-DRAFT-NO-LEFTOVER' } }) as {
    spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } };
  };
  expect(manifest.spec.template.spec.containers[0]!.env).toContainEqual({ name: 'ELANOUS_POD_SLOT_ID', value: 'TA-DRAFT-NO-LEFTOVER' });
});

test('TA warm reuse decision is observed but missing TA evidence keeps the existing fresh Job path', async () => {
  const { k, calls } = fakeKubectl(['Complete'], '');
  const warmEvents: Array<{ event: string; data: unknown }> = [];
  const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
    if (category === 'pod.warm') warmEvents.push({ event, data });
  }) as typeof debug.log);
  try {
    const evidence = {
      'gate-recheck': {
        leaseValid: true, canaryPassed: true, expected: { head: 'h', main: 'm', lock: 'l' },
        worker: { head: 'h', main: 'm', lock: 'l' }, recentMismatchCount: 0, consecutiveMatchSamples: 3,
      },
      land: {
        leaseValid: true, canaryPassed: true, expected: { head: 'h', main: 'm', lock: 'l' },
        worker: { head: 'h', main: 'm', lock: 'l' }, recentMismatchCount: 0, consecutiveMatchSamples: 3,
      },
    } as const;
    const unmeasuredRun = await podSelfImplementSpawn({
      kubectl: k, credentials: CREDS, env: { ELANOUS_TASK_CARD_ID: 'ta-test-card' },
      warmReuseConfig: () => ({ gateRecheck: true, land: true, ta: true }),
      warmReuseEvidence: () => evidence,
    })({ feature: 'fix it', spaceId: 'ta-warm-shadow' }).done;
    expect(unmeasuredRun.exitCode).toBe(0);

    expect(warmEvents).toContainEqual({ event: 'switch-decision', data: expect.objectContaining({ consumer: 'ta', live: false, reason: 'evidence-unmeasured' }) });
    expect(warmEvents).toContainEqual({ event: 'ta-shadow-observation', data: expect.objectContaining({ consumer: 'ta', live: false, execution: 'fresh-job' }) });
    const appliedJobs = calls.filter((call) => call.args.endsWith('apply -f -') && JSON.parse(call.input ?? '{}').kind === 'Job');
    expect(appliedJobs).toHaveLength(1);

    warmEvents.length = 0;
    const fullyMeasured = { ...evidence, ta: evidence.land };
    const livePath = fakeKubectl(['Complete'], '');
    const measuredRun = await podSelfImplementSpawn({
      kubectl: livePath.k, credentials: CREDS, env: { ELANOUS_TASK_CARD_ID: 'ta-test-card' },
      warmReuseConfig: () => ({ gateRecheck: true, land: true, ta: true }),
      warmReuseEvidence: () => fullyMeasured,
    })({ feature: 'fix it', spaceId: 'ta-warm-shadow-live-decision' }).done;
    expect(measuredRun.exitCode).toBe(0);
    // `live: true` means eligible by the shadow switch only; both cases must execute an identical fresh Job spec.
    expect(warmEvents).toContainEqual({ event: 'switch-decision', data: expect.objectContaining({ consumer: 'ta', live: true, reason: 'live' }) });
    expect(warmEvents).toContainEqual({ event: 'ta-shadow-observation', data: expect.objectContaining({ consumer: 'ta', live: true, execution: 'fresh-job' }) });
    const measuredJobs = livePath.calls.filter((call) => call.args.endsWith('apply -f -') && JSON.parse(call.input ?? '{}').kind === 'Job');
    expect(measuredJobs).toHaveLength(1);
    const jobTemplateSpec = (call: typeof appliedJobs[number]) => JSON.parse(call.input ?? '{}').spec.template.spec;
    const comparableJobTemplateSpec = (call: typeof appliedJobs[number]) => {
      const spec = structuredClone(jobTemplateSpec(call));
      for (const container of spec.containers ?? []) {
        const runId = container.env?.find((entry: { name: string }) => entry.name === 'ELANOUS_RUN_ID');
        if (runId) runId.value = '<run-id>';
        // POD-LAUNCH-PROVENANCE — the provenance run id and request time are launch-specific like ELANOUS_RUN_ID.
        for (const entry of container.env ?? []) if (entry.name === 'ELANOUS_POD_RUN' || entry.name === 'ELANOUS_POD_REQUESTED_AT') entry.value = '<launch>';
        if (typeof container.args?.[0] === 'string') container.args[0] = stablePodRunGuard(container.args[0])
          .replace(/ELANOUS_POD_DEADLINE_RESULT [A-Za-z0-9_.:-]+ [A-Za-z0-9_.:-]+ stop-cause=/g,
            'ELANOUS_POD_DEADLINE_RESULT <job> <run> stop-cause=');
      }
      for (const volume of spec.volumes ?? []) {
        if (volume.secret?.secretName) volume.secret.secretName = '<credential-secret>';
      }
      return spec;
    };
    expect(comparableJobTemplateSpec(measuredJobs[0]!)).toEqual(comparableJobTemplateSpec(appliedJobs[0]!));
  } finally {
    logSpy.mockRestore();
  }
});

test('TA warm configuration failure leaves the fresh Job path available', async () => {
  const unavailable: string[] = [];
  const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
    if (category === 'pod.warm' && event === 'ta-shadow-unavailable') unavailable.push(String(data.reason));
  }) as typeof debug.log);
  try {
    for (const failing of ['config', 'evidence'] as const) {
      const { k, calls } = fakeKubectl(['Complete'], '');
      const result = await podSelfImplementSpawn({
        kubectl: k, credentials: CREDS, env: { ELANOUS_TASK_CARD_ID: `ta-warm-${failing}-error` },
        warmReuseConfig: () => {
          if (failing === 'config') throw new Error('config unavailable');
          return { gateRecheck: true, land: true, ta: true };
        },
        warmReuseEvidence: () => { throw new Error('evidence unavailable'); },
      })({ feature: 'fix it', spaceId: `ta-warm-${failing}-error` }).done;
      expect(result.exitCode).toBe(0);
      expect(calls.filter((call) => call.args.endsWith('apply -f -') && JSON.parse(call.input ?? '{}').kind === 'Job')).toHaveLength(1);
    }
    expect(unavailable).toEqual(['injected-config-failed', 'injected-evidence-failed']);
  } finally { logSpy.mockRestore(); }
});

test('an injected warm request hook is called for its command while the feature still runs as a fresh Job', async () => {
  const { k, calls } = fakeKubectl(['Complete'], '');
  const command = {
    protocol: 1 as const, runId: 'warm-run', attemptId: 'warm-attempt', cutSha: 'a'.repeat(40),
    leaseId: 'lease-1', generation: 1, workerId: 'worker-1',
    key: { context: 'ctx', imageDigest: `sha256:${'b'.repeat(64)}`, lockHash: 'c'.repeat(64), architecture: 'amd64' },
    deadlineAt: Date.now() + 60_000, files: ['src/example.test.ts'], envProfile: 'gate-v1',
  };
  const requests: unknown[] = [];
  const result = await podSelfImplementSpawn({
    kubectl: k, credentials: CREDS, env: {}, pollMs: 1,
    warmPodRequest: (request) => {
      expect(calls.some((call) => call.args.endsWith('apply -f -') && JSON.parse(call.input ?? '{}').kind === 'Job')).toBe(true);
      requests.push(request);
      return { status: 'fallback', reason: 'pod-unready', reply: null };
    },
  })({ feature: 'fix it', spaceId: 'warm-request-observation', warmWorkerCommand: command }).done;

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(result.exitCode).toBe(0);
  expect(requests).toEqual([{ command }]);
  const jobs = calls.filter((call) => call.args.endsWith('apply -f -') && JSON.parse(call.input ?? '{}').kind === 'Job');
  expect(jobs).toHaveLength(1);

  const withoutCandidate = fakeKubectl(['Complete'], '');
  const noCandidateRun = await podSelfImplementSpawn({
    kubectl: withoutCandidate.k, credentials: CREDS, env: {}, pollMs: 1,
    warmPodRequest: (request) => { requests.push(request); return { status: 'fallback', reason: 'pod-unready', reply: null }; },
  })({ feature: 'fix it', spaceId: 'warm-request-no-candidate' }).done;
  expect(noCandidateRun.exitCode).toBe(0);
  expect(requests).toHaveLength(1);
  const fallbackJobs = withoutCandidate.calls.filter((call) => call.args.endsWith('apply -f -') && JSON.parse(call.input ?? '{}').kind === 'Job');
  expect(fallbackJobs).toHaveLength(1);
});

test('sync throw, async rejection, and pending warm hooks cannot prevent the fresh feature Job', async () => {
  const command = {
    protocol: 1 as const, runId: 'warm-run', attemptId: 'warm-attempt', cutSha: 'a'.repeat(40),
    leaseId: 'lease-1', generation: 1, workerId: 'worker-1',
    key: { context: 'ctx', imageDigest: `sha256:${'b'.repeat(64)}`, lockHash: 'c'.repeat(64), architecture: 'amd64' },
    deadlineAt: Date.now() + 60_000, files: ['src/example.test.ts'], envProfile: 'gate-v1',
  };
  const behaviors: Array<() => unknown> = [
    () => { throw new Error('sync failure'); },
    () => Promise.reject(new Error('async failure')),
    () => new Promise(() => {}),
  ];
  const unavailableEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
  const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
    if (category === 'pod.warm' && event === 'request-unavailable') unavailableEvents.push({ event, data: data as Record<string, unknown> });
  }) as typeof debug.log);
  try {
    for (const [index, behavior] of behaviors.entries()) {
      const { k, calls } = fakeKubectl(['Complete'], '');
      let invoked = 0;
      const spaceId = `warm-hook-failure-${index}`;
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {}, pollMs: 1,
        warmPodRequest: () => { invoked++; return behavior() as never; },
      })({ feature: 'fix it', spaceId, warmWorkerCommand: command }).done;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(result.exitCode).toBe(0);
      expect(invoked).toBe(1);
      expect(calls.filter((call) => call.args.endsWith('apply -f -') && JSON.parse(call.input ?? '{}').kind === 'Job')).toHaveLength(1);
      expect(unavailableEvents.some((entry) => entry.data.spaceId === spaceId)).toBe(index < 2);
    }
  } finally { logSpy.mockRestore(); }
});

describe('pod memory evidence', () => {
  const lines = [1, 2, 3, 4, 5].map((n) => `ELANOUS_MEM ${1700000000 + n} ${n * 1073741824} ${n * 1048576}:node 512:bun`);

  // Exercise the generated Pod sampler with fixed ps RSS/comm/argv rows, never the host's platform-specific process list.
  function sampleProcessRow(row: string): string {
    const script = (podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } }).spec.template.spec.containers[0]!.args[0]!;
    const sampler = script.split('\n').find((line) => line.startsWith('(while :; do { mem='))!;
    const root = mkdtempSync(join(tmpdir(), 'pod-mem-ps-'));
    try {
      const ps = join(root, 'ps');
      writeFileSync(ps, '#!/bin/sh\nprintf "%s\\n" "$PS_ROW"\n');
      chmodSync(ps, 0o755);
      const run = Bun.spawnSync(['sh', '-c', `${sampler.replace('sleep 15 || break', 'break')}\nwait "$mem_sampler_pid"`], { env: { ...process.env, PATH: `${root}:${process.env.PATH}`, PS_ROW: row } });
      expect(run.exitCode).toBe(0);
      return run.stdout.toString();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  test('authorOnPod never passes --author-grade to the Pod elanous (it may not know the flag — 10-06 «unknown option»)', () => {
    const job = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60, authorSentence: true, authorGrade: 'lite' }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
    const script = job.spec.template.spec.containers[0]!.args[0]!;
    expect(script).toContain('elanous harness say --substrate local --json');
    expect(script).not.toContain('--author-grade');
  });

  test('AUTHOR-LITE2-POD: authorOnPod carries the grade as ELANOUS_AUTHOR_GRADE, never as a flag; absent grade emits no env', () => {
    const base = { name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60, authorSentence: true } as const;
    type Manifest = { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
    const withGrade = (podJobManifest({ ...base, authorGrade: 'lite' }) as Manifest).spec.template.spec.containers[0]!.args[0]!;
    expect(withGrade).toContain('ELANOUS_AUTHOR_GRADE=lite');
    expect(withGrade).toContain('ELANOUS_AUTHOR_GRADE=lite elanous harness say --substrate local --json');
    expect(withGrade).not.toContain('--author-grade');
    const withoutGrade = (podJobManifest(base) as Manifest).spec.template.spec.containers[0]!.args[0]!;
    expect(withoutGrade.split('ELANOUS_AUTHOR_GRADE').length - 1).toBe(0);
  });

  test('sampler follows setup, precedes both harness routes, redacts argv and leaves exit unchanged', () => {
    for (const goalDoc of [undefined, 'GOAL.md']) {
      const manifest = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60, ...(goalDoc ? { goalDoc } : {}) }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
      const script = manifest.spec.template.spec.containers[0]!.args[0]!;
      const start = script.indexOf('(while :; do { mem=');
      expect(start).toBeGreaterThan(script.indexOf('gh auth setup-git'));
      expect(start).toBeGreaterThan(script.indexOf('cp -- /creds/goal-doc'));
      expect(start).toBeLessThan(script.indexOf(goalDoc ? 'elanous harness ask' : 'elanous self implement'));
      expect(script).toContain('/sys/fs/cgroup/memory.current');
      expect(script).toContain('/sys/fs/cgroup/memory/memory.usage_in_bytes');
      expect(script).toContain('ps -eo rss=,comm=,args= --sort=-rss | head -5');
      expect(script).toContain('sleep 15');
      expect(script).toContain('|| true');
      expect(script).not.toContain('ps -eo args');
      expect(script).toContain('kill "$mem_sampler_pid" 2>/dev/null || true');
      expect(script).toContain('wait "$mem_sampler_pid" 2>/dev/null || true');
      expect(script.indexOf('kill "$mem_sampler_pid"')).toBeLessThan(script.indexOf('wait "$mem_sampler_pid"'));
      expect(script.indexOf('wait "$mem_sampler_pid"')).toBeLessThan(script.lastIndexOf('tail -n 1 /tmp/si.out'));
      expect(script.trimEnd()).toEndWith('exit $rc');
      const sampler = script.split('\n').find((line) => line.startsWith('(while :; do { mem='))!;
      const run = Bun.spawnSync(['bash', '-c', `${sampler.replace('sleep 15 || break', 'break')}\nwait "$mem_sampler_pid"\nexit 7`]);
      expect(run.exitCode).toBe(7);
      expect(parseMemSamples(run.stdout.toString())).toHaveLength(1);
    }
  });

  test('generated sampler emits bounded command shapes, not arbitrary argv', () => {
    const script = (podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } }).spec.template.spec.containers[0]!.args[0]!;
    const sampler = script.split('\n').find((line) => line.startsWith('(while :; do { mem='))!;
    const root = mkdtempSync(join(tmpdir(), 'pod-mem-names-'));
    try {
      writeFileSync(join(root, 'ps'), '#!/bin/sh\ncat <<\'EOF\'\n 1048576 worker my worker\n 2097152 worker:shard worker:shard\n 512 percent% percent% name\nEOF\n');
      chmodSync(join(root, 'ps'), 0o755);
      const run = Bun.spawnSync(['bash', '-c', `${sampler.replace('sleep 15 || break', 'break')}\nwait "$mem_sampler_pid"`], { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
      expect(run.exitCode).toBe(0);
      const line = run.stdout.toString().trim();
      expect(parseMemSamples(line)[0]?.top).toEqual([
        { rssKb: 1048576, name: 'other', cmd: '<redacted>' },
        { rssKb: 2097152, name: 'other', cmd: '<redacted>' },
        { rssKb: 512, name: 'other', cmd: '<redacted>' },
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('fixed sleep argv emits only a bounded duration shape and redacts tokens before crossing the Pod boundary', () => {
    // A recognized sleep duration may leave the Pod, but neither flags nor arbitrary secret values may.
    const token = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789';
    const gh = 'ghp_0123456789abcdefghij0123456789abcd';
    const hex = 'a'.repeat(40);
    const raw = sampleProcessRow(` 2048 sleep sleep 30 --api_key short-secret --api-key ${token} GITHUB_TOKEN=${gh} --password pass-short --secret secret-short --token token-short Bearer bearer-short SERVICE_KEY=key-short SERVICE_SECRET=secret-value SERVICE_PASSWORD=password-value ${hex}`);
    const cmd = parseMemSamples(raw)[0]?.top[0]?.cmd;
    expect(cmd).toBe('sleep 30 <redacted>');
    expect(cmd!.length).toBeLessThanOrEqual(120);
    for (const secret of ['short-secret', token, gh, hex, '--api-key', 'GITHUB_TOKEN=', 'sk-live-', 'ghp_']) expect(raw).not.toContain(secret);
    // Changing the injected comm must change the sanitizer's decision, not just its input text.
    expect(parseMemSamples(sampleProcessRow(' 2048 bash bash -c sleep 30 --api_key short-secret'))[0]?.top[0]?.cmd).toBe('<redacted>');
  });

  test('fixed bash argv with whitespace inside a secret is redacted before crossing the Pod boundary', () => {
    // A multiword secret in shell argv must not become a partial command shape.
    const raw = sampleProcessRow(' 1024 bash bash -c sleep 30 --api_key short secret');
    expect(parseMemSamples(raw)[0]?.top[0]).toMatchObject({ rssKb: 1024, name: 'bash', cmd: '<redacted>' });
    expect(raw).not.toContain('short secret');
    expect(raw).not.toContain('short');
    expect(raw).not.toContain('secret');
  });

  test('fixed bash -c argv with an unknown secret cannot send its command to the host', () => {
    // Unknown shell payloads must be hidden without relying on known token prefixes.
    const raw = sampleProcessRow(' 4096 bash bash -c while :; do sleep 1; done # short secret');
    expect(parseMemSamples(raw)[0]?.top[0]).toMatchObject({ rssKb: 4096, name: 'bash', cmd: '<redacted>' });
    expect(raw).not.toContain('short secret');
  });

  test('fixed argv0 masquerade cannot turn bash -c secrets into an allowed sleep command', () => {
    // Kernel comm is bash even when argv0 claims sleep; classify by comm, not argv0.
    const raw = sampleProcessRow(' 8192 bash sleep -c while :; do sleep 1; done # short secret');
    expect(parseMemSamples(raw)[0]?.top[0]).toMatchObject({ rssKb: 8192, name: 'bash', cmd: '<redacted>' });
    expect(raw).not.toContain('short secret');
  });

  test('Pod sampler never emits arbitrary command text, including shell -c secrets', () => {
    const script = (podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } }).spec.template.spec.containers[0]!.args[0]!;
    const sampler = script.split('\n').find((line) => line.startsWith('(while :; do { mem='))!;
    const root = mkdtempSync(join(tmpdir(), 'pod-mem-redact-'));
    try {
      const ps = join(root, 'ps');
      writeFileSync(ps, '#!/bin/sh\nprintf " 512 %s %s\\n" "${PS_ROW%% *}" "$PS_ROW"\n');
      chmodSync(ps, 0o755);
      for (const [argv, name, visible] of [
        ['bash -c echo "short secret"; sleep 30', 'bash', '<redacted>'],
        ['bun --token short-value', 'bun', 'bun <redacted>'],
        ['bun run src/app.ts --api-key sk-live-abc', 'bun', 'bun run <redacted>'],
        ['bun test src/app.test.ts GITHUB_TOKEN=ghp_short', 'bun', 'bun test <redacted>'],
        ['elanous self implement private-goal', 'elanous', 'elanous self <redacted>'],
        ['tsc --project secret-name', 'tsc', 'tsc <redacted>'],
        ['sleep 30 --api-key sk-live-abc', 'sleep', 'sleep 30 <redacted>'],
        ['sleep 31 --api-key short-secret', 'sleep', 'sleep <redacted>'],
        ['mystery short-secret', 'other', '<redacted>'],
      ] as const) {
        const run = Bun.spawnSync(['sh', '-c', `${sampler.replace('sleep 15 || break', 'break')}\nwait "$mem_sampler_pid"`], { env: { ...process.env, PATH: `${root}:${process.env.PATH}`, PS_ROW: argv } });
        expect(run.exitCode).toBe(0);
        const raw = run.stdout.toString();
        expect(parseMemSamples(raw)[0]?.top[0]).toEqual({ rssKb: 512, name, cmd: visible });
        expect(raw).not.toContain('short secret');
        expect(raw).not.toContain('short-value');
        expect(raw).not.toContain('short-secret');
        expect(raw).not.toContain('sk-live-');
        expect(raw).not.toContain('ghp_short');
        expect(raw).not.toContain('private-goal');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('sampler TERM output finishes before terminal JSON, including on a failed child', () => {
    const script = (podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } }).spec.template.spec.containers[0]!.args[0]!;
    const shutdownStart = script.lastIndexOf('kill "$mem_sampler_pid"');
    const shutdown = script.slice(shutdownStart, script.indexOf('\nexit $rc', shutdownStart));
    expect(shutdown).toContain('wait "$mem_sampler_pid"');
    const dir = mkdtempSync(join(tmpdir(), 'pod-sampler-shutdown-'));
    try {
      const output = join(dir, 'si.out');
      const ready = join(dir, 'ready');
      const json = '{"stage":"abandoned","ok":false}';
      writeFileSync(output, `${json}\n`);
      const run = Bun.spawnSync(['bash', '-c', `set -u\nrc=7\nsi_deadline_watch_pid=999999\n(trap 'printf "ELANOUS_MEM 42 1024 512:bun\\n"; exit 0' TERM; touch ${JSON.stringify(ready)}; while :; do sleep 0.01; done) & mem_sampler_pid=$!\nwhile [ ! -f ${JSON.stringify(ready)} ]; do sleep 0.01; done\n${shutdown.replaceAll('/tmp/si.out', output).replaceAll('/tmp/si.finished', join(dir, 'si.finished')).replaceAll('/tmp/si.deadline-result', join(dir, 'si.deadline-result')).replaceAll('/tmp/si.deadline-marker', join(dir, 'si.deadline-marker'))}\nexit $rc`]);
      expect(run.exitCode).toBe(7);
      expect(run.stdout.toString().trimEnd().split('\n')).toEqual(['ELANOUS_MEM 42 1024 512:bun', json]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('five interleaved samples parse in order and do not change the run result line', () => {
    const logs = `normal\n${lines.join('\nordinary\n')}\n{"stage":"merged","ok":true}\n`;
    expect(parseMemSamples(logs)).toEqual(lines.map((_, i) => ({ at: 1700000001 + i, cgroupBytes: (i + 1) * 1073741824, top: [{ rssKb: (i + 1) * 1048576, name: 'node' }, { rssKb: 512, name: 'bun' }] })));
    expect(parseMemSamples('ELANOUS_MEM 42 - 2048:node\nELANOUS_MEM bad 9 1:node\nELANOUS_MEM 43 9 1:node --token')).toEqual([{ at: 42, cgroupBytes: null, top: [{ rssKb: 2048, name: 'node' }] }]);
    expect(parseMemSamples('ELANOUS_MEM 44 9 123:bun:bun%20run%20src%2Fapp.ts')).toEqual([{ at: 44, cgroupBytes: 9, top: [{ rssKb: 123, name: 'bun', cmd: 'bun run src/app.ts' }] }]);
    const withoutSamples = 'normal\n{"stage":"merged","ok":true}\n';
    const withSamples = `normal\n${lines.join('\n')}\n{"stage":"merged","ok":true}\n`;
    expect(podRunResultLine(withSamples, [])).toBe(withoutSamples);
    expect(podRunResultLine(withoutSamples, [])).toBe(withoutSamples);
    expect(podRunResultLine(withSamples, ['salvage/j/w'])).toBe(`${withoutSamples}\n수확할 브랜치: salvage/j/w`);
  });

  test('a 4000-character result tail cut inside a sample never leaks its fragment', async () => {
    const sample = 'ELANOUS_MEM 1700000001 1073741824 1048576:sample-fragment-name';
    const logs = `prefix\n${sample}\n${'x'.repeat(3970)}\nnormal\n`;
    const cut = logs.length - 4000;
    expect(logs.length).toBeGreaterThan(4000);
    expect(cut).toBeGreaterThan(logs.indexOf(sample));
    expect(cut).toBeLessThan(logs.indexOf(sample) + sample.length);
    expect(logs.slice(-4000)).toContain('sample-fragment-name');
    const expected = `prefix\n${'x'.repeat(3970)}\nnormal\n`;
    expect(podRunResultLine(logs, [])).toBe(expected.slice(-4000));
    const { k } = fakeKubectl(['Complete'], logs);
    const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'mem-tail-cut' }).done;
    expect(result.output).toBe(expected.slice(-4000));
    expect(result.output).not.toContain('sample-fragment-name');
  });

  test('OOM uses the last three full-log samples; missing samples are explicit; success records the last one', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'pod-memory-evidence-test', emit: (record) => {
      if (record.category === 'self-implement.pod' && ['oom-evidence', 'memory-last'].includes(record.event)) events.push({ event: record.event, data: record.data as Record<string, unknown> });
    } });
    const jobLogs = `normal\n${lines.join('\nnormal\n')}\n`;
    const k = (state: 'Failed' | 'Complete', full: string): Kubectl => (args) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.includes('get') && args.includes('pods')) return { status: 0, stdout: '2026-09-28T10:49:00Z\tOOMKilled\t137\n', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: state, stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: args.includes('--tail=400') ? full.split('\n').slice(-3).join('\n') : full, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const oom = await podSelfImplementSpawn({ kubectl: k('Failed', jobLogs), credentials: CREDS, env: { ELANOUS_POD_MEMORY: '32Gi' } })({ feature: 'x', spaceId: 'mem-oom' }).done;
      expect(oom.error?.code).toBe('pod-oom-killed');
      expect(oom.error?.message).toContain('마지막 샘플: cgroup 5.00GiB · 상위 node 5.00GiB');
      expect(events[0]).toMatchObject({ event: 'oom-evidence', data: { job: podJobName('mem-oom'), memoryLimit: '32Gi', samples: parseMemSamples(jobLogs).slice(-3), logShape: { lines: 1, bytes: 6 } } });
      expect(events[0]!.data).not.toHaveProperty('logTail');
      expect((events[0]!.data.samples as unknown[])).toHaveLength(3);
      const missing = await podSelfImplementSpawn({ kubectl: k('Failed', 'normal'), credentials: CREDS, env: { ELANOUS_POD_MEMORY_TIER: 'high', ELANOUS_POD_MEMORY_HIGH: '16Gi' } })({ feature: 'x', spaceId: 'mem-missing' }).done;
      expect(missing.error?.message).toContain('마지막 샘플: 샘플 없음');
      expect(events[1]).toMatchObject({ event: 'oom-evidence', data: { job: podJobName('mem-missing'), memoryLimit: '16Gi', samples: [], logShape: { lines: 1, bytes: 6 } } });
      const success = await podSelfImplementSpawn({ kubectl: k('Complete', `${jobLogs}{"stage":"merged","ok":true}\n`), credentials: CREDS })({ feature: 'x', spaceId: 'mem-success' }).done;
      expect(success.exitCode).toBe(0);
      expect(events[2]).toMatchObject({ event: 'memory-last', data: { job: podJobName('mem-success'), sample: parseMemSamples(jobLogs).at(-1) } });
      const unavailable: Kubectl = (args) => {
        const response = k('Failed', jobLogs)(args);
        return args.includes('logs') && args.includes('--tail=400') ? { status: 1, stdout: '', stderr: 'pod-logs-missing' } : response;
      };
      await podSelfImplementSpawn({ kubectl: unavailable, credentials: CREDS, env: { ELANOUS_POD_MEMORY_TIER: 'high' } })({ feature: 'x', spaceId: 'mem-unavailable' }).done;
      expect(events[3]).toMatchObject({ event: 'oom-evidence', data: { logShape: null, logTailReason: 'pod-logs-missing' } });
      // 자식이 일반 출력에 비밀을 찍어도 oom-evidence 에는 그 문자열이 «어디에도» 없다.
      const secretLogs = `starting\nexport TOKEN="short secret"\nELANOUS_MEM 42 9 1:node\nlast line`;
      await podSelfImplementSpawn({ kubectl: k('Failed', secretLogs), credentials: CREDS, env: { ELANOUS_POD_MEMORY_TIER: 'high' } })({ feature: 'x', spaceId: 'mem-secret-log' }).done;
      expect(events[4]).toMatchObject({ event: 'oom-evidence', data: { logShape: { lines: 2 } } });
      expect(JSON.stringify(events[4]!.data)).not.toContain('short secret');
      expect(JSON.stringify(events[4]!.data)).not.toContain('last line');
    } finally { off(); }
  });
});

describe('podSelfImplementSpawn', () => {
  const suiteCwd = process.cwd();
  afterEach(() => process.chdir(suiteCwd));
  test('self orchestrate CLI passes its actual supervise option into the Pod launch', () => {
    const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    const action = source.slice(source.indexOf(".command('orchestrate [goals...]')"), source.indexOf("selfOrchestrateCmd.on('option:help-all'"));
    expect(action).toContain('const podBase = { hostSupervised: opts.supervise === true,');
    expect(action).toContain('rotationAccounts = plan.accounts');
    expect(action).toContain('{ accountBroker, rotationAccounts }');
    expect(action).toContain("podSpawn = await (await import('./task-orchestrator/surfaces/pod-si-warm-entry.js'))");
    expect(action).toContain('.podSpawnWithSiWarm(podBase)');
    expect(action).toContain('podSpawn = benchPodSpawn(benchArms, podBase)');
    expect(action).toContain('...(opts.supervise\n          ? {');
  });

  test('host supervision default and explicit values control self implement child flag and debug log', async () => {
    for (const hostSupervised of [undefined, true, false]) {
      const { k, calls } = fakeKubectl(['Complete'], '');
      const events: Array<Record<string, unknown>> = [];
      const off = debug.registerSink({ name: `child-supervise-${hostSupervised}`, emit: (record) => {
        if (record.category === 'pod.self-implement' && record.event === 'child-supervise') events.push(record.data as Record<string, unknown>);
      } });
      try {
        await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {}, ...(hostSupervised === undefined ? {} : { hostSupervised }) })({ feature: 'x', spaceId: `supervise-${hostSupervised}` }).done;
        const job = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!)).find((m) => m.kind === 'Job');
        const script: string = job.spec.template.spec.containers[0].args[0];
        expect(script.split('\n').find((line) => line.includes('elanous self implement'))!.includes("'--no-supervise'")).toBe(hostSupervised !== false);
        expect(events).toEqual([expect.objectContaining({ hostSupervised: hostSupervised !== false, childSupervise: hostSupervised === false })]);
      } finally { off(); }
    }
  });

  test('job names are per-run (parallel-safe) and k8s-valid', () => {
    const a = podJobName('orch-1234/goal A');
    const b = podJobName('orch-1234/goal B');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z0-9-]{1,58}$/);
  });

  test('applies secret then job, polls to Complete, parses the last JSON line, deletes the secret, drops the pod-internal worktreePath', async () => {
    const json = JSON.stringify({ stage: 'pr-opened', ok: true, worktreePath: '/home/ubuntu/x', prUrl: 'https://github.com/o/r/pull/9', prNumber: 9 });
    const { k, calls } = fakeKubectl(['', '', 'Complete'], `noise\n${json}\n`);
    const spawn = podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS, env: { ELANOUS_RUN_ID: 'run-7' } });
    const { address, done } = spawn({ feature: 'do x', spaceId: 'orch-1', openPr: true });
    expect(address).toBe('self-impl:orch-1');
    const r = await done;
    expect(r.exitCode).toBe(0);
    expect(r.disposition?.prUrl).toBe('https://github.com/o/r/pull/9');
    expect(r.disposition?.worktreePath).toBeUndefined();
    const applied = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
    expect(applied.map((m) => m.kind)).toEqual(['Secret', 'Job']);
    expect(applied[0].stringData.feature).toBe('do x');
    const env = applied[1].spec.template.spec.containers[0].env;
    expect(env).toContainEqual({ name: 'ELANOUS_RUN_ID', value: expect.stringMatching(/^run-[0-9a-f-]+$/) });
    expect(env).toContainEqual({ name: 'ELANOUS_PARENT_RUN_ID', value: 'run-7' });
    expect(env).toContainEqual({ name: 'ELANOUS_SUBSTRATE', value: 'pod' });
    expect(applied[1].spec.template.spec.containers[0].args[0]).toContain("'--open-pr'");
    expect(calls.some((c) => c.args.includes('delete secret'))).toBe(true);
  });

  test('a measured introduced gate failure crosses the child JSON parser and emits a repair receipt', async () => {
    const gate = { passed: false, testStepExecuted: true,
      baselineFailures: [{ file: 'src/example.test.ts', name: 'example > fails', attribution: 'introduced' as const,
        baselinePresence: 'present' as const,
        diagnostic: 'error: expect(received).toBe(expected)' }],
      reflectGateFacts: { introduced: 1, preexisting: 0, unknown: 0 } };
    const { k } = fakeKubectl(['Failed'], `${JSON.stringify({ stage: 'gate-failed', ok: false, gate })}\n`);
    const lines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    try {
      const result = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS })
        ({ feature: 'gate receipt', spaceId: 'pod-gate-receipt' }).done;
      expect(result.disposition?.gate).toEqual(gate);
      expect(lines).toContainEqual(expect.stringMatching(/^GATE_FAILURE_SIGNATURE=sha256:[a-f0-9]{64}$/));
      expect(lines).toContain(`GATE_FAILURE_TESTS=["src/example.test.ts > example > fails (assertion)"]`);
    } finally { logSpy.mockRestore(); }
  });

  test('autoMerge Pod child requests merge-by-host, then invokes host regate once for merge-ready', async () => {
    const headCommit = 'a'.repeat(40);
    const json = JSON.stringify({ stage: 'merge-ready', ok: true, prUrl: 'https://github.com/o/r/pull/9', prNumber: 9, checkedHeadCommit: headCommit });
    const { k, calls } = fakeKubectl(['Complete'], `${json}\n`);
    const received: Array<{ prNumber: number; headCommit: string; repoRoot: string }> = [];
    const r = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS, hostRegate: async (request) => {
      received.push(request);
      return { passed: true, failures: [], os: process.platform };
    } })({ feature: 'host regate', spaceId: 'pod-merge-host', autoMerge: true }).done;
    const job = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!))[1];
    const script = job.spec.template.spec.containers[0].args[0] as string;
    expect(script).toContain("'--merge-by-host'");
    expect(script).not.toContain('--auto-merge');
    expect(received).toEqual([{ prNumber: 9, headCommit, repoRoot: expect.any(String) }]);
    expect(r.disposition).toMatchObject({ stage: 'merged', merged: true, hostRegate: { passed: true } });
  });

  test('host regate receives the host goal file so a merged PR can apply the goal «이 칸 완료» declaration (CL-AUTO)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-regate-goal-'));
    const previous = process.cwd();
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      writeFileSync(join(root, 'docs', 'goals', 'cell.md'), '# 골\n칸: X\n이 칸 완료\n');
      process.chdir(root);
      const headCommit = 'b'.repeat(40);
      const json = JSON.stringify({ stage: 'merge-ready', ok: true, prUrl: 'https://github.com/o/r/pull/11', prNumber: 11, checkedHeadCommit: headCommit });
      const { k } = fakeKubectl(['Complete'], `${json}\n`);
      const received: Array<{ goalFile?: string }> = [];
      await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: 'docs/goals/cell.md' }, hostRegate: async (request) => {
        received.push(request);
        return { passed: true, failures: [], os: process.platform };
      } })({ feature: 'host regate goal', spaceId: 'pod-merge-host-goal', autoMerge: true }).done;
      expect(received).toHaveLength(1);
      expect(received[0]!.goalFile).toBe(realpathSync(join(root, 'docs', 'goals', 'cell.md')));
    } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('real runHostRegate path: Pod merge-ready becomes merged only through the host gh merge and MERGED confirmation', async () => {
    const { runHostRegate } = await import('../../self-implement/host-regate.js');
    const head = 'a'.repeat(40); const base = 'c'.repeat(40); const squash = 'd'.repeat(40);
    const json = JSON.stringify({ stage: 'merge-ready', ok: true, prNumber: 9, checkedHeadCommit: head });
    const ghCalls: string[] = [];
    const deps = {
      command: (bin: string, args: readonly string[]) => {
        const call = `${bin} ${args.join(' ')}`; ghCalls.push(call);
        if (call === 'gh pr view 9 --json headRefOid,baseRefName,baseRefOid,state,isDraft') return { status: 0, stdout: JSON.stringify({ headRefOid: head, baseRefName: 'main', baseRefOid: base, state: 'OPEN', isDraft: false }), stderr: '' };
        if (/^git rev-parse refs\/elanous\/regate\/[^ ]+\/(base|head)$/.test(call)) return { status: 0, stdout: call.endsWith('/base') ? base : head, stderr: '' };
        if (call === 'git rev-parse HEAD' || call === 'git rev-parse HEAD^1') return { status: 0, stdout: base, stderr: '' };
        if (call === 'git rev-parse HEAD^2') return { status: 0, stdout: head, stderr: '' };
        if (call.startsWith('git merge-base')) return { status: 0, stdout: 'b'.repeat(40), stderr: '' };
        if (call.startsWith('git diff --name-only')) return { status: 0, stdout: 'src/x.ts\n', stderr: '' };
        if (call === 'gh pr view 9 --json state,mergeCommit') return { status: 0, stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: squash } }), stderr: '' };
        if (call === `git rev-parse ${squash}^1`) return { status: 0, stdout: base, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
      makeTemp: () => {
        const path = mkdtempSync(join(tmpdir(), 'pod-real-regate-'));
        mkdirSync(join(path, 'apps/pwa/node_modules'), { recursive: true });
        return path;
      }, removeTemp: (path: string) => rmSync(path, { recursive: true, force: true }), acquire: async () => () => {}, interference: async () => ({ passed: true }), log: () => {},
    };
    const { k } = fakeKubectl(['Complete'], `${json}\n`);
    const r = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS, hostRegate: (request) => runHostRegate(request, deps) })({ feature: 'real regate', spaceId: 'pod-real-regate', autoMerge: true }).done;
    expect(ghCalls).toContain(`gh pr merge 9 --squash --match-head-commit ${head}`);
    expect(ghCalls.some((call) => /^git fetch --no-write-fetch-head origin \+refs\/heads\/main:refs\/elanous\/regate\/[^ ]+\/base$/.test(call))).toBe(true);
    expect(ghCalls.some((call) => /^git fetch --no-write-fetch-head origin \+refs\/pull\/9\/head:refs\/elanous\/regate\/[^ ]+\/head$/.test(call))).toBe(true);
    expect(r.disposition).toMatchObject({ stage: 'merged', merged: true, hostRegate: { passed: true } });
  });

  describe('FREEZE-POD: the host is the only merger of a Pod run, so its landing freeze holds Pod runs', () => {
    const head = 'a'.repeat(40); const base = 'c'.repeat(40);
    const regateDeps = (ghCalls: string[]) => ({
      command: (bin: string, args: readonly string[]) => {
        const call = `${bin} ${args.join(' ')}`; ghCalls.push(call);
        if (call === 'gh pr view 9 --json headRefOid,baseRefName,baseRefOid,state,isDraft') return { status: 0, stdout: JSON.stringify({ headRefOid: head, baseRefName: 'main', baseRefOid: base, state: 'OPEN', isDraft: false }), stderr: '' };
        if (/^git rev-parse refs\/elanous\/regate\/[^ ]+\/(base|head)$/.test(call)) return { status: 0, stdout: call.endsWith('/base') ? base : head, stderr: '' };
        if (call === 'git rev-parse HEAD' || call === 'git rev-parse HEAD^1') return { status: 0, stdout: base, stderr: '' };
        if (call === 'git rev-parse HEAD^2') return { status: 0, stdout: head, stderr: '' };
        if (call.startsWith('git merge-base')) return { status: 0, stdout: 'b'.repeat(40), stderr: '' };
        if (call.startsWith('git diff --name-only')) return { status: 0, stdout: 'src/x.ts\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
      makeTemp: () => {
        const path = mkdtempSync(join(tmpdir(), 'pod-freeze-regate-'));
        mkdirSync(join(path, 'apps/pwa/node_modules'), { recursive: true });
        return path;
      }, removeTemp: (path: string) => rmSync(path, { recursive: true, force: true }), acquire: async () => () => {}, interference: async () => ({ passed: true }), log: () => {},
    });
    const runFrozen = async (when: 'at-spawn' | 'mid-run') => {
      const { runHostRegate } = await import('../../self-implement/host-regate.js');
      const freezeRoot = mkdtempSync(join(tmpdir(), 'pod-freeze-root-'));
      const prodFreezeRoot = mkdtempSync(join(tmpdir(), 'pod-freeze-prod-'));
      if (when === 'at-spawn') enableLandingFreeze({ reason: 'drill', by: 'OP' }, freezeRoot);
      const ghCalls: string[] = [];
      const events: Array<{ event: string; data: unknown }> = [];
      const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => { if (category === 'self-implement.pod') events.push({ event, data }); }) as typeof debug.log);
      try {
        const json = JSON.stringify({ stage: 'merge-ready', ok: true, prNumber: 9, checkedHeadCommit: head });
        const { k, calls } = fakeKubectl(['Complete'], `${json}\n`);
        const r = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS, hostRegate: (request) => {
          if (when === 'mid-run') enableLandingFreeze({ reason: 'drill', by: 'OP' }, freezeRoot);
          return runHostRegate(request, { ...regateDeps(ghCalls), freezeRoot, prodFreezeRoot });
        } })({ feature: `freeze ${when}`, spaceId: `pod-freeze-${when}`, autoMerge: true }).done;
        const job = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!))[1];
        return { r, ghCalls, events, script: job.spec.template.spec.containers[0].args[0] as string };
      } finally {
        spy.mockRestore();
        rmSync(freezeRoot, { recursive: true, force: true }); rmSync(prodFreezeRoot, { recursive: true, force: true });
      }
    };

    for (const when of ['at-spawn', 'mid-run'] as const) {
      test(`freeze ${when}: the Pod child is routed to host merge and the host keeps the PR open (no gh merge)`, async () => {
        const { r, ghCalls, events, script } = await runFrozen(when);
        expect(script).toContain("'--merge-by-host'");
        expect(ghCalls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
        expect(ghCalls.some((call) => /^git fetch --no-write-fetch-head origin \+refs\/heads\/main:refs\/elanous\/regate\/[^ ]+\/base$/.test(call))).toBe(true);
        expect(ghCalls.some((call) => /^git fetch --no-write-fetch-head origin \+refs\/pull\/9\/head:refs\/elanous\/regate\/[^ ]+\/head$/.test(call))).toBe(true);
        expect(r.disposition).toMatchObject({ stage: 'pr-opened', merged: false, hostRegate: { status: 'frozen' } });
        expect(events.filter((e) => e.event === 'merge-blocked-by-freeze')).toEqual([{ event: 'merge-blocked-by-freeze', data: expect.objectContaining({ pr: 9, reason: 'landing-freeze' }) }]);
      });
    }
  });

  test('frozen host regate keeps ready PR open without treating it as merged or failed', async () => {
    const headCommit = 'b'.repeat(40);
    const { k } = fakeKubectl(['Complete'], JSON.stringify({ stage: 'merge-ready', ok: true, prNumber: 8, checkedHeadCommit: headCommit }));
    const r = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, hostRegate: async () => ({ passed: true, status: 'frozen', failures: [], os: process.platform }) })({ feature: 'frozen', spaceId: 'pod-regate-frozen', autoMerge: true }).done;
    expect(r.disposition).toMatchObject({ stage: 'pr-opened', merged: false, ok: true, hostRegate: { status: 'frozen' } });
    expect(r.exitCode).toBe(0);
  });

  test('host regate failure stays unmerged in disposition', async () => {
    const headCommit = 'b'.repeat(40);
    const { k } = fakeKubectl(['Complete'], JSON.stringify({ stage: 'merge-ready', ok: true, prNumber: 8, checkedHeadCommit: headCommit }));
    const r = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, hostRegate: async () => ({ passed: false, failures: [{ step: 'test-interference', detail: 'combined fail' }], os: process.platform }) })({ feature: 'fail', spaceId: 'pod-regate-fail', autoMerge: true }).done;
    expect(r.disposition).toMatchObject({ stage: 'host-regate-failed', merged: false, ok: false });
    expect(r.exitCode).toBe(1);
  });

  test('release-path host hold leaves the PR open for OP rather than reporting a regate failure', async () => {
    const headCommit = 'b'.repeat(40);
    const { k } = fakeKubectl(['Complete'], JSON.stringify({ stage: 'merge-ready', ok: true, prNumber: 8, checkedHeadCommit: headCommit }));
    const r = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, hostRegate: async () => ({
      passed: false, failures: [{ step: 'release-path-hold', detail: 'OP approval required: src/release/publish.ts' }], os: process.platform,
    }) })({ feature: 'release hold', spaceId: 'pod-release-hold', autoMerge: true }).done;
    expect(r.disposition).toMatchObject({ stage: 'pr-opened', merged: false, ok: true });
    expect(r.exitCode).toBe(0);
  });

  test('merge-ready without a checked head: no regate, no merge, one failure comment on the PR', async () => {
    const { k } = fakeKubectl(['Complete'], JSON.stringify({ stage: 'merge-ready', ok: true, prNumber: 7 }));
    const comments: Array<[number, string]> = [];
    let regated = 0;
    const r = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, ghComment: (n, body) => comments.push([n, body]), hostRegate: async () => { regated++; return { passed: true, failures: [], os: process.platform }; } })({ feature: 'no head', spaceId: 'pod-regate-nohead', autoMerge: true }).done;
    expect(regated).toBe(0);
    expect(r.disposition).toMatchObject({ stage: 'host-regate-failed', merged: false });
    expect(comments).toHaveLength(1);
    expect(comments[0]![0]).toBe(7);
    expect(comments[0]![1]).toContain('호스트 재게이트 실패');
  });

  test('hostRegate throws: one failure comment on the PR', async () => {
    const { k } = fakeKubectl(['Complete'], JSON.stringify({ stage: 'merge-ready', ok: true, prNumber: 6, checkedHeadCommit: 'c'.repeat(40) }));
    const comments: Array<[number, string]> = [];
    const r = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, ghComment: (n, body) => comments.push([n, body]), hostRegate: async () => { throw new Error('boom'); } })({ feature: 'throws', spaceId: 'pod-regate-throws', autoMerge: true }).done;
    expect(r.disposition).toMatchObject({ stage: 'host-regate-failed', merged: false });
    expect(comments).toEqual([[6, expect.stringContaining('host-regate — boom')]]);
  });

  test('goal document travels only by Secret and the cloned Job invokes harness ask with supported flags', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-goal-doc-'));
    const previous = process.cwd();
    const goal = 'docs/goals/ASK-a.md';
    const document = goalWithCompletionBoundary('# private goal text 38fjx');
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      writeFileSync(join(root, goal), document);
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: goal } })({ feature: 'goal', spaceId: 'pod-goal', openPr: true, autoReview: true, draft: false, base: 'main' }).done;
      const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
      const serializedJob = JSON.stringify(job);
      const script = job.spec.template.spec.containers[0].args[0] as string;
      expect(secret.stringData['goal-doc']).toBe(document);
      expect(serializedJob).not.toContain(document);
      expect(job.spec.template.spec.containers[0].env).not.toContainEqual(expect.objectContaining({ name: 'ELANOUS_POD_GOAL_DOC' }));
      expect(script).toContain(`cp -- /creds/goal-doc '${goal}'`);
      const clone = mkdtempSync(join(tmpdir(), 'pod-clone-'));
      try {
        const copy = script.split('\n').find((line) => line.startsWith('mkdir -p -- "$(dirname'))!;
        const source = join(root, 'secret-payload');
        writeFileSync(source, secret.stringData['goal-doc']);
        const restored = Bun.spawnSync(['bash', '-c', copy.replace('/creds/goal-doc', source)], { cwd: clone });
        expect(restored.exitCode).toBe(0);
        expect(readFileSync(join(clone, goal), 'utf8')).toBe(document);
      } finally { rmSync(clone, { recursive: true, force: true }); }
      expect(script).toContain(`elanous harness ask '${goal}' --json '--base' 'main' --no-auto-merge --no-supervise`);
      expect(script).not.toContain('--open-pr');
      expect(script).not.toContain('--auto-review');
      expect(script).not.toContain('--no-draft');
      expect(result.exitCode).toBe(0);
      const stamped = `${document}\n\n## Shard identity\n${JSON.stringify({ orchestrationId: 'a5096ecf-cb0b-4dd9-84eb-bfdffa07a280', shardId: 'task:abcdef', totalShards: 1, position: 1, summary: document.replace(/\s+/g, ' '), siblings: [] })}`;
      const { k: stampedKubectl, calls: stampedCalls } = fakeKubectl(['Complete'], '');
      await podSelfImplementSpawn({ kubectl: stampedKubectl, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: goal } })({ feature: stamped, spaceId: 'pod-stamped-top' }).done;
      const stampedJob = stampedCalls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!)).find((m) => m.kind === 'Job');
      expect(stampedJob.spec.template.spec.containers[0].args[0]).not.toContain('harness ask');
      expect(stampedJob.spec.template.spec.containers[0].args[0]).toContain('elanous self implement "$(cat /creds/feature)" --json');
      const withHandoff = `${stamped}\n\n## Working-memory handoff\nPass along findings`;
      const { k: handoffKubectl, calls: handoffCalls } = fakeKubectl(['Complete'], '');
      await podSelfImplementSpawn({ kubectl: handoffKubectl, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: goal } })({ feature: withHandoff, spaceId: 'pod-stamped-top-handoff' }).done;
      const handoffJob = handoffCalls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!)).find((m) => m.kind === 'Job');
      expect(handoffJob.spec.template.spec.containers[0].args[0]).not.toContain('harness ask');
      expect(handoffJob.spec.template.spec.containers[0].args[0]).toContain('elanous self implement "$(cat /creds/feature)" --json');
      const command = script.split('\n').find((line) => line.startsWith('elanous harness ask '))!;
      const out = mkdtempSync(join(tmpdir(), 'pod-ask-output-'));
      const outputFile = join(out, 'si.out');
      const bin = join(out, 'bin');
      mkdirSync(bin);
      const entry = join(out, 'run-ask.ts');
      writeFileSync(entry, `import { program, setRunDevAskFromGoalFileDepsForTesting } from ${JSON.stringify(import.meta.dir + '/../../index.ts')};\n`
        + `setRunDevAskFromGoalFileDepsForTesting({\n`
        + `  loadDevCli: async () => ({ assertDevCliPathOptions: () => {}, selectDevAuthorInput: (_args: unknown, opts: { ask: string }) => ({ kind: 'ask', value: opts.ask }), buildDevCliSpec: (input: unknown) => ({ input }), startDraftTriage: () => {} }),\n`
        + `  runAskFileLaunchFlow: async () => ({ kind: 'launch', goalFile: ${JSON.stringify(goal)} }),\n`
        + `  loadDevPipeline: async () => ({ runDevPipeline: async () => ({ kind: 'self', result: { stage: 'pr-opened', ok: true, prUrl: 'https://github.com/o/r/pull/9', prNumber: 9 }, plan: {} }), devResultOk: () => true }),\n`
        + `  setExitCode: () => {},\n`
        + `});\nawait program.parseAsync(['node', 'elanous', ...process.argv.slice(2)]);\n`);
      writeFileSync(join(bin, 'elanous'), `#!/bin/sh\nexec bun ${JSON.stringify(entry)} "$@"\n`);
      chmodSync(join(bin, 'elanous'), 0o755);
      try {
        const runCommand = command.replaceAll('/tmp/si.out', outputFile);
        const launched = Bun.spawnSync(['bash', '-c', runCommand], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELANOUS_STATE_DIR: out, ELANOUS_CONFIG_DIR: out } });
        expect(launched.exitCode).toBe(0);
        const jobLog = readFileSync(outputFile, 'utf8');
        const actualAskLastLine = jobLog.trimEnd().split('\n').at(-1)!;
        expect(JSON.parse(actualAskLastLine)).toMatchObject({ stage: 'pr-opened', ok: true, prUrl: 'https://github.com/o/r/pull/9' });
        const { k: normalizedKubectl } = fakeKubectl(['Complete'], jobLog);
        const parsed = await podSelfImplementSpawn({ kubectl: normalizedKubectl, credentials: CREDS, env: {} })({ feature: 'goal', spaceId: 'pod-ask-result' }).done;
        expect(parsed.exitCode).toBe(0);
        expect(parsed.disposition?.stage).toBe('pr-opened');
        expect(parsed.disposition?.prUrl).toBe('https://github.com/o/r/pull/9');

        // A kind:self JSON line can omit top-level ok while its result still carries the outcome.
        writeFileSync(entry, readFileSync(entry, 'utf8').replace('devResultOk: () => true', 'devResultOk: () => undefined').replace("ok: true, prUrl:", "ok: false, prUrl:"));
        const withoutTopLevelOk = Bun.spawnSync(['bash', '-c', runCommand], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELANOUS_STATE_DIR: out, ELANOUS_CONFIG_DIR: out } });
        expect(withoutTopLevelOk.exitCode).toBe(0);
        const missingTopLevelLog = readFileSync(outputFile, 'utf8');
        const askLine = missingTopLevelLog.trimEnd().split('\n').find((line) => line.includes('"kind":"self"'))!;
        expect(JSON.parse(askLine)).toMatchObject({ kind: 'self', result: { ok: false, stage: 'pr-opened', prUrl: 'https://github.com/o/r/pull/9' } });
        expect(Object.hasOwn(JSON.parse(askLine), 'ok')).toBe(false);
        expect(JSON.parse(missingTopLevelLog.trimEnd().split('\n').at(-1)!)).toMatchObject({ ok: false, stage: 'pr-opened', prUrl: 'https://github.com/o/r/pull/9' });
        const { k: kubectlWithoutTopLevelOk } = fakeKubectl(['Failed'], missingTopLevelLog);
        const preserved = await podSelfImplementSpawn({ kubectl: kubectlWithoutTopLevelOk, credentials: CREDS, env: {} })({ feature: 'goal', spaceId: 'pod-ask-without-top-ok' }).done;
        expect(preserved.exitCode).toBe(1);
        expect(preserved.disposition?.ok).toBe(false);
        expect(preserved.disposition?.stage).toBe('pr-opened');
        expect(preserved.disposition?.prUrl).toBe('https://github.com/o/r/pull/9');
      } finally { rmSync(out, { recursive: true, force: true }); }
      expect(result.disposition?.prUrl).toBeUndefined();
    } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('harness ask follows hostSupervised default and false', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-child-supervise-'));
    const previous = process.cwd();
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(root, 'GOAL.md'), '# goal');
      process.chdir(root);
      for (const hostSupervised of [undefined, false]) {
        const { k, calls } = fakeKubectl(['Complete'], '');
        await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: 'GOAL.md' }, ...(hostSupervised === undefined ? {} : { hostSupervised }) })({ feature: 'goal', spaceId: `pod-child-supervise-${hostSupervised}` }).done;
        const job = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!)).find((m) => m.kind === 'Job');
        const command = (job.spec.template.spec.containers[0].args[0] as string).split('\n').find((line) => line.startsWith('elanous harness ask '))!;
        expect(command.includes('--no-supervise')).toBe(hostSupervised !== false);
      }
    } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  // POD-NORESULT ⓑ (10-07): si-task-71f68d57f6b7 printed its {kind:"self"} result, then `[graph] collect …` on stderr;
  // the last-line-only flatten skipped it and the host kept ok:false with no stage or PR number.
  test('a failed harness ask whose result line is followed by stderr still ends with the flat result the host reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-noresult-'));
    const out = mkdtempSync(join(tmpdir(), 'pod-noresult-out-'));
    const previous = process.cwd();
    const goal = 'docs/goals/ASK-noresult.md';
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      writeFileSync(join(root, goal), goalWithCompletionBoundary('# goal'));
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: goal } })({ feature: 'goal', spaceId: 'pod-noresult' }).done;
      const job = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!)).find((m) => m.kind === 'Job');
      const command = (job.spec.template.spec.containers[0].args[0] as string).split('\n').find((line) => line.startsWith('elanous harness ask '))!;
      const outputFile = join(out, 'si.out');
      const bin = join(out, 'bin');
      mkdirSync(bin);
      const entry = join(out, 'run-ask.ts');
      writeFileSync(entry, `import { program, setRunDevAskFromGoalFileDepsForTesting } from ${JSON.stringify(import.meta.dir + '/../../index.ts')};\n`
        + `setRunDevAskFromGoalFileDepsForTesting({\n`
        + `  loadDevCli: async () => ({ assertDevCliPathOptions: () => {}, selectDevAuthorInput: (_args: unknown, opts: { ask: string }) => ({ kind: 'ask', value: opts.ask }), buildDevCliSpec: (input: unknown) => ({ input }), startDraftTriage: () => {} }),\n`
        + `  runAskFileLaunchFlow: async () => ({ kind: 'launch', goalFile: ${JSON.stringify(goal)} }),\n`
        + `  loadDevPipeline: async () => ({ runDevPipeline: async () => ({ kind: 'self', result: { ok: false, stage: 'review-blocked', node: 'rework', outcome: 'budget-exhausted', prNumber: 24563, prUrl: 'https://github.com/o/r/pull/24563' }, plan: {} }), devResultOk: () => false }),\n`
        + `  setExitCode: (code: number) => { process.exitCode = code; },\n`
        + `});\nawait program.parseAsync(['node', 'elanous', ...process.argv.slice(2)]);\n`
        + `console.error('[graph] collect start (0.00s)');\nconsole.error('[graph] collect fail (9.07s)');\n`);
      writeFileSync(join(bin, 'elanous'), `#!/bin/sh\nexec bun ${JSON.stringify(entry)} "$@"\n`);
      chmodSync(join(bin, 'elanous'), 0o755);
      const launched = Bun.spawnSync(['bash', '-c', `${command.replaceAll('/tmp/si.out', outputFile)}\nexit $rc`], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELANOUS_STATE_DIR: out, ELANOUS_CONFIG_DIR: out } });
      expect(launched.exitCode).toBe(2);
      const jobLog = readFileSync(outputFile, 'utf8');
      const lines = jobLog.trimEnd().split('\n');
      expect(lines.filter((line) => line.includes('"kind":"self"'))).toHaveLength(1);
      expect(lines.indexOf('[graph] collect fail (9.07s)')).toBeGreaterThan(lines.findIndex((line) => line.includes('"kind":"self"')));
      const last = JSON.parse(lines.at(-1)!);
      expect(last).toMatchObject({ ok: false, stage: 'review-blocked', prNumber: 24563, prUrl: 'https://github.com/o/r/pull/24563' });
      expect(Object.hasOwn(last, 'kind')).toBe(false);
      expect(lines.filter((line) => line.startsWith('{"ok":false,"stage":"review-blocked"'))).toHaveLength(1);
      const { k: failedKubectl } = fakeKubectl(['Failed'], jobLog);
      const failed = await podSelfImplementSpawn({ kubectl: failedKubectl, credentials: CREDS, env: {} })({ feature: 'goal', spaceId: 'pod-noresult-host' }).done;
      expect(failed.exitCode).toBe(1);
      expect(failed.disposition).toMatchObject({ ok: false, stage: 'review-blocked', prNumber: 24563, prUrl: 'https://github.com/o/r/pull/24563' });
    } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
  });

  test('goal-doc spawn preserves the top-level ask but runs distinct shards by their feature', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-goal-shards-'));
    const previous = process.cwd();
    const goal = 'docs/goals/x.md';
    const stamp = (position: number, shardId: string, summary: string) => JSON.stringify({ orchestrationId: 'a5096ecf-cb0b-4dd9-84eb-bfdffa07a280', shardId, totalShards: 2, position, summary, siblings: [{ shardId: position === 1 ? 'task:bbbbbb' : 'task:aaaaaa', summary: position === 1 ? 'implement B' : 'implement A' }] });
    const featureA = `implement A\n\n## Shard identity\n${stamp(1, 'task:aaaaaa', 'implement A')}\n\n## Dependency handoff\n- upstream: ready`;
    const featureB = `implement B\n\n## Shard identity\n${stamp(2, 'task:bbbbbb', 'implement B')}`;
    const exampleGoal = `# original goal\n\n## Shard identity\n${stamp(1, 'task:aaaaaa', '# original goal')}`;
    const topFeature = exampleGoal;
    const exampleStamped = `${exampleGoal}\n\n## Shard identity\n${JSON.stringify({ orchestrationId: 'a5096ecf-cb0b-4dd9-84eb-bfdffa07a280', shardId: 'task:abcdef', totalShards: 1, position: 1, summary: exampleGoal.replace(/\s+/g, ' '), siblings: [] })}`;
    const modes: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-goal-shard-mode', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'goal-doc-mode') modes.push(record.data as Record<string, unknown>);
    } });
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      writeFileSync(join(root, goal), exampleGoal);
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      const spawn = podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: goal, ELANOUS_STATE_DIR: root } });
      for (const [spaceId, feature] of [['top', topFeature], ['piece-a', featureA], ['piece-b', featureB], ['example-stamped', exampleStamped]] as const) {
        expect((await spawn({ feature, spaceId }).done).exitCode).toBe(0);
      }
      const applied = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
      const secrets = applied.filter((m) => m.kind === 'Secret');
      const scripts = applied.filter((m) => m.kind === 'Job').map((m) => m.spec.template.spec.containers[0].args[0] as string);
      expect(scripts).toHaveLength(4);
      expect(scripts[0]).toContain(`elanous harness ask '${goal}' --json`);
      expect(scripts[0]).not.toContain('elanous self implement');
      for (const script of scripts.slice(1, 3)) {
        expect(script).not.toContain('harness ask');
        expect(script).not.toContain('/creds/goal-doc');
        expect(script).toContain('elanous self implement "$(cat /creds/feature)" --json');
      }
      expect(secrets.slice(1, 3).every((m) => m.stringData['goal-doc'] === undefined)).toBe(true);
      expect(scripts[3]).not.toContain('harness ask');
      expect(scripts[3]).toContain('elanous self implement "$(cat /creds/feature)" --json');
      expect(secrets[3].stringData['goal-doc']).toBeUndefined();
      expect(secrets.map((m) => m.stringData.feature)).toEqual([topFeature, featureA, featureB, exampleStamped]);
      expect(secrets[1].stringData.feature).not.toBe(secrets[2].stringData.feature);
      expect(modes).toEqual([
        expect.objectContaining({ spaceId: 'top', mode: 'goal-doc', reason: 'goal-doc-env' }),
        expect.objectContaining({ spaceId: 'piece-a', mode: 'shard-feature', reason: 'shard-identity' }),
        expect.objectContaining({ spaceId: 'piece-b', mode: 'shard-feature', reason: 'shard-identity' }),
        expect.objectContaining({ spaceId: 'example-stamped', mode: 'shard-feature', reason: 'shard-identity' }),
      ]);
    } finally { off(); process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('a single real shard with the exact goal body uses its own feature, while an identical unstamped top-level ask stays an ask', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-single-shard-'));
    const previous = process.cwd();
    const goal = 'docs/goals/x.md';
    const document = goalWithCompletionBoundary('# original goal');
    const modes: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-single-shard-mode', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'goal-doc-mode') modes.push(record.data as Record<string, unknown>);
    } });
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      writeFileSync(join(root, goal), document);
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      const spawn = podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: goal, ELANOUS_STATE_DIR: root } });
      expect((await spawn({ feature: document, spaceId: 'single-top' }).done).exitCode).toBe(0);
      const results = await orchestrateSelfDev({
        goals: [{ feature: document }], parentRequest: document,
        concurrency: 1, spawn, readScreenTranscript: () => null, readScreenTail: () => null,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe('done');
      const applied = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!));
      const [top, shard] = applied.filter((manifest) => manifest.kind === 'Secret');
      const [topJob, shardJob] = applied.filter((manifest) => manifest.kind === 'Job');
      const topScript = topJob.spec.template.spec.containers[0].args[0] as string;
      const shardScript = shardJob.spec.template.spec.containers[0].args[0] as string;
      expect(topScript).toContain(`elanous harness ask '${goal}' --json`);
      expect(top.stringData['goal-doc']).toBe(document);
      expect(shard.stringData.feature).toStartWith(`${document}\n\n## Shard identity\n`);
      expect(JSON.parse(shard.stringData.feature.split('## Shard identity\n')[1])).toMatchObject({ totalShards: 1, position: 1, summary: document.replace(/\s+/g, ' ') });
      expect(shard.stringData['goal-doc']).toBeUndefined();
      expect(shardScript).not.toContain('harness ask');
      expect(shardScript).toContain('elanous self implement "$(cat /creds/feature)" --json');
      expect(modes).toEqual([
        expect.objectContaining({ spaceId: 'single-top', mode: 'goal-doc', reason: 'goal-doc-env' }),
        expect.objectContaining({ mode: 'shard-feature', reason: 'shard-identity' }),
      ]);
    } finally { off(); process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('real decomposition stamps launch distinct shard Jobs while an example in the original goal stays an ask', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-real-shards-'));
    const previous = process.cwd();
    const goal = 'docs/goals/x.md';
    const example = goalWithCompletionBoundary('# original goal\n\nExample of a proposed shard:\n## Shard identity\n{"pieceIndex":1,"totalShards":2}');
    const modes: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-real-shards-mode', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'goal-doc-mode') modes.push(record.data as Record<string, unknown>);
    } });
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      writeFileSync(join(root, goal), example);
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      const spawn = podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: goal, ELANOUS_STATE_DIR: root } });
      expect((await spawn({ feature: example, spaceId: 'original-example' }).done).exitCode).toBe(0);
      const results = await orchestrateSelfDev({
        goals: [{ feature: 'implement A' }, { feature: 'implement B' }], parentRequest: example,
        concurrency: 2, spawn, readScreenTranscript: () => null, readScreenTail: () => null,
      });
      expect(results).toHaveLength(2);
      expect(results.every((result) => result.status === 'done')).toBe(true);
      const applied = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!));
      const jobs = applied.filter((manifest) => manifest.kind === 'Job');
      const secrets = applied.filter((manifest) => manifest.kind === 'Secret');
      expect(new Set(jobs.map((job) => job.metadata.name)).size).toBe(3);
      const scripts = jobs.map((job) => job.spec.template.spec.containers[0].args[0] as string);
      expect(scripts[0]).toContain(`elanous harness ask '${goal}' --json`);
      expect(secrets[0].stringData['goal-doc']).toBe(example);
      for (const script of scripts.slice(1)) {
        expect(script).not.toContain('harness ask');
        expect(script).toContain('elanous self implement "$(cat /creds/feature)" --json');
      }
      expect(secrets.slice(1).map((secret) => secret.stringData.feature.split('\n')[0]).sort()).toEqual(['implement A', 'implement B']);
      expect(secrets[1].stringData.feature).not.toBe(secrets[2].stringData.feature);
      expect(secrets.slice(1).every((secret) => secret.stringData['goal-doc'] === undefined)).toBe(true);
      expect(modes).toEqual([
        expect.objectContaining({ spaceId: 'original-example', mode: 'goal-doc', reason: 'goal-doc-env' }),
        expect.objectContaining({ mode: 'shard-feature', reason: 'shard-identity' }),
        expect.objectContaining({ mode: 'shard-feature', reason: 'shard-identity' }),
      ]);
    } finally { off(); process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('a shard whose own body quotes handoff headings is still recognised by its identity (real orchestrateSelfDev)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-shard-quoted-handoff-'));
    const previous = process.cwd();
    const goal = 'docs/goals/x.md';
    const document = goalWithCompletionBoundary('# original goal');
    const quoted = 'implement A\n\n## Working-memory handoff\nquoted in the body\n\n## Dependency handoff\nalso quoted';
    const modes: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-shard-quoted-handoff-mode', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'goal-doc-mode') modes.push(record.data as Record<string, unknown>);
    } });
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      writeFileSync(join(root, goal), document);
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      const spawn = podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: goal, ELANOUS_STATE_DIR: root } });
      const results = await orchestrateSelfDev({
        goals: [{ id: 'a', feature: quoted }, { id: 'b', feature: 'implement B', dependsOn: ['a'] }], parentRequest: document,
        concurrency: 1, spawn, readScreenTranscript: () => null, readScreenTail: () => null,
      });
      expect(results.every((result) => result.status === 'done')).toBe(true);
      const applied = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!));
      const jobs = applied.filter((manifest) => manifest.kind === 'Job');
      const secrets = applied.filter((manifest) => manifest.kind === 'Secret');
      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        const script = job.spec.template.spec.containers[0].args[0] as string;
        expect(script).not.toContain('harness ask');
        expect(script).toContain('elanous self implement "$(cat /creds/feature)" --json');
      }
      expect(secrets.every((secret) => secret.stringData['goal-doc'] === undefined)).toBe(true);
      expect(secrets[0].stringData.feature).toStartWith(quoted);
      expect(modes).toEqual([
        expect.objectContaining({ mode: 'shard-feature', reason: 'shard-identity' }),
        expect.objectContaining({ mode: 'shard-feature', reason: 'shard-identity' }),
      ]);
    } finally { off(); process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('a shard identity heading without valid shard data keeps the top-level goal document', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-shard-heading-'));
    const previous = process.cwd();
    const goal = 'docs/goals/x.md';
    const modes: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-shard-heading-mode', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'goal-doc-mode') modes.push(record.data as Record<string, unknown>);
    } });
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      writeFileSync(join(root, goal), '# original goal');
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      const spawn = podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: goal, ELANOUS_STATE_DIR: root } });
      const invalidFeatures = [
        'implement A\n\n## Shard identity\n',
        'implement A\n\n## Shard identity\n{not json}',
        'implement A\n\n## Shard identity\n{"totalShards":2,"position":1}',
        'implement A\n\n## Shard identity\n{"pieceIndex":3,"totalShards":2}',
      ];
      expect((await spawn({ feature: '# original goal', spaceId: 'heading-top' }).done).exitCode).toBe(0);
      for (const [index, feature] of invalidFeatures.entries()) {
        expect((await spawn({ feature, spaceId: `heading-${index}` }).done).exitCode).toBe(0);
      }
      const applied = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
      for (const job of applied.filter((m) => m.kind === 'Job')) {
        const script: string = job.spec.template.spec.containers[0].args[0];
        expect(script).toContain(`elanous harness ask '${goal}' --json`);
        expect(script).not.toContain('elanous self implement');
      }
      expect(applied.filter((m) => m.kind === 'Secret').map((m) => m.stringData.feature)).toEqual(['# original goal', ...invalidFeatures]);
      expect(modes).toEqual(['heading-top', ...invalidFeatures.map((_, index) => `heading-${index}`)].map((spaceId) =>
        expect.objectContaining({ spaceId, mode: 'goal-doc', reason: 'goal-doc-env' })));
    } finally { off(); process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('pieceIndex examples alone keep goal-document mode even when appended after the goal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-piece-shards-'));
    const previous = process.cwd();
    const goal = 'docs/goals/x.md';
    const modes: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-piece-shard-mode', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'goal-doc-mode') modes.push(record.data as Record<string, unknown>);
    } });
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      const exampleGoal = '# original goal\n\n## Shard identity\n{"pieceIndex":1,"totalShards":2}';
      writeFileSync(join(root, goal), exampleGoal);
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      const spawn = podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: goal, ELANOUS_STATE_DIR: root } });
      const features = [exampleGoal,
        'implement A\n\n## Shard identity\n{"pieceIndex":1,"totalShards":2}\n\n## Working-memory handoff\nExample:\n## Shard identity\n{"pieceIndex":2,"totalShards":2}',
        'implement B\n\n## Shard identity\n{"pieceIndex":2,"totalShards":2}',
        '# original goal\n\n## Shard identity\n{"pieceIndex":1,"totalShards":1}',
        '# original goal\n\n## Working-memory handoff\nExample of an earlier shard:\n## Shard identity\n{"pieceIndex":1,"totalShards":2}',
        `${exampleGoal}\n\n## Shard identity\n{"pieceIndex":1,"totalShards":2}`];
      for (const [index, feature] of features.entries()) {
        expect((await spawn({ feature, spaceId: `piece-${index}` }).done).exitCode).toBe(0);
      }
      const applied = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
      const secrets = applied.filter((m) => m.kind === 'Secret');
      const scripts = applied.filter((m) => m.kind === 'Job').map((m) => m.spec.template.spec.containers[0].args[0] as string);
      expect(scripts).toHaveLength(6);
      expect(scripts[0]).toContain(`elanous harness ask '${goal}' --json`);
      expect(scripts[0]).not.toContain('elanous self implement');
      for (const script of scripts) {
        expect(script).toContain(`elanous harness ask '${goal}' --json`);
        expect(script).not.toContain('elanous self implement');
      }
      expect(secrets.map((m) => m.stringData.feature)).toEqual(features);
      expect(secrets[1].stringData.feature).not.toBe(secrets[2].stringData.feature);
      expect(secrets[5].stringData['goal-doc']).toContain(exampleGoal);
      expect(modes).toEqual([
        expect.objectContaining({ spaceId: 'piece-0', mode: 'goal-doc', reason: 'goal-doc-env' }),
        expect.objectContaining({ spaceId: 'piece-1', mode: 'goal-doc', reason: 'goal-doc-env' }),
        expect.objectContaining({ spaceId: 'piece-2', mode: 'goal-doc', reason: 'goal-doc-env' }),
        expect.objectContaining({ spaceId: 'piece-3', mode: 'goal-doc', reason: 'goal-doc-env' }),
        expect.objectContaining({ spaceId: 'piece-4', mode: 'goal-doc', reason: 'goal-doc-env' }),
        expect.objectContaining({ spaceId: 'piece-5', mode: 'goal-doc', reason: 'goal-doc-env' }),
      ]);
    } finally { off(); process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('a goal containing ;; and a valid shard example remains top-level for both raw and escaped feature sources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-semicolon-goal-'));
    const previous = process.cwd();
    const goal = 'docs/goals/x.md';
    const document = '# goal ;; example\n\n## Shard identity\n{"pieceIndex":1,"totalShards":2}\n';
    const modes: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-semicolon-goal-mode', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'goal-doc-mode') modes.push(record.data as Record<string, unknown>);
    } });
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      writeFileSync(join(root, goal), document);
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      const spawn = podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: goal, ELANOUS_STATE_DIR: root } });
      for (const [spaceId, feature] of [['raw', document], ['escaped', document.replaceAll(';;', '; ;')]] as const) {
        expect((await spawn({ spaceId, feature }).done).exitCode).toBe(0);
      }
      const applied = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
      const secrets = applied.filter((m) => m.kind === 'Secret');
      const scripts = applied.filter((m) => m.kind === 'Job').map((m) => m.spec.template.spec.containers[0].args[0] as string);
      expect(secrets[0].stringData['goal-doc']).toBe(document);
      expect(secrets[1].stringData['goal-doc']).toStartWith(document);
      for (const script of scripts) {
        expect(script).toContain(`elanous harness ask '${goal}' --json`);
        expect(script).not.toContain('elanous self implement');
      }
      expect(modes).toEqual([
        expect.objectContaining({ spaceId: 'raw', mode: 'goal-doc', reason: 'goal-doc-env' }),
        expect.objectContaining({ spaceId: 'escaped', mode: 'goal-doc', reason: 'goal-doc-env' }),
      ]);
    } finally { off(); process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('CRLF goal examples with valid multi-shard identities and a handoff still launch the top-level ask', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-crlf-goal-'));
    const previous = process.cwd();
    const goal = 'docs/goals/x.md';
    const stamp = (position: number) => JSON.stringify({ orchestrationId: 'a5096ecf-cb0b-4dd9-84eb-bfdffa07a280', shardId: `task:example-${position}`, totalShards: 2, position, summary: `example ${position}`, siblings: [] });
    const document = `# goal\r\n\r\n## Shard identity\r\n${stamp(1)}\r\n\r\n## Shard identity\r\n${stamp(2)}\r\n`;
    const feature = `${document.trim()}\n\n## Working-memory handoff\nPass along findings`;
    const modes: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-crlf-goal-mode', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'goal-doc-mode') modes.push(record.data as Record<string, unknown>);
    } });
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      writeFileSync(join(root, goal), document);
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: goal, ELANOUS_STATE_DIR: root } })({ feature, spaceId: 'crlf-top' }).done;
      expect(result.exitCode).toBe(0);
      const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
      const script = job.spec.template.spec.containers[0].args[0] as string;
      expect(secret.stringData['goal-doc']).toBe(document);
      expect(script).toContain(`elanous harness ask '${goal}' --json`);
      expect(script).not.toContain('elanous self implement');
      expect(modes).toEqual([expect.objectContaining({ spaceId: 'crlf-top', mode: 'goal-doc', reason: 'goal-doc-env' })]);
    } finally { off(); process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('a root goal filename beginning with a dash is passed as a safe operand', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-dash-goal-'));
    const previous = process.cwd();
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(root, '-goal.md'), '# root goal');
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: '-goal.md' } })({ feature: 'goal', spaceId: 'pod-dash-goal' }).done;
      const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
      expect(secret.stringData['goal-doc']).toBe('# root goal');
      const script = job.spec.template.spec.containers[0].args[0] as string;
      expect(script).toContain("cp -- /creds/goal-doc './-goal.md'");
      expect(script).toContain("elanous harness ask './-goal.md' --json");
      expect(script).not.toContain("elanous harness ask '-goal.md'");
      const clone = mkdtempSync(join(tmpdir(), 'pod-dash-clone-'));
      try {
        const source = join(root, 'secret-payload');
        writeFileSync(source, secret.stringData['goal-doc']);
        const copy = script.split('\n').find((line) => line.startsWith('mkdir -p -- "$(dirname'))!;
        const restored = Bun.spawnSync(['bash', '-c', copy.replace('/creds/goal-doc', source)], { cwd: clone });
        expect(restored.exitCode).toBe(0);
        expect(readFileSync(join(clone, '-goal.md'), 'utf8')).toBe('# root goal');
      } finally { rmSync(clone, { recursive: true, force: true }); }
    } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('refuses a goal-doc path that escapes the repository through a symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-goal-guard-'));
    const outside = mkdtempSync(join(tmpdir(), 'pod-goal-external-'));
    const previous = process.cwd();
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(outside, 'ASK.md'), '# outside');
      symlinkSync(join(outside, 'ASK.md'), join(root, 'ASK.md'));
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: 'ASK.md' } })({ feature: 'goal', spaceId: 'pod-guard' }).done;
      expect(result.exitCode).toBe(1);
      expect(result.error?.message).toContain('outside repository');
      expect(calls.some((c) => c.args.endsWith('apply -f -'))).toBe(false);
    } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  test('without a goal document a spawn records feature mode', async () => {
    const { k } = fakeKubectl(['Complete'], '');
    const modes: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-feature-mode', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'goal-doc-mode') modes.push(record.data as Record<string, unknown>);
    } });
    try {
      await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'normal', spaceId: 'feature-only' }).done;
      expect(modes).toEqual([expect.objectContaining({ spaceId: 'feature-only', mode: 'feature', reason: 'no-goal-doc' })]);
    } finally { off(); }
  });

  test('without goal document the original self implement Job script remains unchanged', () => {
    const base = { name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: ['--base', 'main'], passEnv: [], deadlineSeconds: 60 };
    const script = (podJobManifest(base) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } }).spec.template.spec.containers[0]!.args[0]!;
    expect(script).toContain('elanous self implement "$(cat /creds/feature)" --json');
    expect(script).not.toContain('harness ask');
    expect(script).not.toContain('/creds/goal-doc');
  });

  test('manifest hands off the fixed inbox and host records the active fragment until Job completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-record-'));
    const env = { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: 'run-parent-1' };
    let finish!: () => void;
    let completed = false;
    const wait = new Promise<void>((resolve) => { finish = () => { completed = true; resolve(); }; });
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const kubectl: Kubectl = (args, input) => {
      calls.push({ args, input });
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };   // 재개 존재 확인 — 새 Job
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: completed ? 'Complete' : '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const { done } = podSelfImplementSpawn({ kubectl, credentials: CREDS, env, sleep: () => wait })({ feature: 'goal', spaceId: 'pod-fragment' });
    for (let i = 0; i < 100 && !calls.some((call) => call.args.includes('apply') && call.input?.includes('"kind":"Job"')); i++) await Bun.sleep(1);
      for (let i = 0; i < 100 && !readPodFragment('pod-fragment', env); i++) await Bun.sleep(1);
      const record = readPodFragment('pod-fragment', env);
      const job = calls.filter((call) => call.args.includes('apply')).map((call) => JSON.parse(call.input!)).find((manifest) => manifest.kind === 'Job');
      const jobEnv = job.spec.template.spec.containers[0].env as Array<{ name: string; value: string }>;
      expect(jobEnv).toContainEqual({ name: CONTROL_INBOX_DIR_ENV, value: '/tmp/elanous-control.inbox' });
      const childRunId = jobEnv.find((entry) => entry.name === 'ELANOUS_RUN_ID')?.value;
      expect(childRunId).toMatch(/^run-[0-9a-f-]{36}$/);
      expect(jobEnv).toContainEqual({ name: 'ELANOUS_PARENT_RUN_ID', value: env.ELANOUS_RUN_ID });
      expect(record).toEqual({ spaceId: 'pod-fragment', runId: childRunId, parentRunId: env.ELANOUS_RUN_ID, context: 'test-context', namespace: 'elanous-test', job: podJobName('pod-fragment'), inboxDir: '/tmp/elanous-control.inbox' });
      finish();
      await done;
      expect(readPodFragment('pod-fragment', env)).toBeNull();
      expect(podFragmentFinished('pod-fragment', env)).toBe(true);
    } finally { finish(); rmSync(root, { recursive: true, force: true }); }
  });

  test('failed child reports the last result line, GraphQL failure and redacted first/last error lines', async () => {
    const error = 'draft PR 생성 실패(worktree·branch 보존 · self-impl/src-nexus-api-trace-ts-src-nexus-api-tra-4131fa54 · /home/ubuntu/.elanous/worktrees/ubuntu-678d8d02/repo.worktrees/self-impl-src-nexus-api-trace-ts-src-nexus-api-tra-4131fa54)\nself-implement PR gh 실패: GraphQL: API rate limit already exceeded for user ID 19355785.';
    const finalLine = JSON.stringify({ stage: 'error', ok: false, error });
    const previous = JSON.stringify({ stage: 'earlier', ok: false, error: 'not the failure' });
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'pod-child-result-line', emit: (record) => {
      if (record.category === 'self-implement.pod' && ['job-finished', 'child-error'].includes(record.event)) events.push({ event: record.event, data: record.data as Record<string, unknown> });
    } });
    const kubectl: Kubectl = (args) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.includes('get') && args.includes('pods')) return { status: 0, stdout: '2026-09-29T03:11:00Z\tError\t1\n', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: `noise\n${previous}\n${finalLine}\nELANOUS_POD_SALVAGE_NONE clean\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'pr-rate-limit' }).done;
      expect(result.error?.code).toBe('pod-job-failed');
      expect(result.error?.message).toContain('container=Error/1');
      expect(result.error?.message).toContain('GraphQL: API rate limit already exceeded');
      expect(result.error?.message).toContain('~/.elanous/worktrees/');
      expect(result.error?.message).not.toContain('/home/ubuntu/');
      expect(result.error?.message).not.toContain('not the failure');
      expect(result.error?.message?.split('childError=')[1]?.split('\n')).toHaveLength(2);
      expect(result.error?.message?.split('childError=')[1]?.split('\n').every((line) => line.length <= 240)).toBe(true);
      expect(events).toContainEqual({ event: 'child-error', data: expect.objectContaining({ job: podJobName('pr-rate-limit'), stage: 'error', error: expect.stringContaining('GraphQL: API rate limit already exceeded') }) });
      expect(events.find((e) => e.event === 'job-finished')?.data).toMatchObject({ childStage: 'error', childError: expect.stringContaining('GraphQL: API rate limit already exceeded') });
      expect(String(events.find((e) => e.event === 'job-finished')?.data.childError)).not.toContain('/home/ubuntu/');
      expect(events.find((e) => e.event === 'job-finished')?.data.childError).toEqual(result.error?.message?.split('childError=')[1]);
    } finally { off(); }
  });

  test('failed child error bounds each endpoint independently and retains the last line', async () => {
    const first = 'first-' + 'a'.repeat(300);
    const last = 'last-GraphQL: API rate limit already exceeded ' + 'z'.repeat(300);
    const { k } = fakeKubectl(['Failed'], JSON.stringify({ stage: 'error', ok: false, error: `${first}\nintermediate line\n${last}` }));
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-error-endpoints', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    try {
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'error-endpoints' }).done;
      const childError = `${first.slice(0, 240)}\n${last.slice(0, 240)}`;
      expect(result.error?.message).toContain(`childStage=error · childError=${childError}`);
      expect(result.error?.message).not.toContain('intermediate line');
      expect(finished[0]).toMatchObject({ childStage: 'error', childError });
    } finally { off(); }
  });

  test('long PR worktree failure keeps the actionable tail and observed blocker identities', async () => {
    const location = `draft PR 생성 실패(worktree·branch 보존 · ${'long-path-'.repeat(40)})`;
    const detail = `${'noise-'.repeat(50)}self-implement PR guard 실패: same-cell: OPEN PR; candidateCardId=ta-candidate; blockers=#29829:ta-existing`;
    const error = `${location}\n${detail}`;
    const { k } = fakeKubectl(['Failed'], JSON.stringify({ stage: 'error', ok: false, error }));
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-pr-error-tail', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    try {
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'pr-error-tail' }).done;
      expect(result.error?.message).toContain('childStage=error');
      expect(finished[0]).toMatchObject({
        childErrorTail: detail.slice(-240),
        prFailureStage: 'pr-open-failed',
        prFailureSource: 'terminal-result',
        blockingPrNumber: 29829,
        candidateCardId: 'ta-candidate',
        blockingCardId: 'ta-existing',
      });
      expect(String(finished[0]?.childError).split('\n').every((line) => line.length <= 240)).toBe(true);
      expect(String(finished[0]?.childError)).not.toContain('candidateCardId=ta-candidate');
      expect(String(finished[0]?.childErrorTail)).toContain('candidateCardId=ta-candidate');
    } finally { off(); }
  });

  test('failed nested child result is the Job error, not a later graph failure', async () => {
    const child = JSON.stringify({ ok: false, kind: 'self', result: { ok: false, stage: 'aborted', node: 'implement', outcome: 'abandoned', abandonedClassification: { classification: 'report-deficit' } } });
    const { k } = fakeKubectl(['Failed'], `${child}\n[graph] collect fail (0.28s)`);
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-nested-result', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    try {
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'nested-result' }).done;
      expect(result.error?.message).toContain('childStage=aborted · childError=implement abandoned · report-deficit');
      expect(result.error?.message).not.toContain('no-result-line');
      expect(result.error?.message).not.toContain('[graph] collect fail');
      expect(finished[0]).toMatchObject({ childStage: 'aborted', childError: 'implement abandoned · report-deficit' });
    } finally { off(); }
  });

  test('a later non-child JSON result row does not erase the nested child failure', async () => {
    const child = JSON.stringify({ ok: false, kind: 'self', result: { ok: false, stage: 'aborted', node: 'rework', outcome: 'abandoned', supervisorVerdict: 'UNCONVERGEABLE' } });
    const graph = JSON.stringify({ kind: 'graph', result: { stage: 'merged', ok: true } });
    const flatGraph = JSON.stringify({ kind: 'graph', stage: 'merged', ok: true });
    const { k } = fakeKubectl(['Failed'], `${child}\n${graph}\n${flatGraph}`);
    const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'nested-result-graph' }).done;
    expect(result.error?.message).toContain('childStage=aborted · childError=rework abandoned · UNCONVERGEABLE');
    expect(result.error?.message).not.toContain('no-result-line');
  });

  test('nested rework verdict is surfaced and nested success does not reuse an earlier failure', async () => {
    const failed = JSON.stringify({ kind: 'self', ok: false, result: { stage: 'aborted', ok: false, node: 'rework', outcome: 'abandoned', supervisorVerdict: 'UNCONVERGEABLE' } });
    const { k } = fakeKubectl(['Failed'], failed);
    const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'nested-rework' }).done;
    expect(result.error?.message).toContain('childError=rework abandoned · UNCONVERGEABLE');
    const success = JSON.stringify({ kind: 'self', ok: true, result: { stage: 'merged', ok: true } });
    const { k: successKubectl } = fakeKubectl(['Failed'], `${failed}\n${success}\n[graph] collect fail (0.28s)`);
    const completed = await podSelfImplementSpawn({ kubectl: successKubectl, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'nested-success' }).done;
    expect(completed.disposition).toMatchObject({ stage: 'merged', ok: true });
    expect(completed.disposition?.childEvidence).toBeUndefined();
    expect(completed.error?.message).toContain('childStage=merged');
    expect(completed.error?.message).not.toContain('UNCONVERGEABLE');
  });

  test('a failed Job whose last result is successful does not reuse an earlier failure', async () => {
    const logs = `${JSON.stringify({ stage: 'error', ok: false, error: 'earlier failure' })}\n${JSON.stringify({ stage: 'merged', ok: true })}\n`;
    const { k } = fakeKubectl(['Failed'], logs);
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-last-result-line', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    try {
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'last-result-line' }).done;
      // POD-NORESULT: the last result row was read (stage merged) — it is «result without error», not a missing line.
      expect(result.error?.message).toContain('childStage=merged');
      expect(result.error?.message).not.toContain('no-result-line');
      expect(result.error?.message).not.toContain('earlier failure');
      expect(finished[0]).toMatchObject({ childStage: 'merged', childError: 'result-without-error' });
    } finally { off(); }
  });

  test('POD-NORESULT: a failed Job whose result row names a stage and PR without error text reports them instead of «unreadable»', async () => {
    // The real shape (run-111041d1 · 10-06): the child's result row names a stage and PR but carries no error text,
    // so lastPodChildFailure finds nothing and the old reason fell back to «사유 못 읽음».
    const row = JSON.stringify({ stage: 'review-blocked', ok: false, prUrl: 'https://github.com/o/r/pull/24496', prNumber: 24496 });
    const { k } = fakeKubectl(['Failed'], `progress line\n${row}\n`);
    const reasons: string[] = [];
    const off = debug.registerSink({ name: 'pod-noresult-ledger-reason', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'failure-reason') reasons.push(String((record.data as Record<string, unknown>).reason));
    } });
    try {
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'noresult-ledger' }).done;
      expect(result.exitCode).toBe(1);
      expect(result.disposition?.prUrl).toBe('https://github.com/o/r/pull/24496');
      expect(reasons).toEqual(['수확 가능(review-blocked) · PR #24496']);
      expect(result.error?.message).toContain('childStage=review-blocked · reason=수확 가능(review-blocked) · PR #24496');
      expect(result.error?.message).not.toContain('no-result-line');
      expect(result.error?.message ?? '').not.toContain('사유 못 읽음');
    } finally { off(); }
  });

  test('PREFLIGHT-RESULT-LINE: a Pod child stopped by preflight reports childStage=preflight-blocked and the blocker as its reason', async () => {
    const row = JSON.stringify({ kind: 'self', ok: false, stage: 'preflight-blocked', blockers: [{ kind: 'no-target-paths', name: '(대상 경로 0)', detail: '골에 실제 저장소 경로가 없다' }] });
    const { k } = fakeKubectl(['Failed'], `[ask] 0) Retry after failure\n[ask] 1) One error-message line\n${row}\n`);
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-preflight-blocked', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    try {
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'preflight-blocked' }).done;
      expect(result.error?.message).toContain('childStage=preflight-blocked · childError=(대상 경로 0) — 골에 실제 저장소 경로가 없다');
      expect(result.error?.message).not.toContain('no-result-line');
      expect(result.error?.message).not.toContain('One error-message line');
      expect(finished[0]).toMatchObject({ childStage: 'preflight-blocked' });
    } finally { off(); }
  });

  test('early goal-boundary rejection emits a structured preflight result even without a child ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-terminal-fallback-'));
    const previous = process.cwd();
    try {
      const goal = 'GOAL.md';
      execFileSync('git', ['init', '-q', dir]);
      writeFileSync(join(dir, goal), '# Goal\n\n## ACCEPTANCE CRITERIA\n\n- 기존 조건: 완료 경계가 없다\n');
      process.chdir(dir);
      const { k: manifestKubectl, calls } = fakeKubectl(['Complete'], '');
      await podSelfImplementSpawn({ kubectl: manifestKubectl, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: goal, ELANOUS_TASK_CARD_ID: 'ta-1' } })({ feature: 'goal', spaceId: 'goal-boundary-manifest' }).done;
      const job = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!)).find((m) => m.kind === 'Job');
      const command = (job.spec.template.spec.containers[0].args[0] as string).split('\n').find((line) => line.startsWith('elanous harness ask '))!;
      const path = join(dir, 'si.out');
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const entry = join(dir, 'run-ask.ts');
      writeFileSync(entry, `import { program, setRunDevAskFromGoalFileDepsForTesting } from ${JSON.stringify(import.meta.dir + '/../../index.ts')};\n`
        + `setRunDevAskFromGoalFileDepsForTesting({ runAskFileLaunchFlow: async (path: string) => ({ kind: 'launch', goalFile: path }) });\n`
        + `await program.parseAsync(['node', 'elanous', ...process.argv.slice(2)]);\n`);
      writeFileSync(join(bin, 'elanous'), `#!/bin/sh\nexec bun ${JSON.stringify(entry)} "$@"\n`);
      chmodSync(join(bin, 'elanous'), 0o755);
      const emitted = spawnSync('bash', ['-c', `${command.replaceAll('/tmp/si.out', path)}\nexit $rc`], {
        cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELANOUS_STATE_DIR: join(dir, 'state'),
          ELANOUS_CONFIG_DIR: join(dir, 'state'), ELANOUS_TASK_CARD_ID: 'ta-1', ELANOUS_SUBSTRATE: 'pod', NODE_ENV: 'test' },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(emitted.error).toBeUndefined();
      expect(emitted.status).not.toBe(0);
      const cliOutput = readFileSync(path, 'utf8');
      const diagnostic = cliOutput.split('\n').find((line) => line.includes('골 완료 경계 누락:'));
      if (!diagnostic) throw new Error(`expected goal-boundary diagnostic; child output:\n${cliOutput.slice(-4000)}`);
      expect(diagnostic).toContain('TA 카드 ta-1');
      const row = JSON.parse(readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)!);
      expect(row).toEqual({ stage: 'preflight-blocked', ok: false, error: diagnostic });
      const { k } = fakeKubectl(['Failed'], `${readFileSync(path, 'utf8')}\nELANOUS_RUN_LEDGER_NONE`);
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'goal-boundary-fallback' }).done;
      expect(result.error?.message).toContain(`childStage=preflight-blocked · childError=${diagnostic}`);
      expect(result.error?.message).not.toContain('childError=no-result-line');
    } finally {
      process.chdir(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('PR guard hunk overlap emits the conflict reason after draft PR opening throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-terminal-pr-guard-'));
    try {
      const root = process.cwd();
      const repo = join(dir, 'repo');
      const origin = join(dir, 'origin.git');
      execFileSync('git', ['init', '--bare', origin]);
      execFileSync('git', ['init', '-b', 'main', repo]);
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
      git('config', 'user.name', 'Pod Test');
      git('config', 'user.email', 'pod-test@example.invalid');
      git('config', 'core.hooksPath', '/dev/null');
      writeFileSync(join(repo, 'README.md'), 'base\n');
      git('add', 'README.md');
      git('commit', '-m', 'base');
      git('remote', 'add', 'origin', origin);
      git('push', '-u', 'origin', 'main');
      const cliModule = join(root, 'src/self-implement/self-implement-cli.ts');
      const preload = join(dir, 'pr-guard-preload.ts');
      // Keep the real CLI command and runSelfImplement path. The seams replace LLM/gate/network
      // work, while actual openPr → PrManager → guardNewPr produces the refusal in a temp repo.
      writeFileSync(preload, `import { mock } from 'bun:test';
import * as cli from ${JSON.stringify(cliModule)};
import { makePrManager } from ${JSON.stringify(join(root, 'src/autopilot/pr-manager.ts'))};
import { guardNewPr } from ${JSON.stringify(join(root, 'src/pr-tool/census.ts'))};
import { defaultSeams } from ${JSON.stringify(join(root, 'src/self-implement/seams.ts'))};
import { runSelfImplement } from ${JSON.stringify(join(root, 'src/self-implement/orchestrator.ts'))};
import { seams } from ${JSON.stringify(join(root, 'src/self-implement/test-seams.ts'))};
const realRunSelfImplementCliCommand = cli.runSelfImplementCliCommand;
mock.module(${JSON.stringify(cliModule)}, () => ({ ...cli, runSelfImplementCliCommand: (feature, opts) => {
  const candidatePath = 'src/cli/pr-cli.ts';
  const manager = makePrManager(() => ({ ok: true, out: '' }), () => guardNewPr(
    { files: [candidatePath], hunks: [{ path: candidatePath, start: 54, end: 60 }], hunkOverlap: 'refuse' },
    { status: 'checked', prs: [{ number: 28796, title: 'overlap', draft: true, updatedAt: '2026-10-17T00:00:00Z', headSha: 'a'.repeat(40), labels: [], files: [candidatePath], seat: 'UX', cellId: null,
      hunks: [{ path: candidatePath, start: 50, end: 55 }] }] }));
  return realRunSelfImplementCliCommand(feature, opts, {
    resolveWantAutoReview: () => false,
    pipelineDeps: {
      runGit: () => ({ status: 0, stdout: 'origin\\n', stderr: '' }),
      runSelfImplement: (options) => runSelfImplement({ ...options, seams: seams({
        gateResults: [true],
        createWorktree: async () => ({ path: ${JSON.stringify(repo)}, branch: 'self-impl/overlap', resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
        implement: async () => ({ ok: true, summary: 'implemented' }),
        reviewDiff: async () => ({ verdict: 'warn', mustFix: [], shouldFix: ['human follow-up'], summary: 'reviewed', reviewed: true, diffTruncated: false, diffShownChars: 100, diffTotalChars: 100, diffOmittedFiles: 0 }),
        openPr: defaultSeams({ prManager: manager }).openPr,
      }) }),
    },
  });
} }));
`);
      const path = join(dir, 'si.out');
      const command = `${process.execPath} --preload ${preload} bin/elanous.mjs --test=${join(dir, 'state')} self implement 'overlap' --json --open-pr > ${path} 2>&1; rc=$?; ${POD_RESULT_FLATTEN.replace('/tmp/si.out', path)}; exit $rc`;
      const { ELANOUS_CONFIG_DIR: _ignoredConfigDir, ...isolatedEnv } = process.env;
      const emitted = spawnSync('bash', ['-c', command], { cwd: root, env: { ...isolatedEnv, NODE_ENV: 'test', ELANOUS_HARNESS_ENTRANCE: 'self-implement' }, encoding: 'utf8', timeout: 45_000 });
      expect(emitted.error).toBeUndefined();
      expect(emitted.status).toBe(1);
      const cliOutput = readFileSync(path, 'utf8');
      expect(cliOutput).toContain('self-implement PR guard 실패: hunk-overlap');
      const row = JSON.parse(readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)!);
      expect(row).toMatchObject({ stage: 'error', ok: false, error: expect.stringContaining('self-implement PR guard 실패: hunk-overlap') });
      const { k } = fakeKubectl(['Failed'], readFileSync(path, 'utf8'));
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'pr-guard-fallback' }).done;
      expect(result.error?.message).toContain('childStage=error · childError=draft PR 생성 실패');
      expect(result.error?.message).toContain('self-implement PR guard 실패: hunk-overlap');
      expect(result.error?.message).not.toContain('childError=no-result-line');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('fallback terminal keeps the complete newest diagnostic before host display bounding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-terminal-long-reason-'));
    try {
      const path = join(dir, 'si.out');
      const reason = `self-implement PR guard 실패: hunk-overlap ${'x'.repeat(900)}`;
      const detail = `${reason}\n- src/a.ts and src/b.ts overlap\nError: generic stack summary`;
      writeFileSync(path, `골 완료 경계 누락: stale prior attempt\n${detail}\n`);
      const emitted = Bun.spawnSync(['bash', '-c', `rc=1; ${POD_RESULT_FLATTEN.replace('/tmp/si.out', path)}`]);
      expect(emitted.exitCode).toBe(0);
      const row = JSON.parse(readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)!);
      expect(row).toEqual({ stage: 'error', ok: false, error: detail });
      const { k } = fakeKubectl(['Failed'], readFileSync(path, 'utf8'));
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'long-pr-guard-fallback' }).done;
      expect(result.error?.message).toContain('childStage=error · childError=self-implement PR guard 실패: hunk-overlap');
      expect(result.error?.message).not.toContain('골 완료 경계 누락');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('already flat terminal JSON remains a single result line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-terminal-flat-'));
    try {
      const path = join(dir, 'si.out');
      const line = JSON.stringify({ stage: 'error', ok: false, error: 'actual child error' });
      writeFileSync(path, `${line}\n`);
      const emitted = Bun.spawnSync(['bash', '-c', `rc=1; ${POD_RESULT_FLATTEN.replace('/tmp/si.out', path)}`]);
      expect(emitted.exitCode).toBe(0);
      expect(readFileSync(path, 'utf8')).toBe(`${line}\n`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('failed child exit after a success result emits a failure terminal', async () => {
    for (const line of [
      JSON.stringify({ stage: 'merged', ok: true }),
      JSON.stringify({ kind: 'self', ok: true, result: { stage: 'merged' } }),
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'pod-terminal-success-before-error-'));
      try {
        const path = join(dir, 'si.out');
        writeFileSync(path, `${JSON.stringify({ stage: 'error', ok: false, error: 'prior attempt' })}\n${line}\nunclassified failure\n`);
        const emitted = Bun.spawnSync(['bash', '-c', `rc=1; ${POD_RESULT_FLATTEN.replace('/tmp/si.out', path)}`]);
        expect(emitted.exitCode).toBe(0);
        const row = JSON.parse(readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)!);
        expect(row).toEqual({ stage: 'error', ok: false, error: 'child exited rc=1 after a success result without a terminal failure result' });
        const { k } = fakeKubectl(['Failed'], readFileSync(path, 'utf8'));
        const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'success-before-error' }).done;
        expect(result.error?.message).toContain('childStage=error · childError=child exited rc=1');
        expect(result.error?.message).not.toContain('prior attempt');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  test('interim JSON cannot mask a later preflight failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-terminal-interim-'));
    try {
      const path = join(dir, 'si.out');
      const reason = '골 완료 경계 누락: TA 카드 ta-1';
      writeFileSync(path, `${JSON.stringify({ stage: 'running', ok: true })}\n${reason}\n`);
      const emitted = Bun.spawnSync(['bash', '-c', `rc=1; ${POD_RESULT_FLATTEN.replace('/tmp/si.out', path)}`]);
      expect(emitted.exitCode).toBe(0);
      const row = JSON.parse(readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)!);
      expect(row).toEqual({ stage: 'preflight-blocked', ok: false, error: reason });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('nested interim self JSON cannot mask a later preflight failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-terminal-nested-interim-'));
    try {
      const path = join(dir, 'si.out');
      const reason = '골 완료 경계 누락: TA 카드 ta-1';
      writeFileSync(path, `${JSON.stringify({ kind: 'self', ok: false, result: { stage: 'running', error: 'interim' } })}\n${reason}\n`);
      const emitted = Bun.spawnSync(['bash', '-c', `rc=1; ${POD_RESULT_FLATTEN.replace('/tmp/si.out', path)}`]);
      expect(emitted.exitCode).toBe(0);
      const row = JSON.parse(readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)!);
      expect(row).toEqual({ stage: 'preflight-blocked', ok: false, error: reason });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('generic cleanup error after a goal-boundary rejection keeps the boundary stage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-terminal-cleanup-after-boundary-'));
    try {
      const path = join(dir, 'si.out');
      writeFileSync(path, '골 완료 경계 누락: TA 카드 ta-1\n❌ cleanup failed\n');
      const emitted = Bun.spawnSync(['bash', '-c', `rc=1; ${POD_RESULT_FLATTEN.replace('/tmp/si.out', path)}`]);
      expect(emitted.exitCode).toBe(0);
      const row = JSON.parse(readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)!);
      expect(row).toEqual({ stage: 'preflight-blocked', ok: false, error: '골 완료 경계 누락: TA 카드 ta-1\n❌ cleanup failed' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a structured child failure stays authoritative over a later matching log line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-terminal-structured-first-'));
    try {
      const path = join(dir, 'si.out');
      const child = { stage: 'error', ok: false, error: 'child result reason' };
      writeFileSync(path, `${JSON.stringify(child)}\n❌ 골 완료 경계 누락: graph cleanup text\n`);
      const emitted = Bun.spawnSync(['bash', '-c', `rc=1; ${POD_RESULT_FLATTEN.replace('/tmp/si.out', path)}`]);
      expect(emitted.exitCode).toBe(0);
      const row = JSON.parse(readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)!);
      expect(row).toEqual(child);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('nested self results retain child-defined terminal stages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-terminal-self-stage-'));
    try {
      const path = join(dir, 'si.out');
      writeFileSync(path, `${JSON.stringify({ kind: 'self', ok: false, result: { stage: 'custom-terminal', error: 'child result' } })}\n[graph] after result\n`);
      const emitted = Bun.spawnSync(['bash', '-c', `rc=1; ${POD_RESULT_FLATTEN.replace('/tmp/si.out', path)}`]);
      expect(emitted.exitCode).toBe(0);
      const row = JSON.parse(readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)!);
      expect(row).toEqual({ stage: 'custom-terminal', error: 'child result', ok: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a later separate failure supersedes a stale preflight line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-terminal-new-failure-'));
    try {
      const path = join(dir, 'si.out');
      writeFileSync(path, '골 완료 경계 누락: stale prior attempt\n[retry] a new attempt started\nError: current child failure\n');
      const emitted = Bun.spawnSync(['bash', '-c', `rc=1; ${POD_RESULT_FLATTEN.replace('/tmp/si.out', path)}`]);
      expect(emitted.exitCode).toBe(0);
      const row = JSON.parse(readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)!);
      expect(row).toEqual({ stage: 'error', ok: false, error: 'Error: current child failure' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('flat child result followed by stderr stays authoritative at the Pod host', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-terminal-flat-stderr-'));
    try {
      const path = join(dir, 'si.out');
      const line = JSON.stringify({ stage: 'error', ok: false, error: 'actual child failure' });
      writeFileSync(path, `${line}\n${JSON.stringify({ kind: 'graph', stage: 'merged', ok: true })}\nError: trailing graph report\n`);
      const emitted = Bun.spawnSync(['bash', '-c', `rc=1; ${POD_RESULT_FLATTEN.replace('/tmp/si.out', path)}`]);
      expect(emitted.exitCode).toBe(0);
      expect(readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)).toBe(line);
      const { k } = fakeKubectl(['Failed'], readFileSync(path, 'utf8'));
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'flat-stderr-fallback' }).done;
      expect(result.error?.message).toContain('childStage=error · childError=actual child failure');
      expect(result.error?.message).not.toContain('trailing graph report');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('flat child failure with an unregistered stage survives trailing stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-terminal-custom-stage-'));
    try {
      const path = join(dir, 'si.out');
      const line = JSON.stringify({ stage: 'custom-terminal', ok: false, error: 'child-defined failure' });
      writeFileSync(path, `${line}\nError: trailing graph report\n`);
      const emitted = Bun.spawnSync(['bash', '-c', `rc=1; ${POD_RESULT_FLATTEN.replace('/tmp/si.out', path)}`]);
      expect(emitted.exitCode).toBe(0);
      expect(readFileSync(path, 'utf8').trimEnd().split('\n').at(-1)).toBe(line);
      const { k } = fakeKubectl(['Failed'], readFileSync(path, 'utf8'));
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'custom-stage-fallback' }).done;
      expect(result.error?.message).toContain('childStage=custom-terminal · childError=child-defined failure');
      expect(result.error?.message).not.toContain('childError=no-result-line');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a failed Job without a result line records no-result-line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-no-result-line-'));
    const path = join(dir, 'si.out');
    writeFileSync(path, 'no result here\n');
    const emitted = Bun.spawnSync(['bash', '-c', `rc=1; ${POD_RESULT_FLATTEN.replace('/tmp/si.out', path)}`]);
    expect(emitted.exitCode).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('no result here\n');
    const { k } = fakeKubectl(['Failed'], readFileSync(path, 'utf8'));
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-missing-result-line', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    try {
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'missing-result-line' }).done;
      expect(result.error?.message).toContain('childError=no-result-line');
      expect(finished[0]).toMatchObject({ state: 'failed', childError: 'no-result-line' });
      expect(finished[0]).not.toHaveProperty('childStage');
    } finally { off(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('a known child ledger stage also preserves the failed Pod log tail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-no-result-known-stage-'));
    let tailReads = 0;
    const base = fakeKubectl(['Failed'], 'no result here\n', 1);
    const k: Kubectl = (args, input) => {
      if (args.includes('apply') && input) {
        const object = JSON.parse(input) as { kind?: string; spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name: string; value?: string }> }> } } } };
        if (object.kind === 'Job') {
          const runId = object.spec?.template?.spec?.containers?.[0]?.env?.find((item) => item.name === 'ELANOUS_RUN_ID')?.value;
          if (runId) appendRunLedgerEntry({ runId, event: 'gate', data: { round: 1 } }, runLedgerDir(root));
        }
      }
      if (args.includes('logs') && args.includes(`--tail=${POD_NO_RESULT_LOG_TAIL_LINES}`)) {
        tailReads++;
        return { status: 0, stdout: 'known-stage final stderr\n', stderr: '' };
      }
      return base.k(args, input);
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS,
        env: { ELANOUS_RUN_ID: 'run-parent-known-stage', ELANOUS_STATE_DIR: root } })({ feature: 'known child stage', spaceId: 'known-child-stage' }).done;
      expect(result.exitCode).toBe(1);
      expect(result.error?.message).toContain('last ledger stage=gate');
      expect(tailReads).toBe(1);
      const evidence = loadRunLedger('run-parent-known-stage', runLedgerDir(root))?.find((entry) => entry.event === 'pod-child-evidence')?.data;
      expect(evidence?.childEvidence).toMatchObject({ podLogTail: ['known-stage final stderr'], podLogTailLines: 1 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a Complete Job with a known stage writes a null marker after an earlier attempt tail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-complete-known-stage-evidence-'));
    const parent = 'run-parent-complete-known-stage-evidence';
    let tailReads = 0;
    const first = fakeKubectl(['Failed'], 'first attempt failed without terminal JSON\n');
    const secondBase = fakeKubectl(['Complete'], 'no result here\n', 0);
    const second: Kubectl = (args, input) => {
      if (args.includes('apply') && input) {
        const object = JSON.parse(input) as { kind?: string; spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name: string; value?: string }> }> } } } };
        if (object.kind === 'Job') {
          const runId = object.spec?.template?.spec?.containers?.[0]?.env?.find((item) => item.name === 'ELANOUS_RUN_ID')?.value;
          if (runId) appendRunLedgerEntry({ runId, event: 'gate', data: { round: 1 } }, runLedgerDir(root));
        }
      }
      if (args.includes('logs') && args.includes(`--tail=${POD_NO_RESULT_LOG_TAIL_LINES}`)) tailReads++;
      return secondBase.k(args, input);
    };
    try {
      await podSelfImplementSpawn({ kubectl: first.k, credentials: CREDS,
        env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root } })({ feature: 'first resultless failure', spaceId: 'known-stage-first' }).done;
      const completed = await podSelfImplementSpawn({ kubectl: second, credentials: CREDS,
        env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root } })({ feature: 'Complete without result', spaceId: 'known-stage-complete' }).done;
      const markers = loadRunLedger(parent, runLedgerDir(root))?.filter((entry) => entry.event === 'pod-child-evidence') ?? [];
      expect(completed.exitCode).toBe(0);
      expect(tailReads).toBe(0);
      expect(markers).toHaveLength(2);
      expect(markers[0]?.data.childEvidence).toMatchObject({ logTail: ['first attempt failed without terminal JSON'] });
      expect(markers[1]?.data.childEvidence).toBeNull();
      expect(markers[1]?.data.childRunId).not.toBe(markers[0]?.data.childRunId);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the Pod log tail is capped at 80 lines and masked line by line', () => {
    const source = [...Array.from({ length: 100 }, (_, i) => `stage line ${i}`),
      'child exploded: authentication failed for sk-proj-ABCDEFGHIJKLMNOP1234'].join('\n') + '\n';
    const tail = podNoResultLogTailLines(source);
    expect(tail).toHaveLength(POD_NO_RESULT_LOG_TAIL_LINES);
    expect(POD_NO_RESULT_LOG_TAIL_LINES).toBe(80);
    expect(tail[0]).toBe('stage line 21');
    expect(tail.at(-1)).toBe('child exploded: authentication failed for sk-proj-***');
    expect(tail.join('\n')).not.toContain('sk-proj-ABCDEFGHIJKLMNOP1234');
    expect(podNoResultLogTailLines('  original   spacing  sk-proj-ABCDEFGHIJKLMNOP1234  \n'))
      .toEqual(['  original   spacing  sk-proj-***  ']);
  });

  test('Pod log evidence bounds long lines and masks failed kubectl output and thrown errors', async () => {
    const secret = 'sk-proj-ABCDEFGHIJKLMNOP1234';
    const longTail = podNoResultLogTailLines(`${secret} ${'x'.repeat(20_000)}\n`);
    expect(longTail).toHaveLength(1);
    expect(longTail[0]!.length).toBeLessThanOrEqual(512 + '[truncated]'.length + 1);
    expect(longTail.join('')).not.toContain(secret);

    const failed = readPodNoResultLogTail({
      run: () => ({ status: 1, stdout: '', stderr: `${secret} ${'e'.repeat(20_000)}` }), namespace: 'n', job: 'j',
    });
    expect('unavailable' in failed).toBe(true);
    if ('unavailable' in failed) {
      expect(failed.unavailable.length).toBeLessThanOrEqual(512 + '[truncated]'.length + 1);
      expect(failed.unavailable).not.toContain(secret);
    }
    const thrown = readPodNoResultLogTail({
      run: () => { throw new Error(`${secret} ${'e'.repeat(20_000)}`); }, namespace: 'n', job: 'j',
    });
    expect('unavailable' in thrown).toBe(true);
    if ('unavailable' in thrown) {
      expect(thrown.unavailable.length).toBeLessThanOrEqual(512 + '[truncated]'.length + 1);
      expect(thrown.unavailable).not.toContain(secret);
    }
  });

  test('a host exit-1 fixture with kubectl stubs keeps masked logs in parent childEvidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-no-result-log-tail-'));
    const parent = 'run-parent-no-result-log-tail';
    const previousState = process.env.ELANOUS_STATE_DIR;
    const diagnostics: Array<Record<string, unknown>> = [];
    const fixtureJob = spawnSync('bash', ['-c', "printf 'stage line %s\\n' {0..99}; printf '%s\\n' '  child exploded: authentication failed for sk-proj-ABCDEFGHIJKLMNOP1234  '; exit 1"], { encoding: 'utf8' });
    expect(fixtureJob.status).toBe(1);
    expect(fixtureJob.stdout).not.toContain('{0..99}');
    const fixtureTail = fixtureJob.stdout;
    const base = fakeKubectl(['Failed'], 'no result here\n', 1);
    let tailArgs = '';
    const callOrder: string[] = [];
    const k: Kubectl = (args, input) => {
      if (args.includes('logs') && args.includes('--tail=80')) {
        tailArgs = args.join(' ');
        callOrder.push('log-tail');
        return { status: 0, stdout: fixtureTail, stderr: '' };
      }
      return base.k(args, input);
    };
    const off = debug.registerSink({ name: 'pod-no-result-log-tail', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'no-result-log-tail') diagnostics.push(record.data as Record<string, unknown>);
    } });
    try {
      process.env.ELANOUS_STATE_DIR = root;
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS,
        env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'no-result-log-tail' }).done;
      expect(result.exitCode).toBe(1);
      expect(result.error?.message).toContain('childError=no-result-line');
      expect(result.error?.message).not.toContain('sk-proj-ABCDEFGHIJKLMNOP1234');
      expect(tailArgs).toContain('--tail=80');
      expect(tailArgs).toContain('-c child');
      expect(callOrder.indexOf('log-tail')).toBeGreaterThanOrEqual(0);
      // A terminal failed Job is retained for inspection; this path has no Job deletion to order.
      expect(callOrder).toEqual(['log-tail']);
      const evidence = loadRunLedger(parent, runLedgerDir(root))?.find((entry) => entry.event === 'pod-child-evidence')?.data as {
        childEvidence?: { stderr?: string; logTail?: string[] } } | undefined;
      const childEvidence = evidence?.childEvidence;
      expect(childEvidence?.logTail).toHaveLength(POD_NO_RESULT_LOG_TAIL_LINES);
      expect(childEvidence?.logTail?.[0]).toBe('stage line 21');
      expect(childEvidence?.logTail?.at(-1)).toBe('  child exploded: authentication failed for sk-proj-***  ');
      expect(childEvidence?.stderr).toContain('  child exploded: authentication failed for sk-proj-***  ');
      expect(JSON.stringify(evidence)).not.toContain('sk-proj-ABCDEFGHIJKLMNOP1234');
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ job: expect.stringContaining('si-'), lines: 80,
        logTail: expect.arrayContaining(['  child exploded: authentication failed for sk-proj-***  ']) });
      expect(JSON.stringify(diagnostics)).not.toContain('sk-proj-ABCDEFGHIJKLMNOP1234');
    } finally {
      off();
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed Pod with a known child stage preserves termination facts and trailing logs before collection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-known-stage-failure-evidence-'));
    const parent = 'run-parent-known-stage-failure-evidence';
    const previousState = process.env.ELANOUS_STATE_DIR;
    const terminalOutput = `${JSON.stringify({ ok: false, stage: 'aborted', error: 'rework stopped', childEvidence: { detail: 'known-stage evidence' } })}\n`;
    const stderr = 'useful failure detail sk-proj-ABCDEFGHIJKLMNOP1234';
    const base = fakeKubectl(['Failed'], terminalOutput, 2);
    const calls: string[] = [];
    const k: Kubectl = (args, input) => {
      calls.push(args.join(' '));
      if (args.includes('logs') && args.includes('--tail=80')) return { status: 0, stdout: `${terminalOutput}${stderr}\n`, stderr: '' };
      return base.k(args, input);
    };
    try {
      process.env.ELANOUS_STATE_DIR = root;
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS,
        env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root } })({ feature: 'known stage failure', spaceId: 'known-stage-failure-evidence' }).done;
      expect(result.exitCode).toBe(1);
      expect(calls.some((call) => call.includes('logs') && call.includes('--tail=80'))).toBe(true);
      const evidence = loadRunLedger(parent, runLedgerDir(root))?.find((entry) => entry.event === 'pod-child-evidence')?.data as {
        childEvidence?: { error?: string; podLogTail?: string[]; podLogTailLines?: number } } | undefined;
      expect(evidence?.childEvidence).toMatchObject({
        error: 'rework stopped', podLogTailLines: 2,
        podLogTail: expect.arrayContaining([expect.stringContaining('useful failure detail sk-proj-***')]),
      });
      expect(JSON.stringify(evidence)).not.toContain('sk-proj-ABCDEFGHIJKLMNOP1234');
    } finally {
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a Complete Job without a result line preserves its exit code and records unknown-stage logs in parent childEvidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-complete-no-result-log-tail-'));
    const parent = 'run-parent-complete-no-result-log-tail';
    const previousCwd = process.cwd();
    const goalFile = 'GOAL.md';
    const previousState = process.env.ELANOUS_STATE_DIR;
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, goalFile), '# goal\n');
    const fixtureTail = [...Array.from({ length: 100 }, (_, i) => `fixture complete stage ${i}`),
      'child completed without a result line for sk-proj-ABCDEFGHIJKLMNOP1234'].join('\n') + '\n';
    const base = fakeKubectl(['Complete'], 'no result here\n', 0);
    const diagnostics: Array<Record<string, unknown>> = [];
    const finished: Array<Record<string, unknown>> = [];
    const k: Kubectl = (args, input) => args.includes('logs') && args.includes('--tail=80')
      ? { status: 0, stdout: fixtureTail, stderr: '' }
      : base.k(args, input);
    const off = debug.registerSink({ name: 'pod-complete-no-result-log-tail', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'no-result-log-tail') diagnostics.push(record.data as Record<string, unknown>);
      if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    try {
      process.chdir(root);
      process.env.ELANOUS_STATE_DIR = root;
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS,
        env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root, ELANOUS_POD_GOAL_DOC: goalFile } })({ feature: 'complete without result', spaceId: 'complete-no-result' }).done;
      const evidence = loadRunLedger(parent, runLedgerDir(root))?.find((entry) => entry.event === 'pod-child-evidence')?.data as {
        childEvidence?: { stderr?: string; logTail?: string[] } } | undefined;
      expect(result.exitCode).toBe(0);
      expect(result.error).toBeUndefined();
      expect(finished[0]).not.toHaveProperty('childError');
      expect(readFileSync(join(root, goalFile), 'utf8')).toContain('  outcome: pod-no-result\n  ok: false');
      expect(evidence?.childEvidence?.logTail).toHaveLength(POD_NO_RESULT_LOG_TAIL_LINES);
      expect(evidence?.childEvidence?.stderr).toContain('sk-proj-***');
      expect(JSON.stringify(evidence)).not.toContain('sk-proj-ABCDEFGHIJKLMNOP1234');
      expect(diagnostics).toHaveLength(1);
    } finally {
      off();
      process.chdir(previousCwd);
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unreadable Pod log leaves «log-unavailable» as the childEvidence stanza', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-no-result-log-unavailable-'));
    const parent = 'run-parent-no-result-log-unavailable';
    const previousState = process.env.ELANOUS_STATE_DIR;
    const base = fakeKubectl(['Failed'], 'no result here\n', 1);
    const secret = 'sk-proj-ABCDEFGHIJKLMNOP1234';
    const failure = `Error from server (NotFound): pods "si-x" not found; token ${secret}`;
    const diagnostics: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-no-result-log-unavailable', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'no-result-log-tail') diagnostics.push(record.data as Record<string, unknown>);
    } });
    const k: Kubectl = (args, input) => {
      if (args.includes('logs') && args.includes('--tail=80')) {
        return { status: 1, stdout: '', stderr: failure };
      }
      return base.k(args, input);
    };
    try {
      process.env.ELANOUS_STATE_DIR = root;
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS,
        env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'no-result-log-unavailable' }).done;
      expect(result.exitCode).toBe(1);
      const evidence = loadRunLedger(parent, runLedgerDir(root))?.find((entry) => entry.event === 'pod-child-evidence')?.data as {
        childEvidence?: { stderr?: string } } | undefined;
      const unavailable = 'log-unavailable: Error from server (NotFound): pods "si-x" not found; token sk-proj-***';
      expect(evidence?.childEvidence?.stderr).toBe(unavailable);
      expect(diagnostics).toEqual([expect.objectContaining({ logUnavailable: unavailable })]);
      expect(JSON.stringify(evidence) + JSON.stringify(diagnostics)).not.toContain(secret);
    } finally {
      off();
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed Job with an unavailable container exit code still collects no-result logs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-no-result-unknown-exit-'));
    const parent = 'run-parent-no-result-unknown-exit';
    const previousState = process.env.ELANOUS_STATE_DIR;
    const base = fakeKubectl(['Failed'], 'no result here\n');
    const k: Kubectl = (args, input) => args.includes('logs') && args.includes('--tail=80')
      ? { status: 0, stdout: 'child failed without a result row\n', stderr: '' }
      : base.k(args, input);
    try {
      process.env.ELANOUS_STATE_DIR = root;
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS,
        env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'no-result-unknown-exit' }).done;
      const evidence = loadRunLedger(parent, runLedgerDir(root))?.find((entry) => entry.event === 'pod-child-evidence')?.data as {
        childEvidence?: { logTail?: string[]; stderr?: string } } | undefined;
      expect(result.exitCode).toBe(1);
      expect(result.error?.message).toContain('childError=no-result-line');
      expect(evidence?.childEvidence?.logTail).toEqual(['child failed without a result row']);
      expect(evidence?.childEvidence?.stderr).toContain('child failed without a result row');
    } finally {
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed Job is a non-zero exit with a named error', async () => {
    const { k } = fakeKubectl(['Failed'], 'boom');
    const r = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS })({ feature: 'x', spaceId: 's' }).done;
    expect(r.exitCode).toBe(1);
    expect(r.error?.code).toBe('pod-job-failed');
  });
  test('failed child binds its open draft by exact head branch before pr-terminal', async () => {
    const branch = 'self-impl/scope-branch-fixture';
    const prUrl = 'https://github.com/ElanvitalAI/elanous/pull/29999';
    const root = mkdtempSync(join(tmpdir(), 'pod-pr-branch-gh-'));
    const parentRunId = 'run-pr-branch-gh-fixture';
    const shim = join(root, 'gh');
    const capture = join(root, 'gh-args.txt');
    writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(capture)}\nprintf '%s\\n' '${JSON.stringify([{ number: 29999, url: prUrl, headRefName: branch, isCrossRepository: false }])}'\n`);
    chmodSync(shim, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${root}:${oldPath ?? ''}`;
    const { k } = fakeKubectl(['Failed'], `${JSON.stringify({ stage: 'gate-failed', ok: false, branch })}\n`);
    const observed: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-pr-branch-lookup', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'pr-terminal-bound-by-branch') observed.push(record.data as Record<string, unknown>);
    } });
    try {
      await realPodSelfImplementSpawn({ kubectl: k, credentials: CREDS,
        env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: parentRunId }, budgetSnapshot: () => undefined,
        fallbackConfig: () => ({ llm: {} }) as UserConfig, openGatewayConfig: () => ({ llm: {} }) as UserConfig,
      })({ feature: 'failed child with draft', spaceId: 'pr-branch-fixture' }).done;
      expect(readFileSync(capture, 'utf8').trim().split('\n')).toEqual([expect.stringContaining(
        'pr list --repo ElanvitalAI/elanous --state open --head ' + branch)]);
      const terminalRecords = (loadRunLedger(parentRunId, runLedgerDir(root)) ?? []).filter((entry) => entry.event === 'pr-terminal').map((entry) => entry.data);
      expect(terminalRecords).toEqual([expect.objectContaining({ branch, prNumber: 29999, prUrl,
        prNumberSource: 'branch-lookup', terminalClass: 'failed-with-pr' })]);
      expect(observed).toEqual([expect.objectContaining({ branch, prNumber: 29999, prUrl, status: 'found' })]);
      writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(capture)}\nprintf '%s\\n' '${JSON.stringify([{ number: 29999, url: prUrl, headRefName: branch, isCrossRepository: true }])}'\n`);
      const crossRunId = 'run-pr-branch-cross-repository';
      await realPodSelfImplementSpawn({ kubectl: k, credentials: CREDS,
        env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: crossRunId }, budgetSnapshot: () => undefined,
        fallbackConfig: () => ({ llm: {} }) as UserConfig, openGatewayConfig: () => ({ llm: {} }) as UserConfig,
      })({ feature: 'failed child with fork draft', spaceId: 'pr-branch-cross-fixture' }).done;
      expect((loadRunLedger(crossRunId, runLedgerDir(root)) ?? []).find((entry) => entry.event === 'pr-terminal')?.data)
        .toMatchObject({ branch, prNumber: null, prLookup: { status: 'not-found', reason: 'cross-repository-only' } });
      const cappedRows = [{ number: 29999, url: prUrl, headRefName: branch, isCrossRepository: false },
        ...Array.from({ length: 99 }, (_, index) => ({ number: index + 1,
          url: `https://github.com/ElanvitalAI/elanous/pull/${index + 1}`, headRefName: branch, isCrossRepository: true }))];
      writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(cappedRows)}'\n`);
      const cappedRunId = 'run-pr-branch-capped';
      await realPodSelfImplementSpawn({ kubectl: k, credentials: CREDS,
        env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: cappedRunId }, budgetSnapshot: () => undefined,
        fallbackConfig: () => ({ llm: {} }) as UserConfig, openGatewayConfig: () => ({ llm: {} }) as UserConfig,
      })({ feature: 'failed child with capped branch results', spaceId: 'pr-branch-capped-fixture' }).done;
      expect((loadRunLedger(cappedRunId, runLedgerDir(root)) ?? []).find((entry) => entry.event === 'pr-terminal')?.data)
        .toMatchObject({ branch, prNumber: null, prLookup: { status: 'failed', reason: 'gh-result-limit-reached' } });
    } finally {
      off();
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('missing or failed branch lookup keeps pr-terminal unbound with the reason', async () => {
    for (const lookup of [
      { status: 'not-found' as const, reason: 'no-open-pr-for-branch' },
      { status: 'failed' as const, reason: 'gh-list-rc-1' },
    ]) {
      const branch = `self-impl/${lookup.status}-fixture`;
      const { k } = fakeKubectl(['Failed'], `${JSON.stringify({ stage: 'aborted', ok: false, branch })}\n`);
      const terminalRecords: Array<Record<string, unknown>> = [];
      let called = 0;
      await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {},
        lookupOpenPrByBranch: () => { called++; return lookup; },
        draftResidue: (record) => { terminalRecords.push(record as unknown as Record<string, unknown>); },
      })({ feature: 'failed child without matched draft', spaceId: `${lookup.status}-fixture` }).done;
      expect(called).toBe(1);
      expect(terminalRecords).toEqual([expect.objectContaining({ branch, prNumber: null,
        terminalClass: 'failed-no-pr', prLookup: lookup })]);
    }
  });
  test('a branch lookup that throws keeps pr-terminal unbound and records the thrown reason', async () => {
    const branch = 'self-impl/failed-throw-fixture';
    const { k } = fakeKubectl(['Failed'], `${JSON.stringify({ stage: 'aborted', ok: false, branch })}\n`);
    const terminalRecords: Array<Record<string, unknown>> = [];
    const observed: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-pr-branch-throw', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'pr-terminal-branch-lookup') observed.push(record.data as Record<string, unknown>);
    } });
    let called = 0;
    try {
      await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {},
        lookupOpenPrByBranch: () => { called++; throw new Error('gh exploded'); },
        draftResidue: (record) => { terminalRecords.push(record as unknown as Record<string, unknown>); },
      })({ feature: 'failed child with throwing lookup', spaceId: 'failed-throw-fixture' }).done;
      expect(called).toBe(1);
      expect(terminalRecords).toEqual([expect.objectContaining({ branch, prNumber: null,
        terminalClass: 'failed-no-pr', prLookup: { status: 'failed', reason: 'pr-lookup-failed: gh exploded' } })]);
      expect(observed).toEqual([expect.objectContaining({ branch, status: 'failed', reason: 'pr-lookup-failed: gh exploded' })]);
    } finally { off(); }
  });
  test('successful child with a branch does not look up or bind an unrelated open PR', async () => {
    const branch = 'self-impl/success-branch-fixture';
    const { k } = fakeKubectl(['Complete'], `${JSON.stringify({ stage: 'merge-ready', ok: true, branch })}\n`);
    const terminalRecords: Array<Record<string, unknown>> = [];
    let called = 0;
    await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {},
      lookupOpenPrByBranch: () => { called++; return { status: 'found', prNumber: 29999,
        prUrl: 'https://github.com/ElanvitalAI/elanous/pull/29999' }; },
      draftResidue: (record) => { terminalRecords.push(record as unknown as Record<string, unknown>); },
    })({ feature: 'successful child with branch', spaceId: 'pr-branch-success-fixture' }).done;
    expect(called).toBe(0);
    expect(terminalRecords).toEqual([expect.objectContaining({ branch, prNumber: null,
      terminalClass: 'failed-no-pr' })]);
  });
  test('aborted child harvest PR is recorded before the parent Pod failure result is returned', async () => {
    const prUrl = 'https://github.com/o/r/pull/29601';
    const branch = 'salvage/si-goal-29601';
    const child = JSON.stringify({
      stage: 'aborted', ok: false, harvestable: true, branch, prUrl, prNumber: 29601,
    });
    const { k } = fakeKubectl(['Failed'], `${child}\n`);
    const terminalRecords: Array<Record<string, unknown>> = [];

    const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {},
      draftResidue: (record) => { terminalRecords.push(record as unknown as Record<string, unknown>); },
    })({ feature: 'aborted implementation with harvestable PR', spaceId: 'aborted-harvest-pr' }).done;

    expect(terminalRecords).toEqual([expect.objectContaining({
      terminalClass: 'failed-with-pr', stage: 'aborted', branch, prUrl, prNumber: 29601,
    })]);
    expect(result).toMatchObject({
      exitCode: 1,
      error: { code: 'pod-job-failed' },
      disposition: { stage: 'aborted', harvestable: true, branch, prUrl, prNumber: 29601 },
    });
  });
  test('DeadlineExceeded 는 자식 quota-exhausted 를 덮고 pod-deadline-exceeded · run-deadline-exceeded 로 남긴다', async () => {
    const child = JSON.stringify({ stage: 'aborted', ok: false, abandonedClassification: { classification: 'quota-exhausted' }, prUrl: 'https://github.com/o/r/pull/3', branch: 'si/deadline' });
    const calls: string[] = [];
    const records: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'pod-deadline-exceeded', emit: (record) => { records.push({ category: record.category, event: record.event, data: record.data as Record<string, unknown> }); } });
    const k: Kubectl = (args) => {
      calls.push(args.join(' '));
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.some((a) => a.includes('conditions[?(@.type=="FailureTarget")].reason'))) return { status: 0, stdout: '|DeadlineExceeded\t10800\tjob-uid\t2026-09-27T03:40:00Z\t2026-09-27T06:40:00Z', stderr: '' };
      if (args.includes('get') && args.includes('pods')) return { status: 0, stdout: '2026-09-27T06:40:00Z\tOOMKilled\t137\n', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'FailureTarget\t10800\tjob-uid\t2026-09-27T03:40:00Z\t2026-09-27T06:40:00Z', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: `${child}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const r = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS, deadlineSeconds: 10_800, now: () => Date.parse('2026-09-27T06:40:01Z') })({ feature: 'x', spaceId: 'deadline' }).done;
      expect(calls.some((c) => c.includes('conditions[?(@.type=="FailureTarget")].reason'))).toBe(true);
      expect(calls.some((c) => c.includes('get pods'))).toBe(true);
      expect(r.error).toEqual({ code: 'pod-deadline-exceeded', message: `Job ${podJobName('deadline')} 이 수명 상한 10800초에 닿았다` });
      expect(r.disposition?.failureClassification).toBe('run-deadline-exceeded');
      const logged = records.find((record) => record.category === 'self-implement.pod' && record.event === 'deadline-exceeded');
      expect(logged?.data).toMatchObject({ job: podJobName('deadline'), deadlineSeconds: 10_800, childClassification: 'quota-exhausted', prUrl: 'https://github.com/o/r/pull/3', branch: 'si/deadline' });
      expect(records.find((record) => record.category === 'pod.job' && record.event === 'finished')?.data).toMatchObject({
        jobCreatedAt: '2026-09-27T03:40:00Z', finishedAt: '2026-09-27T06:40:00Z', elapsedMs: 10_800_000,
        finishedAtSource: 'job-completion', deadlineSec: 10_800, tier: expect.any(String), lastStage: 'aborted',
      });
      expect(records.find((record) => record.category === 'self-implement.pod' && record.event === 'job-finished')?.data).not.toHaveProperty('childError');
      expect(records.some((record) => record.category === 'self-implement.pod' && record.event === 'child-error')).toBe(false);
    } finally { off(); }
  });

  test('DeadlineExceeded elapsed timing labels its finish source and leaves elapsed unknown without Job creation time', () => {
    expect(podJobFinishedTiming({ jobCreatedAt: '2026-09-27T03:40:00Z', jobCompletedAt: '2026-09-27T06:40:00Z',
      podFinishedAt: '2026-09-27T06:39:59Z', observedAt: '2026-09-27T06:41:00Z' })).toEqual({
      finishedAt: '2026-09-27T06:40:00Z', finishedAtSource: 'job-completion', elapsedMs: 10_800_000,
    });
    expect(podJobFinishedTiming({ jobCreatedAt: '2026-09-27T03:40:00Z', jobCompletedAt: null,
      podFinishedAt: '2026-09-27T06:39:59Z', observedAt: '2026-09-27T06:41:00Z' })).toEqual({
      finishedAt: '2026-09-27T06:39:59Z', finishedAtSource: 'pod-termination', elapsedMs: 10_799_000,
    });
    expect(podJobFinishedTiming({ jobCreatedAt: null, jobCompletedAt: null,
      podFinishedAt: null, observedAt: '2026-09-27T06:41:00Z' })).toEqual({
      finishedAt: '2026-09-27T06:41:00Z', finishedAtSource: 'observed-at', elapsedMs: null,
    });
  });
  test('predeadline marker supplies a terminal deadline result when the child JSON is missing', async () => {
    const job = podJobName('deadline-marker-test');
    let childRunId = '';
    const k: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
      if (args.includes('apply') && input) {
        const manifest = JSON.parse(input);
        if (manifest.kind === 'Job') childRunId = manifest.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.some((a) => a.includes('conditions[?(@.type=="FailureTarget")].reason'))) return { status: 0, stdout: 'BackoffLimitExceeded|', stderr: '' };
      if (args.includes('get') && args.includes('pods')) return { status: 0, stdout: '2026-10-25T09:30:00Z\tError\t124\n', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: `ELANOUS_POD_DEADLINE_RESULT ${job} ${childRunId} stop-cause=deadline stage=run pr=unknown branch=tc/work\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, deadlineSeconds: 10_800 })({ feature: 'x', spaceId: 'deadline-marker-test' }).done;
    expect(childRunId).toMatch(/^run-/);
    expect(result.error?.code).toBe('pod-deadline-exceeded');
    expect(result.disposition).toMatchObject({ stage: 'deadline', ok: false, branch: 'tc/work', failureClassification: 'run-deadline-exceeded' });
    expect(result.error?.message).not.toContain('no-result-line');
  });
  test('failed Job reads the newest child termination by creation time: OOM, Error, or unknown', async () => {
    const cases = [
      { id: 'oom', pods: '2026-09-27T06:41:00Z\tOOMKilled\t137\n2026-09-27T06:40:00Z\tError\t1\n', code: 'pod-oom-killed', fragment: 'OOMKilled/137', reason: 'OOMKilled', exitCode: 137 },
      { id: 'error', pods: '2026-09-27T06:41:00Z\tError\t1\n2026-09-27T06:40:00Z\tOOMKilled\t137\n', code: 'pod-job-failed', fragment: 'container=Error/1', reason: 'Error', exitCode: 1 },
      { id: 'missing', pods: '', code: 'pod-job-failed', fragment: 'BackoffLimitExceeded', reason: null, exitCode: null },
      { id: 'newest-unavailable', pods: '2026-09-27T06:41:00Z\t\n2026-09-27T06:40:00Z\tOOMKilled\t137\n', code: 'pod-job-failed', fragment: 'BackoffLimitExceeded', reason: null, exitCode: null },
      { id: 'unreadable', pods: '2026-09-27T06:41:00Z\tOOMKilled\t137\n', status: 1, code: 'pod-job-failed', fragment: 'BackoffLimitExceeded', reason: null, exitCode: null },
    ] as const;
    for (const c of cases) {
      const calls: string[][] = [];
      const records: Array<{ event: string; data: Record<string, unknown> }> = [];
      const off = debug.registerSink({ name: `pod-termination-${c.id}`, emit: (record) => {
        if (record.category === 'self-implement.pod' && ['container-terminated', 'job-finished'].includes(record.event)) records.push({ event: record.event, data: record.data as Record<string, unknown> });
      } });
      const k: Kubectl = (args) => {
        calls.push([...args]);
        if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
        if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
        if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: 'BackoffLimitExceeded', stderr: '' };
        if (args.includes('get') && args.includes('pods')) return { status: 'status' in c ? c.status : 0, stdout: c.pods, stderr: '' };
        if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
        if (args.includes('logs')) return { status: 0, stdout: 'boom', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      try {
        const job = podJobName(`termination-${c.id}`);
        const r = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_MEMORY_TIER: 'high', ELANOUS_POD_MEMORY_HIGH: '24Gi' } })({ feature: 'x', spaceId: `termination-${c.id}` }).done;
        const childPodQueries = calls.filter((args) => args.includes('get') && args.includes('pods') && args.includes(`job-name=${job}`) && args.some((arg) => arg.includes('containerStatuses[?(@.name=="child")]')));
        // Classification still uses the first read; incomplete terminal evidence receives one bounded re-read.
        expect(childPodQueries).toHaveLength(2);
        expect(calls.some((args) => args.includes('get') && args.includes('pods') && args.includes('json') && args.some((arg) => arg.startsWith('elanous.child-run=')))).toBe(true);
        expect(childPodQueries[0]).toEqual(expect.arrayContaining(['-n', 'elanous-test', '-l', `job-name=${job}`]));
        expect(childPodQueries[0]!.join(' ')).toContain('containerStatuses[?(@.name=="child")]');
        expect(r.exitCode).toBe(1);
        expect(r.error?.code).toBe(c.code);
        expect(r.error?.message).toContain(c.fragment);
        if (c.id === 'oom') expect(r.error?.message).toContain('24Gi');
        else if (c.reason === null) expect(r.error?.message).not.toContain('OOMKilled');
        const terminated = records.filter((record) => record.event === 'container-terminated');
        expect(terminated).toHaveLength(1);
        expect(terminated[0]).toMatchObject({ event: 'container-terminated', data: {
          job, container: 'child', reason: c.reason, exitCode: c.exitCode, jobReason: 'BackoffLimitExceeded', memoryLimit: '24Gi',
        } });
        expect(records.find((record) => record.event === 'job-finished')?.data).toMatchObject({ job, state: 'failed', containerReason: c.reason });
      } finally { off(); }
    }
  });
  test('BackoffLimitExceeded 는 pod-job-failed 에 reason 만 더한다', async () => {
    const k: Kubectl = (args) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: 'BackoffLimitExceeded', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: 'boom', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS })({ feature: 'x', spaceId: 'backoff' }).done;
    expect(r.error).toEqual({ code: 'pod-job-failed', message: `Job ${podJobName('backoff')} failed (BackoffLimitExceeded) — childError=no-result-line · reason=사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음` });
    expect(r.disposition?.failureClassification).toBeUndefined();
  });

  test('abort deletes the Job', async () => {
    const ac = new AbortController();
    ac.abort();
    const { k, calls } = fakeKubectl([''], '');
    const r = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS })({ feature: 'x', spaceId: 's', signal: ac.signal }).done;
    expect(r.error?.code).toBe('aborted');
    expect(calls.some((c) => c.args.includes('delete job') && c.args.includes('--wait=false'))).toBe(true);
  });

  // METER-POD-ROLLUP-GAP — harness stop 경로: PARTIAL 줄이 살아 있는 동안 로그를 먼저 거두고 Job 을 지운다.
  test('abort collects the child logs before deleting the Job (partial rollup survives the stop)', async () => {
    const ac = new AbortController();
    ac.abort();
    const { k, calls } = fakeKubectl([''], 'ELANOUS_USAGE_ROLLUP_PARTIAL {"partial":true,"seq":2,"measured":true,"rows":[]}');
    const r = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS })({ feature: 'x', spaceId: 'abort-logs', signal: ac.signal }).done;
    expect(r.error?.code).toBe('aborted');
    const logs = calls.findIndex((c) => c.args.includes('logs'));
    const deletion = calls.findIndex((c) => c.args.includes('delete job'));
    expect(logs).toBeGreaterThan(-1);
    expect(deletion).toBeGreaterThan(logs);
  });

  test('passEnv puts only present host keys into the secret and pod env (benchmark billing paths)', async () => {
    const { k, calls } = fakeKubectl(['Complete'], '');
    await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS, passEnv: ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'], env: { OPENROUTER_API_KEY: 'sk-or-1' }, readKeyCache: () => undefined })({ feature: 'x', spaceId: 's' }).done;
    const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
    expect(Object.keys(secret.stringData)).toContain('env-OPENROUTER_API_KEY');
    expect(Object.keys(secret.stringData)).not.toContain('env-ANTHROPIC_API_KEY');
    // ⭐ 과금 키만 본다 — run-origin 칸(ELANOUS_POD_NAME 등)은 별도 시험이 문다.
    expect(job.spec.template.spec.containers[0].env.map((e: { name: string }) => e.name).filter((n: string) => n.endsWith('_API_KEY'))).toEqual(['OPENROUTER_API_KEY']);
  });

  test('an OpenGateway child receives only its selected billing key from the host cache', async () => {
    const { k, calls } = fakeKubectl(['Complete'], '');
    await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS,
      provider: 'opengateway', childModel: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast',
      env: {}, readKeyCache: (name) => name === 'OPENGATEWAY_API_KEY' ? 'test-gateway-key' : undefined,
      openrouterGhToken: () => 'test-gh-token' })({ feature: 'x', spaceId: 'gateway-child' }).done;
    const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
    expect(secret.stringData['env-OPENGATEWAY_API_KEY']).toBe('test-gateway-key');
    expect(secret.stringData['env-OPENROUTER_API_KEY']).toBeUndefined();
    const container = job.spec.template.spec.containers[0];
    expect(container.env).toContainEqual(expect.objectContaining({ name: 'OPENGATEWAY_API_KEY' }));
    expect(container.args[0]).toContain('ELANOUS_LLM_PROVIDER=opengateway');
    expect(container.args[0]).toContain('opengateway/deepseek/deepseek-v4.1-flash-ultrafast');
  });

  test('an OpenGateway child refuses conflicting env and cache keys before applying a Pod', async () => {
    const { k, calls } = fakeKubectl(['Complete'], '');
    const result = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS,
      provider: 'opengateway', childModel: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast',
      env: { OPENGATEWAY_API_KEY: 'env-key' }, readKeyCache: (name) => name === 'OPENGATEWAY_API_KEY' ? 'cache-key' : undefined,
      openrouterGhToken: () => 'test-gh-token' })({ feature: 'x', spaceId: 'gateway-key-conflict' }).done;
    expect(result.error?.message).toContain('opengateway env와 키 캐시가 충돌');
    expect(calls.filter((c) => c.args.endsWith('apply -f -'))).toEqual([]);
  });

  test('an OpenGateway child refuses conflicting host config and cache keys before applying a Pod', async () => {
    const { k, calls } = fakeKubectl(['Complete'], '');
    const result = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS,
      provider: 'opengateway', childModel: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast',
      env: {}, readKeyCache: (name) => name === 'OPENGATEWAY_API_KEY' ? 'cache-key-b' : undefined,
      openGatewayConfig: () => ({ llm: { provider: 'opengateway', apiKey: 'config-key-a' } }) as UserConfig,
      openrouterGhToken: () => 'test-gh-token' })({ feature: 'x', spaceId: 'gateway-config-cache-conflict' }).done;
    expect(result.error?.message).toContain('opengateway 호스트 설정과 env/키 캐시가 충돌');
    expect(calls.filter((c) => c.args.endsWith('apply -f -'))).toEqual([]);
  });

  test('an OpenGateway child refuses conflicting active and rotation config keys before applying a Pod', async () => {
    const { k, calls } = fakeKubectl(['Complete'], '');
    const result = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS,
      provider: 'opengateway', childModel: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast',
      env: {}, readKeyCache: () => undefined,
      openGatewayConfig: () => ({ llm: { provider: 'opengateway', apiKey: 'active-key-b',
        rotation: [{ provider: 'opengateway', apiKey: 'rotation-key-a' }] } }) as UserConfig,
      openrouterGhToken: () => 'test-gh-token' })({ feature: 'x', spaceId: 'gateway-config-conflict' }).done;
    expect(result.error?.message).toContain('opengateway 호스트 설정과 env/키 캐시가 충돌');
    expect(calls.filter((c) => c.args.endsWith('apply -f -'))).toEqual([]);
  });

  test('an injected kubectl still checks the isolated host config before applying a Pod', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'gateway-host-config-'));
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    try {
      process.env.ELANOUS_STATE_DIR = stateDir;
      const configPath = userConfigPath();
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ llm: { provider: 'opengateway', apiKey: 'config-key-a' } }));
      const { k, calls } = fakeKubectl(['Complete'], '');
      const result = await realPodSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS,
        budgetSnapshot: () => undefined, fallbackConfig: () => ({ llm: {} }) as UserConfig,
        provider: 'opengateway', childModel: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast',
        env: {}, readKeyCache: (name) => name === 'OPENGATEWAY_API_KEY' ? 'cache-key-b' : undefined,
        openrouterGhToken: () => 'test-gh-token' })({ feature: 'x', spaceId: 'gateway-injected-kubectl-config' }).done;
      expect(result.error?.message).toContain('opengateway 호스트 설정과 env/키 캐시가 충돌');
      expect(calls.filter((c) => c.args.endsWith('apply -f -'))).toEqual([]);
    } finally {
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('an OpenGateway child can relay its configured key when env and cache are empty', async () => {
    const { k, calls } = fakeKubectl(['Complete'], '');
    await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS,
      provider: 'opengateway', childModel: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast',
      env: {}, readKeyCache: () => undefined,
      openGatewayConfig: () => ({ llm: { provider: 'opengateway', apiKey: 'config-only-key' } }) as UserConfig,
      openrouterGhToken: () => 'test-gh-token' })({ feature: 'x', spaceId: 'gateway-config-only' }).done;
    const secret = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!)).find((manifest) => manifest.kind === 'Secret');
    expect(secret.stringData['env-OPENGATEWAY_API_KEY']).toBe('config-only-key');
  });

  test('an OpenGateway child refuses an unverified model before applying a Pod', () => {
    const { k, calls } = fakeKubectl(['Complete'], '');
    const spawn = podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS,
      provider: 'opengateway', childModel: 'opengateway/unknown/model',
      env: {}, readKeyCache: (name) => name === 'OPENGATEWAY_API_KEY' ? 'test-gateway-key' : undefined });
    expect(() => spawn({ feature: 'x', spaceId: 'gateway-unverified-model' })).toThrow('opengateway model not verified');
    expect(calls.filter((c) => c.args.endsWith('apply -f -'))).toEqual([]);
  });

  test('manifest transfers bounded ledger chunks before the final disposition line (and emits NONE for an empty store)', () => {
    const manifest = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
    const script = manifest.spec.template.spec.containers[0]!.args[0]!;
    expect(script).toContain('ELANOUS_RUN_LEDGER %s %s/%s %s');
    expect(script.indexOf('ELANOUS_RUN_LEDGER')).toBeGreaterThan(script.indexOf('elanous self implement'));
    expect(script.indexOf('ELANOUS_RUN_LEDGER')).toBeLessThan(script.lastIndexOf('tail -n 1 /tmp/si.out'));
    expect(script).toContain('ELANOUS_RUN_LEDGER_NONE');
    const root = mkdtempSync(join(tmpdir(), 'pod-script-'));
    try {
      const dir = runLedgerDir(root);
      const id = 'run-12345678-1234-1234-1234-123456789abc';
      const payload = Array.from({ length: 12000 }, (_, n) => `line${n}`).join('\n') + '\n';
      mkdirSync(dir, { recursive: true });
      writeFileSync(runLedgerPath(id, dir), payload);
      const extract = script.slice(script.indexOf('set -o pipefail\n'), script.indexOf('\ntail -n 1 /tmp/si.out'));
      const r = Bun.spawnSync(['bash', '-c', extract], { env: { ...process.env, ELANOUS_STATE_DIR: root } });
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.toString().trim().split('\n');
      const chunks = lines.map((line) => line.split(' ').at(-1)!);
      expect(lines.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.length <= 8000)).toBe(true);
      expect(gunzipSync(Buffer.from(chunks.join(''), 'base64')).toString('utf8')).toBe(readFileSync(runLedgerPath(id, dir), 'utf8'));
      rmSync(dir, { recursive: true, force: true });
      const empty = Bun.spawnSync(['bash', '-c', extract], { env: { ...process.env, ELANOUS_STATE_DIR: root } });
      expect(empty.stdout.toString().trim()).toBe('ELANOUS_RUN_LEDGER_NONE');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('manifest exports pod observations through the bounded outbox before scanning and preserves child exit on export failure', () => {
    const manifest = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
    const script = manifest.spec.template.spec.containers[0]!.args[0]!;
    const exportCommand = 'elanous logs --all --include-test --since 12h --limit 20000 --json > "$HOME/outbox/pod-logs/logs.jsonl"';
    expect(script.indexOf(exportCommand)).toBeGreaterThan(script.indexOf('elanous self implement'));
    expect(script.indexOf(exportCommand)).toBeLessThan(script.indexOf('find "$HOME/outbox" -type f -print0'));
    expect(script.trimEnd()).toEndWith('exit $rc');
    const home = mkdtempSync(join(tmpdir(), 'pod-logs-home-'));
    const state = mkdtempSync(join(tmpdir(), 'pod-logs-state-'));
    try {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      const stub = join(bin, 'elanous');
      const extract = script.slice(script.indexOf('if mkdir -p "$HOME/outbox/pod-logs"'), script.indexOf('\nfound=0')) + '\nexit $rc';
      const env = { ...process.env, HOME: home, ELANOUS_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` };
      writeFileSync(stub, '#!/bin/sh\nprintf "{\\"event\\":1}\\n{\\"event\\":2}\\n"\n');
      chmodSync(stub, 0o755);
      const success = Bun.spawnSync(['bash', '-c', `rc=7\n${extract}`], { env });
      expect(success.exitCode).toBe(7);
      const parsed = parsePodArtifactChunks(success.stdout.toString());
      if (!Array.isArray(parsed)) throw new Error('pod log transfer incomplete');
      expect(parsed.find((artifact) => artifact.path === 'pod-logs/logs.jsonl')?.bytes.toString()).toBe('{"event":1}\n{"event":2}\n');
      writeFileSync(stub, '#!/bin/sh\nhead -c 5242881 /dev/zero\n');
      const overLimit = Bun.spawnSync(['bash', '-c', `rc=7\n${extract}`], { env });
      expect(overLimit.exitCode).toBe(7);
      // Over the 5MB limit the export is cut to its newest lines (not skipped whole) and says so.
      expect(overLimit.stdout.toString().split('\n')).not.toContain('ELANOUS_POD_ARTIFACT_SKIPPED pod-logs/logs.jsonl 5242881');
      expect(overLimit.stdout.toString()).toMatch(/^ELANOUS_POD_LOGS_TRUNCATED 5242881 \d+$/m);
      writeFileSync(stub, '#!/bin/sh\nprintf "partial"\nexit 4\n');
      const failed = Bun.spawnSync(['bash', '-c', `rc=7\n${extract}`], { env });
      expect(failed.exitCode).toBe(7);
      expect(failed.stdout.toString().split('\n').filter((line) => line.startsWith('ELANOUS_POD_LOGS_UNAVAILABLE '))).toEqual(['ELANOUS_POD_LOGS_UNAVAILABLE export-exit-4']);
      expect(failed.stdout.toString()).not.toContain('ELANOUS_POD_ARTIFACT ');
      expect(existsSync(join(home, 'outbox', 'pod-logs', 'logs.jsonl'))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
  });

  test('manifest emits outbox files ahead of ledger, skips over-limit files, and keeps final JSON last', () => {
    const manifest = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
    const script = manifest.spec.template.spec.containers[0]!.args[0]!;
    expect(script.indexOf("printf 'ELANOUS_POD_ARTIFACT %s")).toBeLessThan(script.indexOf("printf 'ELANOUS_RUN_LEDGER %s"));
    expect(script.indexOf('ELANOUS_RUN_LEDGER_NONE')).toBeLessThan(script.lastIndexOf('tail -n 1 /tmp/si.out'));
    const home = mkdtempSync(join(tmpdir(), 'pod-outbox-'));
    const state = mkdtempSync(join(tmpdir(), 'pod-state-'));
    try {
      mkdirSync(join(home, 'outbox', 'nested'), { recursive: true });
      writeFileSync(join(home, 'outbox', 'nested', 'blob'), Buffer.from([0, 255, 42]));
      writeFileSync(join(home, 'outbox', 'note'), 'hello');
      writeFileSync(join(home, 'outbox', 'oversize'), Buffer.alloc(5 * 1024 * 1024 + 1));
      mkdirSync(join(home, 'outbox', 'pod-salvage'), { recursive: true });
      const largeBundle = Buffer.alloc(5 * 1024 * 1024 + 17, 0x5a);
      writeFileSync(join(home, 'outbox', 'pod-salvage', 'worktree.bundle'), largeBundle);
      for (let i = 0; i < 5; i++) writeFileSync(join(home, 'outbox', `large-${i}`), Buffer.alloc(5 * 1024 * 1024));
      const extract = script.slice(script.indexOf('set -o pipefail\n'), script.indexOf('\ntail -n 1 /tmp/si.out'));
      const r = Bun.spawnSync(['bash', '-c', extract], { env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: state } });
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.toString().trim().split('\n');
      const parsed = parsePodArtifactChunks(lines.join('\n'));
      expect(Array.isArray(parsed)).toBe(true);
      if (!Array.isArray(parsed)) throw new Error('unexpected incomplete');
      const transferred = parsed.map((artifact) => artifact.path);
      expect(transferred).toContain('nested/blob');
      expect(transferred).toContain('note');
      expect(transferred).toContain('pod-salvage/worktree.bundle');
      expect(parsed.find((artifact) => artifact.path === 'pod-salvage/worktree.bundle')?.bytes).toEqual(largeBundle);
      expect(transferred.filter((path) => path.startsWith('large-'))).toHaveLength(3);
      expect(parsed.find((artifact) => artifact.path === 'nested/blob')?.bytes).toEqual(Buffer.from([0, 255, 42]));
      expect(lines).toContain('ELANOUS_POD_ARTIFACT_SKIPPED oversize 5242881');
      expect(lines.filter((line) => /^ELANOUS_POD_ARTIFACT_SKIPPED large-[0-4] 5242880$/.test(line))).toHaveLength(2);
      expect(lines.at(-1)).toBe('ELANOUS_RUN_LEDGER_NONE');
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
  });

  test('completed Job collects artifacts from full logs beside ledger without changing disposition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-artifact-runtime-'));
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    try {
      const name = podJobName('artifact-runtime');
      const json = '{"stage":"error","ok":false,"error":"draft PR 생성 실패: fake gh exit 1"}';
      const artifactLine = `ELANOUS_POD_ARTIFACT ${Buffer.from('nested/note.txt').toString('base64url')} 1/1 ${gzipSync('from pod').toString('base64')}`;
      const salvagePath = 'pod-salvage/wt-commit.bundle';
      const salvageRepo = join(root, 'salvage-repo');
      const salvageBytesPath = join(root, 'salvage.bundle');
      execFileSync('git', ['init', '-q', '-b', 'main', salvageRepo]);
      execFileSync('git', ['-C', salvageRepo, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', salvageRepo, 'config', 'user.name', 'pod']);
      writeFileSync(join(salvageRepo, 'kept.txt'), 'kept\\n');
      execFileSync('git', ['-C', salvageRepo, 'add', 'kept.txt']);
      execFileSync('git', ['-C', salvageRepo, 'commit', '-qm', 'kept']);
      execFileSync('git', ['-C', salvageRepo, 'bundle', 'create', salvageBytesPath, '--all']);
      const salvageBytes = readFileSync(salvageBytesPath);
      const salvageLine = `ELANOUS_POD_ARTIFACT ${Buffer.from(salvagePath).toString('base64url')} 1/1 ${gzipSync(salvageBytes).toString('base64')}`;
      const ledgerLine = `ELANOUS_RUN_LEDGER run-artifact-1 1/1 ${gzipSync('{"ok":true}\\n').toString('base64')}`;
      const kubectl: Kubectl = (args) => {
        if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
        if (args.includes('get')) return { status: 0, stdout: 'Complete', stderr: '' };
        if (args.includes('logs')) return { status: 0, stdout: args.includes('--tail=400') ? `${json}\n` : `${artifactLine}\n${salvageLine}\nELANOUS_POD_SALVAGE_BUNDLE ${salvagePath} 1 1\n${ledgerLine}\n${json}\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_RUN_ID: 'run-artifact-parent', ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'artifact-runtime' }).done;
      expect(result.disposition?.stage).toBe('error');
      expect(result.exitCode).toBe(1);
      expect(readFileSync(join(effectiveInstanceRoot(), 'pod-artifacts', name, 'nested/note.txt'), 'utf8')).toBe('from pod');
      expect(readFileSync(join(effectiveInstanceRoot(), 'pod-artifacts', name, salvagePath))).toEqual(salvageBytes);
      const parentLedger = readFileSync(runLedgerPath('run-artifact-parent', runLedgerDir(root)), 'utf8');
      expect(parentLedger).toContain('"event":"pod-salvage-bundle"');
      expect(parentLedger).toContain(`"path":"${join(effectiveInstanceRoot(), 'pod-artifacts', name, salvagePath)}"`);
      expect(parentLedger).toContain('"commitCount":1,"diffLines":1');
      expect(readFileSync(runLedgerPath('run-artifact-1', runLedgerDir(root)), 'utf8')).toBe('{"ok":true}\\n');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed Pod with a corrupt returned bundle records preservation failure, not success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-salvage-corrupt-ledger-'));
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    try {
      const json = '{"stage":"error","ok":false,"error":"draft PR 생성 실패: fake gh exit 1"}';
      const salvagePath = 'pod-salvage/wt-bad.bundle';
      const corrupt = Buffer.from('not a git bundle');
      const artifactLine = `ELANOUS_POD_ARTIFACT ${Buffer.from(salvagePath).toString('base64url')} 1/1 ${gzipSync(corrupt).toString('base64')}`;
      const kubectl: Kubectl = (args) => {
        if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
        if (args.includes('get')) return { status: 0, stdout: 'Complete', stderr: '' };
        if (args.includes('logs')) return { status: 0, stdout: args.includes('--tail=400') ? `${json}\n` : `${artifactLine}\nELANOUS_POD_SALVAGE_BUNDLE ${salvagePath} 1 1\n${json}\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_RUN_ID: 'run-salvage-corrupt-parent', ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'salvage-corrupt-runtime' }).done;
      const ledger = readFileSync(runLedgerPath('run-salvage-corrupt-parent', runLedgerDir(root)), 'utf8');
      expect(ledger).toContain('"disposition":"보존 실패"');
      expect(ledger).not.toContain('"commitCount":1,"diffLines":1');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a declared salvage bundle missing from returned artifacts records preservation failure only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-salvage-missing-ledger-'));
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    try {
      const json = '{"stage":"error","ok":false,"error":"draft PR 생성 실패"}';
      const salvagePath = 'pod-salvage/wt-missing.bundle';
      const kubectl: Kubectl = (args) => {
        if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
        if (args.includes('get')) return { status: 0, stdout: 'Complete', stderr: '' };
        if (args.includes('logs')) return { status: 0, stdout: args.includes('--tail=400') ? `${json}\n` : `ELANOUS_POD_SALVAGE_BUNDLE ${salvagePath} 1 1\n${json}\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_RUN_ID: 'run-salvage-missing-parent', ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'salvage-missing-runtime' }).done;
      const ledger = readFileSync(runLedgerPath('run-salvage-missing-parent', runLedgerDir(root)), 'utf8');
      expect(ledger).toContain('"disposition":"보존 실패"');
      expect(ledger).not.toContain('"commitCount":1');
      expect(ledger).not.toContain('"path":');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed Pod with no commits records 보존할 것 없음 in the parent ledger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-salvage-empty-ledger-'));
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    try {
      const json = '{"stage":"error","ok":false,"error":"draft PR 생성 실패: fake gh exit 1"}';
      const kubectl: Kubectl = (args) => {
        if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
        if (args.includes('get')) return { status: 0, stdout: 'Complete', stderr: '' };
        if (args.includes('logs')) return { status: 0, stdout: args.includes('--tail=400') ? `${json}\n` : `ELANOUS_POD_SALVAGE_NONE no-commits\n${json}\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_RUN_ID: 'run-salvage-empty-parent', ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'salvage-empty-runtime' }).done;
      const ledger = readFileSync(runLedgerPath('run-salvage-empty-parent', runLedgerDir(root)), 'utf8');
      expect(ledger).toContain('"event":"pod-salvage-bundle"');
      expect(ledger).toContain('"disposition":"보존할 것 없음","commitCount":0,"diffLines":0');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('parent ledger survives while the Pod ledger is collected under a fresh child ID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-parent-ledger-'));
    const parent = 'run-parent-1';
    const dir = runLedgerDir(root);
    appendRunLedgerEntry({ runId: parent, event: 'parent-start', data: {} }, dir);
    const calls: Array<{ kind: string; spec?: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } }> = [];
    const events: string[] = [];
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-parent-ledger-test', emit: (record) => {
      if (record.category !== 'self-implement.pod') return;
      events.push(record.event);
      if (record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    let child = '';
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const manifest = JSON.parse(input);
        calls.push(manifest);
        if (manifest.kind === 'Job') child = manifest.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: `ELANOUS_RUN_LEDGER ${child} 1/1 ${gzipSync(JSON.stringify({ runId: child, event: 'child-start', data: {} }) + '\n').toString('base64')}\n{"stage":"merged","ok":true}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'parent-child' }).done;
      expect(child).toMatch(/^run-[0-9a-f-]{36}$/);
      expect(child).not.toBe(parent);
      expect(calls.find((m) => m.kind === 'Job')!.spec!.template.spec.containers[0]!.env).toContainEqual({ name: 'ELANOUS_PARENT_RUN_ID', value: parent });
      expect(readFileSync(runLedgerPath(child, dir), 'utf8')).toContain('child-start');
      expect(events).toContain('ledger-collected');
      expect(readFileSync(runLedgerPath(child, dir), 'utf8')).not.toContain('pod-ledger-incomplete');
      expect(readFileSync(runLedgerPath(parent, dir), 'utf8')).toContain('"event":"pod-child-run"');
      expect(readFileSync(runLedgerPath(parent, dir), 'utf8')).toContain(child);
      expect(events).not.toContain('ledger-collect-skipped');
      expect(finished).toContainEqual(expect.objectContaining({ childRunId: child, ledgerCompleteness: 'complete' }));
    } finally { off(); rmSync(root, { recursive: true, force: true }); }
  });

  test('failed Pod lifts complete child JSON facts into the parent ledger before shortening stdout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-child-evidence-'));
    const parent = 'run-parent-evidence';
    const previousState = process.env.ELANOUS_STATE_DIR;
    const child = { stage: 'soft-stopped', ok: false, exitCode: 128, error: 'gh pr create failed', stderr: 'remote rejected the push',
      detail: 'Out-of-scope edits held in the worktree; gate and publication skipped.',
      outOfScopeEdits: ['src/unrelated.ts'], scopeStopReasons: ['deletion'], abandonedClassification: { classification: 'implementation-deficit' },
      supervisorVerdict: 'UNCONVERGEABLE', goalCauseObserved: true,
      terminationReason: { kind: 'goal-only-rework-exhausted' },
      quotaExhaustionAssessment: { accountAvailability: { reason: 'no-candidate', candidateCount: 0 } } };
    const { k } = fakeKubectl(['Failed'], `${JSON.stringify(child)}\n${'late diagnostic '.repeat(350)}\n`);
    try {
      process.env.ELANOUS_STATE_DIR = root;
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS,
        env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'child-evidence' }).done;
      expect(result.exitCode).toBe(1);
      expect(result.output).not.toContain('outOfScopeEdits');
      expect(result.output).not.toContain('accountAvailability');
      const exitCode = result.exitCode ?? 1;
      const childEvidence = { classification: 'scope-escape', scopeEscape: true, scopeStopReasons: ['deletion'],
        error: child.error, detail: child.detail, stderr: child.stderr, exitCode: 128,
        outOfScopeEdits: child.outOfScopeEdits, terminationReason: child.terminationReason,
          abandonedClassification: child.abandonedClassification, supervisorVerdict: 'UNCONVERGEABLE',
          goalCauseObserved: true, accountAvailability: { reason: 'no-candidate', candidateCount: 0 } };
      expect(loadRunLedger(parent, runLedgerDir(root))?.find((entry) => entry.event === 'pod-child-evidence')?.data)
        .toMatchObject({ childEvidence });
      expect(recordHarnessPodStop(parent, exitCode, { reason: 'pod-failure', lines: [result.output] }, result.output)).toBe(true);
      recordClassifiedHarnessPodExit(parent, 'pod-failure', exitCode, { output: result.output });
      expect(loadRunLedger(parent, runLedgerDir(root))?.find((entry) => entry.event === 'stop')?.data)
        .toMatchObject({ class: 'scope-escape', childEvidence });
      expect(readRunExits(root)).toMatchObject([{ runId: parent, reason: 'scope-escape', childEvidence }]);
    } finally {
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('JOB-FAILURE-TERMINATION-CAPTURE — the failure verdict carries this Job\'s termination facts to the incident row', () => {
    /** The spawn's own calls (context · apply · reattach probe · logs) here; every Job/Pod state read goes to the fake kubectl device. */
    function terminationLaunch(o: { spaceId: string; event: Omit<PodDeviceEvent, 'jobName'>; logs: string; markerRc?: number;
      retryPodRead?: { status: number; stdout: string; stderr: string };
      retryPodReadAfterLogTail?: boolean;
      /** After the verdict poll saw Failed: `gc-after-first` — the first Job read answers, later ones are NotFound (GC);
       *  `throw-first` — the first Job read throws. */
      afterVerdict?: 'gc-after-first' | 'throw-first' }) {
      const jobName = podJobName(o.spaceId);
      const device = makeScriptedKubectlDevice([{ ...o.event, jobName }]);
      let childRunId = '';
      let verdictSeen = false;
      let jobReadsAfterVerdict = 0;
      let terminationPodReads = 0;
      let logTailCollected = false;
      const kubectl: Kubectl = (args, input) => {
        if (args.some((arg) => arg.startsWith('jsonpath={range .items[*]}{.metadata.creationTimestamp}'))) {
          terminationPodReads++;
          if (terminationPodReads > 1 && o.retryPodRead && (!o.retryPodReadAfterLogTail || logTailCollected)) return o.retryPodRead;
        }
        if (o.afterVerdict && args.includes('get') && args.includes('job')) {
          if (args.includes('jsonpath={.status.conditions[*].type}')) {
            const answer = device.kubectl(args, input);
            if (/Failed/.test(answer.stdout)) verdictSeen = true;
            return answer;
          }
          if (verdictSeen) {
            jobReadsAfterVerdict++;
            if (o.afterVerdict === 'throw-first' && jobReadsAfterVerdict === 1) throw new Error('kubectl: connection reset');
            if (o.afterVerdict === 'gc-after-first' && jobReadsAfterVerdict > 1) return { status: 1, stdout: '', stderr: `Error from server (NotFound): jobs.batch "${jobName}" not found` };
          }
        }
        if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
        if (args.includes('apply') && input) {
          const manifest = JSON.parse(input);
          if (manifest.kind === 'Job') childRunId = manifest.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
          return { status: 0, stdout: '', stderr: '' };
        }
        if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
        if (args.includes('logs')) {
          if (args.includes('--tail=400')) logTailCollected = true;
          const marker = o.markerRc === undefined ? '' : `\n__ELANOUS_POD_DONE__ ${childRunId} rc=${o.markerRc}\n`;
          return { status: 0, stdout: args.includes('--tail=2') ? marker.slice(1) : `${o.logs}${marker}`, stderr: '' };
        }
        return device.kubectl(args, input);
      };
      return { kubectl, calls: device.calls, jobName };
    }

    async function runAndRecord(launch: ReturnType<typeof terminationLaunch>, spaceId: string, parent: string, resultMarker: boolean) {
      const root = mkdtempSync(join(tmpdir(), 'pod-termination-'));
      const previousState = process.env.ELANOUS_STATE_DIR;
      const finished: Array<Record<string, unknown>> = [];
      const off = debug.registerSink({ name: `pod-termination-${spaceId}`, emit: (record) => {
        if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
      } });
      try {
        process.env.ELANOUS_STATE_DIR = root;
        const result = await podSelfImplementSpawn({ kubectl: launch.kubectl, credentials: CREDS, sleep: async () => {}, resultMarker,
          env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId }).done;
        const evidence = loadRunLedger(parent, runLedgerDir(root))?.filter((entry) => entry.event === 'pod-child-evidence').at(-1)?.data;
        recordClassifiedHarnessPodExit(parent, 'unknown', result.exitCode ?? 1, { output: result.output });
        return { result, finished, evidence, exits: readRunExits(root) };
      } finally {
        off();
        if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
        else process.env.ELANOUS_STATE_DIR = previousState;
        rmSync(root, { recursive: true, force: true });
      }
    }

    test('Job Failed condition path: one read of reason · exitCode · finishedAt · deadline lands as podTermination', async () => {
      const uid = '0a1b2c3d-0000-4000-8000-0000000000aa';
      const launch = terminationLaunch({ spaceId: 'term-failed', logs: 'child crashed without a result line\n',
        event: { kind: 'job-failed-backoff', jobUid: uid, jobConditionType: 'Failed', jobConditionReason: 'BackoffLimitExceeded',
          activeDeadlineSeconds: 14400, podPhase: 'Failed', containerReason: 'Error', containerExitCode: 1, containerFinishedAt: '2026-10-22T05:07:41Z' } });
      const { result, finished, evidence, exits } = await runAndRecord(launch, 'term-failed', 'run-parent-term-failed', false);
      expect(result.exitCode).toBe(1);
      const expected = { job: launch.jobName, path: 'job-failed-condition', jobLookup: 'ok', jobUid: uid, jobConditionReason: 'BackoffLimitExceeded',
        activeDeadlineSeconds: 14400, deadlineExceeded: false, podLookup: 'terminated', containerReason: 'Error', exitCode: 1,
        finishedAt: '2026-10-22T05:07:41Z', oomKilled: false };
      expect(finished.at(-1)).toMatchObject({ state: 'failed', childError: 'no-result-line', podTermination: expected });
      expect(evidence).toMatchObject({ job: launch.jobName, podTermination: expected });
      expect(exits).toMatchObject([{ runId: 'run-parent-term-failed', reason: 'unknown', podTermination: expected }]);
      // Observation only: the existing classification read is unchanged and still drives the message.
      expect(result.error?.code).toBe('pod-job-failed');
      // One Job read after the verdict serves both the classification reason and the capture.
      expect(launch.calls.filter((call) => call.args.includes('get') && call.args.includes('job')
        && call.args.some((arg) => arg.includes('conditions[?(@.type=="Failed")].reason')))).toHaveLength(1);
    });

    test('result marker early exit: a still-running Pod is queried again and the missing terminal facts are explained', async () => {
      const uid = '0a1b2c3d-0000-4000-8000-0000000000bb';
      const launch = terminationLaunch({ spaceId: 'term-marker', markerRc: 3, logs: '',
        event: { kind: 'result-marker-running', jobUid: uid, jobConditionType: '', activeDeadlineSeconds: 14400, podPhase: 'Running',
          containerReason: null, containerExitCode: null, containerFinishedAt: null } });
      const { result, finished, exits } = await runAndRecord(launch, 'term-marker', 'run-parent-term-marker', true);
      expect(result.exitCode).toBe(1);
      const expected = { job: launch.jobName, path: 'result-marker', jobLookup: 'ok', jobUid: uid, jobConditionReason: 'unknown', deadlineExceeded: 'unknown',
        activeDeadlineSeconds: 14400, podLookup: 'running', containerReason: 'unknown', exitCode: 'unknown', finishedAt: 'unknown', oomKilled: 'unknown',
        collectionAttempts: 2, collectionFailureReason: 'pod-still-running-after-retry' };
      expect(finished.at(-1)).toMatchObject({ state: 'failed', podTermination: expected });
      expect(exits).toMatchObject([{ runId: 'run-parent-term-marker', podTermination: expected }]);
    });

    test('result marker early exit: retry captures terminated child facts in the incident', async () => {
      const uid = '0a1b2c3d-0000-4000-8000-0000000000b1';
      const launch = terminationLaunch({ spaceId: 'term-marker-ended', markerRc: 3, logs: '',
        event: { kind: 'result-marker-running', jobUid: uid, jobConditionType: '', activeDeadlineSeconds: 14400, podPhase: 'Running',
          containerReason: null, containerExitCode: null, containerFinishedAt: null },
        retryPodRead: { status: 0, stdout: `2026-10-25T13:00:00Z\tError\t3\t2026-10-25T13:00:03Z\t\t\t|Failed\t${uid}\n`, stderr: '' } });
      const { exits } = await runAndRecord(launch, 'term-marker-ended', 'run-parent-term-marker-ended', true);
      expect(exits).toMatchObject([{ podTermination: { podLookup: 'terminated', containerReason: 'Error', exitCode: 3,
        finishedAt: '2026-10-25T13:00:03Z', collectionAttempts: 2 } }]);
      expect(exits[0]?.podTermination).not.toHaveProperty('collectionFailureReason');
    });

    test('result marker waits through log collection before its one status retry', async () => {
      const uid = '0a1b2c3d-0000-4000-8000-0000000000b4';
      const launch = terminationLaunch({ spaceId: 'term-marker-lag', markerRc: 3, logs: '',
        event: { kind: 'result-marker-running', jobUid: uid, jobConditionType: '', activeDeadlineSeconds: 14400,
          podPhase: 'Running', containerReason: null, containerExitCode: null, containerFinishedAt: null },
        retryPodReadAfterLogTail: true,
        retryPodRead: { status: 0, stdout: `2026-10-26T12:00:00Z\tError\t3\t2026-10-26T12:00:03Z\t\t\t|Failed\t${uid}\n`, stderr: '' } });
      const { exits } = await runAndRecord(launch, 'term-marker-lag', 'run-parent-term-marker-lag', true);
      expect(exits).toMatchObject([{ podTermination: { podLookup: 'terminated', exitCode: 3,
        finishedAt: '2026-10-26T12:00:03Z', collectionAttempts: 2 } }]);
    });

    test('result marker early exit: retry records a disappeared Pod without inventing an exit', async () => {
      const uid = '0a1b2c3d-0000-4000-8000-0000000000b2';
      const launch = terminationLaunch({ spaceId: 'term-marker-gc', markerRc: 3, logs: '',
        event: { kind: 'result-marker-running', jobUid: uid, jobConditionType: '', activeDeadlineSeconds: 14400, podPhase: 'Running',
          containerReason: null, containerExitCode: null, containerFinishedAt: null },
        retryPodRead: { status: 0, stdout: '', stderr: '' } });
      const { exits } = await runAndRecord(launch, 'term-marker-gc', 'run-parent-term-marker-gc', true);
      expect(exits).toMatchObject([{ podTermination: { podLookup: 'absent', exitCode: 'unknown', finishedAt: 'unknown',
        collectionAttempts: 2, collectionFailureReason: 'pod-absent-after-retry' } }]);
    });

    test('result marker early exit: retry API failure retains the observed running state and records why', async () => {
      const uid = '0a1b2c3d-0000-4000-8000-0000000000b3';
      const launch = terminationLaunch({ spaceId: 'term-marker-api', markerRc: 3, logs: '',
        event: { kind: 'result-marker-running', jobUid: uid, jobConditionType: '', activeDeadlineSeconds: 14400, podPhase: 'Running',
          containerReason: null, containerExitCode: null, containerFinishedAt: null },
        retryPodRead: { status: 1, stdout: '', stderr: 'connection reset' } });
      const { exits } = await runAndRecord(launch, 'term-marker-api', 'run-parent-term-marker-api', true);
      expect(exits).toMatchObject([{ podTermination: { podLookup: 'running', exitCode: 'unknown', finishedAt: 'unknown',
        collectionAttempts: 2, collectionFailureReason: 'pod-read-unavailable-after-retry' } }]);
    });

    test('GC right after the verdict: the capture keeps the reason · deadline · uid from the one Job read, not a re-read', async () => {
      const uid = '0a1b2c3d-0000-4000-8000-0000000000cc';
      const launch = terminationLaunch({ spaceId: 'term-gc', logs: 'child crashed without a result line\n', afterVerdict: 'gc-after-first',
        event: { kind: 'job-failed-backoff', jobUid: uid, jobConditionType: 'Failed', jobConditionReason: 'BackoffLimitExceeded',
          activeDeadlineSeconds: 14400, podPhase: 'Failed', containerReason: 'Error', containerExitCode: 1, containerFinishedAt: '2026-10-22T05:07:41Z' } });
      const { result, exits } = await runAndRecord(launch, 'term-gc', 'run-parent-term-gc', false);
      expect(result.error?.code).toBe('pod-job-failed');
      expect(exits).toMatchObject([{ podTermination: { jobLookup: 'ok', jobUid: uid, jobConditionReason: 'BackoffLimitExceeded', activeDeadlineSeconds: 14400,
        deadlineExceeded: false, podLookup: 'terminated', containerReason: 'Error', exitCode: 1 } }]);
    });

    test('a thrown first Job read keeps today\'s outcome (pod-error) and still lands the capture in the incident', async () => {
      const uid = '0a1b2c3d-0000-4000-8000-0000000000dd';
      const launch = terminationLaunch({ spaceId: 'term-throw', logs: 'child crashed without a result line\n', afterVerdict: 'throw-first',
        event: { kind: 'job-failed-backoff', jobUid: uid, jobConditionType: 'Failed', jobConditionReason: 'BackoffLimitExceeded',
          activeDeadlineSeconds: 14400, podPhase: 'Failed', containerReason: 'Error', containerExitCode: 1, containerFinishedAt: '2026-10-22T05:07:41Z' } });
      const { result, exits } = await runAndRecord(launch, 'term-throw', 'run-parent-term-throw', false);
      expect(result.exitCode).toBe(1);
      expect(result.error?.code).toBe('pod-error');
      expect(exits).toMatchObject([{ podTermination: { path: 'job-failed-condition', jobLookup: 'unavailable', jobConditionReason: 'unknown',
        deadlineExceeded: 'unknown', jobUid: uid, podLookup: 'terminated', containerReason: 'Error', exitCode: 1, oomKilled: false } }]);
    });

    test('a later evidence row of the same attempt without a capture does not drop the capture', () => {
      const root = mkdtempSync(join(tmpdir(), 'pod-termination-last-row-'));
      const previousState = process.env.ELANOUS_STATE_DIR;
      const parent = 'run-parent-term-last-row';
      const termination = { job: 'si-one', path: 'job-failed-condition', observedAt: '2026-10-22T05:07:41Z', jobLookup: 'ok', jobUid: '0a1b2c3d-0000-4000-8000-0000000000ee',
        jobConditionReason: 'BackoffLimitExceeded', activeDeadlineSeconds: 14400, deadlineExceeded: false, podLookup: 'unavailable',
        containerReason: 'unknown', exitCode: 'unknown', finishedAt: 'unknown', oomKilled: 'unknown' };
      try {
        process.env.ELANOUS_STATE_DIR = root;
        const dir = runLedgerDir(root);
        appendRunLedgerEntry({ runId: parent, event: 'pod-child-run', data: { childRunId: 'c1', job: 'si-one', attempt: 1 } }, dir);
        appendRunLedgerEntry({ runId: parent, event: 'pod-child-evidence', data: { childEvidence: null, childRunId: 'c1', job: 'si-one', podTermination: termination } }, dir);
        appendRunLedgerEntry({ runId: parent, event: 'pod-child-evidence', data: { childEvidence: null, childRunId: 'c1', job: 'si-one' } }, dir);
        recordClassifiedHarnessPodExit(parent, 'unknown', 1, {});
        expect(readRunExits(root)).toMatchObject([{ runId: parent, podTermination: termination }]);
      } finally {
        if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
        else process.env.ELANOUS_STATE_DIR = previousState;
        rmSync(root, { recursive: true, force: true });
      }
    });

    test('a later attempt without its own capture does not inherit the earlier attempt\'s podTermination', () => {
      const root = mkdtempSync(join(tmpdir(), 'pod-termination-fence-'));
      const previousState = process.env.ELANOUS_STATE_DIR;
      const parent = 'run-parent-term-fence';
      const termination = { job: 'si-old', path: 'job-failed-condition', observedAt: '2026-10-22T05:07:41Z', jobLookup: 'ok', jobUid: '0a1b2c3d-0000-4000-8000-0000000000ee',
        jobConditionReason: 'BackoffLimitExceeded', activeDeadlineSeconds: 14400, deadlineExceeded: false, podLookup: 'unavailable',
        containerReason: 'unknown', exitCode: 'unknown', finishedAt: 'unknown', oomKilled: 'unknown' };
      try {
        process.env.ELANOUS_STATE_DIR = root;
        const dir = runLedgerDir(root);
        appendRunLedgerEntry({ runId: parent, event: 'pod-child-run', data: { childRunId: 'c1', job: 'si-old', attempt: 1 } }, dir);
        appendRunLedgerEntry({ runId: parent, event: 'pod-child-evidence', data: { childEvidence: null, childRunId: 'c1', job: 'si-old', podTermination: termination } }, dir);
        appendRunLedgerEntry({ runId: parent, event: 'pod-child-run', data: { childRunId: 'c2', job: 'si-new', attempt: 2 } }, dir);
        // The new attempt's row names another Job's record — dropped, not carried.
        appendRunLedgerEntry({ runId: parent, event: 'pod-child-evidence', data: { childEvidence: null, childRunId: 'c2', job: 'si-new', podTermination: termination } }, dir);
        recordClassifiedHarnessPodExit(parent, 'unknown', 1, {});
        expect(readRunExits(root)).toHaveLength(1);
        expect(readRunExits(root)[0]).not.toHaveProperty('podTermination');
        // A reused job/childRunId pair: the row before the latest start belongs to the earlier attempt.
        const reused = 'run-parent-term-fence-reused';
        const own = { ...termination, job: 'si-same' };
        appendRunLedgerEntry({ runId: reused, event: 'pod-child-run', data: { childRunId: 'c1', job: 'si-same', attempt: 1 } }, dir);
        appendRunLedgerEntry({ runId: reused, event: 'pod-child-evidence', data: { childEvidence: null, childRunId: 'c1', job: 'si-same', podTermination: own } }, dir);
        appendRunLedgerEntry({ runId: reused, event: 'pod-child-run', data: { childRunId: 'c1', job: 'si-same', attempt: 2 } }, dir);
        recordClassifiedHarnessPodExit(reused, 'unknown', 1, {});
        expect(readRunExits(root).find((row) => row.runId === reused)).not.toHaveProperty('podTermination');
        // Same fence for childEvidence: the earlier attempt's facts do not classify the reused pair's later attempt.
        const reusedEvidence = 'run-parent-term-fence-reused-evidence';
        appendRunLedgerEntry({ runId: reusedEvidence, event: 'pod-child-run', data: { childRunId: 'c9', job: 'si-same-ev', attempt: 1 } }, dir);
        appendRunLedgerEntry({ runId: reusedEvidence, event: 'pod-child-evidence', data: { childEvidence: { classification: 'implementation-deficit', stderr: 'earlier attempt' }, childRunId: 'c9', job: 'si-same-ev' } }, dir);
        appendRunLedgerEntry({ runId: reusedEvidence, event: 'pod-child-run', data: { childRunId: 'c9', job: 'si-same-ev', attempt: 2 } }, dir);
        recordClassifiedHarnessPodExit(reusedEvidence, 'unknown', 1, {});
        expect(readRunExits(root).find((row) => row.runId === reusedEvidence)).not.toHaveProperty('childEvidence');
        appendRunLedgerEntry({ runId: reused, event: 'pod-child-evidence', data: { childEvidence: null, childRunId: 'c1', job: 'si-same', podTermination: own } }, dir);
        const fresh = 'run-parent-term-fence-fresh';
        appendRunLedgerEntry({ runId: fresh, event: 'pod-child-run', data: { childRunId: 'c3', job: 'si-same', attempt: 1 } }, dir);
        appendRunLedgerEntry({ runId: fresh, event: 'pod-child-evidence', data: { childEvidence: null, childRunId: 'c3', job: 'si-same', podTermination: own } }, dir);
        recordClassifiedHarnessPodExit(fresh, 'unknown', 1, {});
        expect(readRunExits(root).find((row) => row.runId === fresh)).toMatchObject({ podTermination: own });
      } finally {
        if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
        else process.env.ELANOUS_STATE_DIR = previousState;
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test('PR blocker IDs found only in an unbound child ledger stay unmeasured in the parent incident', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-pr-ledger-evidence-'));
    const parent = 'run-parent-pr-ledger-evidence';
    const previousState = process.env.ELANOUS_STATE_DIR;
    const terminalError = `draft PR 생성 실패(worktree·branch 보존 · ${'long-path-'.repeat(35)})\nself-implement PR guard 실패: same-cell`;
    const ledgerError = 'self-implement PR guard 실패: same-cell; candidateCardId=ta-next; blockers=#29829:ta-first';
    let childRunId = '';
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-pr-ledger-evidence', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const manifest = JSON.parse(input);
        if (manifest.kind === 'Job') childRunId = manifest.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('logs')) {
        const terminal = JSON.stringify({ stage: 'error', ok: false, error: terminalError });
        const ledger = JSON.stringify({ runId: childRunId, event: 'pr-open-failed', data: { error: ledgerError } }) + '\n';
        const full = `ELANOUS_RUN_LEDGER ${childRunId} 1/1 ${gzipSync(ledger).toString('base64')}\n${terminal}`;
        return { status: 0, stdout: args.includes('--tail=400') ? terminal : full, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      process.env.ELANOUS_STATE_DIR = root;
      const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS,
        env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'pr-ledger-evidence' }).done;
      const prFailure = { stage: 'pr-open-failed', source: 'terminal-result', errorTail: 'self-implement PR guard 실패: same-cell' };
      expect(finished[0]).toMatchObject({ prFailureStage: 'pr-open-failed', prFailureSource: 'terminal-result' });
      expect(finished[0]).not.toHaveProperty('blockingPrNumber');
      expect(finished[0]).not.toHaveProperty('candidateCardId');
      expect(finished[0]).toMatchObject({ ledgerCompleteness: 'complete' });
      expect(loadRunLedger(childRunId, runLedgerDir(root))?.find((entry) => entry.event === 'pr-open-failed')?.data).toMatchObject({ error: ledgerError });
      expect(loadRunLedger(parent, runLedgerDir(root))?.find((entry) => entry.event === 'pod-child-evidence')?.data)
        .toMatchObject({ childEvidence: { prFailure } });
      recordClassifiedHarnessPodExit(parent, 'pod-failure', result.exitCode ?? 1, { output: result.output });
      expect(readRunExits(root)).toMatchObject([{ runId: parent, childEvidence: { prFailure } }]);
    } finally {
      off();
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a prior PR ledger row does not attach to a different terminal failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-pr-stale-ledger-'));
    let childRunId = '';
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-pr-stale-ledger', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const manifest = JSON.parse(input);
        if (manifest.kind === 'Job') childRunId = manifest.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('logs')) {
        const terminal = JSON.stringify({ stage: 'error', ok: false, error: 'implementation failed after PR rework' });
        const ledger = JSON.stringify({ runId: childRunId, event: 'pr-open-failed', data: { error: 'candidateCardId=ta-old; blockers=#29829:ta-old' } }) + '\n';
        const full = `ELANOUS_RUN_LEDGER ${childRunId} 1/1 ${gzipSync(ledger).toString('base64')}\n${terminal}`;
        return { status: 0, stdout: args.includes('--tail=400') ? terminal : full, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'pr-stale-ledger' }).done;
      expect(finished[0]).not.toHaveProperty('prFailureStage');
      expect(finished[0]).not.toHaveProperty('blockingPrNumber');
    } finally { off(); rmSync(root, { recursive: true, force: true }); }
  });

  test('current terminal blocker IDs take precedence over an older PR ledger row', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-pr-new-terminal-'));
    const parent = 'run-parent-pr-new-terminal';
    const previousState = process.env.ELANOUS_STATE_DIR;
    let childRunId = '';
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-pr-new-terminal', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const manifest = JSON.parse(input);
        if (manifest.kind === 'Job') childRunId = manifest.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('logs')) {
        const terminal = JSON.stringify({ stage: 'error', ok: false,
          error: 'draft PR 생성 실패\nself-implement PR guard 실패: same-cell; candidateCardId=ta-new; blockers=#30000:ta-new' });
        const ledger = JSON.stringify({ runId: childRunId, event: 'pr-open-failed',
          data: { error: 'self-implement PR guard 실패: same-cell; candidateCardId=ta-old; blockers=#29829:ta-old' } }) + '\n';
        const full = `ELANOUS_RUN_LEDGER ${childRunId} 1/1 ${gzipSync(ledger).toString('base64')}\n${terminal}`;
        return { status: 0, stdout: args.includes('--tail=400') ? terminal : full, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      process.env.ELANOUS_STATE_DIR = root;
      const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS,
        env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'pr-new-terminal' }).done;
      expect(finished[0]).toMatchObject({ prFailureSource: 'terminal-result', blockingPrNumber: 30000,
        candidateCardId: 'ta-new', blockingCardId: 'ta-new' });
      recordClassifiedHarnessPodExit(parent, 'pod-failure', result.exitCode ?? 1, { output: result.output });
      expect(readRunExits(root)).toMatchObject([{ runId: parent, childEvidence: { prFailure: {
        blockingPrNumber: 30000, candidateCardId: 'ta-new', blockingCardId: 'ta-new',
      } } }]);
    } finally {
      off();
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Pod result path uses the latest nested child disposition and preserves a later nested success', async () => {
    const old = JSON.stringify({ kind: 'self', ok: false, result: { stage: 'aborted', ok: false, outOfScopeEdits: ['old.ts'] } });
    const failure = JSON.stringify({ kind: 'self', ok: false, result: { stage: 'soft-stopped', ok: false,
      outOfScopeEdits: ['current.ts'], scopeStopReasons: ['deletion'], abandonedClassification: { classification: 'implementation-deficit' } } });
    const success = JSON.stringify({ kind: 'external', ok: true, result: { stage: 'merged', ok: true, prUrl: 'https://example.invalid/pr/1', merged: true } });
    const failed = await podSelfImplementSpawn({ kubectl: fakeKubectl(['Failed'], `${old}\n${failure}\n`).k,
      credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'nested-child-failure' }).done;
    expect(failed.exitCode).toBe(1);
    expect(failed.disposition).toMatchObject({ stage: 'soft-stopped', ok: false,
      failureClassification: 'implementation-deficit', childEvidence: { classification: 'scope-escape', outOfScopeEdits: ['current.ts'] } });
    expect(failed.disposition?.childEvidence?.outOfScopeEdits).not.toContain('old.ts');
    const malformed = JSON.stringify({ kind: 'self', stage: 'merged', ok: true, result: {} });
    const malformedTail = await podSelfImplementSpawn({ kubectl: fakeKubectl(['Failed'], `${old}\n${failure}\n${malformed}\n`).k,
      credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'nested-child-malformed' }).done;
    expect(malformedTail.disposition).toMatchObject({ stage: 'soft-stopped', ok: false, failureClassification: 'implementation-deficit',
      childEvidence: { outOfScopeEdits: ['current.ts'] } });
    const succeeded = await podSelfImplementSpawn({ kubectl: fakeKubectl(['Complete'], `${old}\n${success}\n`).k,
      credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'nested-child-success' }).done;
    expect(succeeded.exitCode).toBe(0);
    expect(succeeded.disposition).toMatchObject({ stage: 'merged', ok: true, prUrl: 'https://example.invalid/pr/1', merged: true });
    expect(succeeded.disposition?.childEvidence).toBeUndefined();
  });

  test('a later failed Pod without child JSON masks an earlier attempt on the same parent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-child-evidence-mask-'));
    const parent = 'run-parent-evidence-mask';
    const first = fakeKubectl(['Failed'], '{"stage":"soft-stopped","ok":false,"outOfScopeEdits":["src/other.ts"],"scopeStopReasons":["deletion"]}\n');
    const second = fakeKubectl(['Failed'], 'child exited before terminal JSON\n');
    try {
      await podSelfImplementSpawn({ kubectl: first.k, credentials: CREDS,
        env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'evidence-first' }).done;
      await podSelfImplementSpawn({ kubectl: second.k, credentials: CREDS,
        env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'evidence-second' }).done;
      const markers = loadRunLedger(parent, runLedgerDir(root))?.filter((entry) => entry.event === 'pod-child-evidence') ?? [];
      expect(markers).toHaveLength(2);
      expect(markers[0]?.data.childEvidence).toMatchObject({ scopeEscape: true });
      expect(markers[1]?.data.childEvidence).toMatchObject({ logTail: ['child exited before terminal JSON'], logTailLines: 1 });
      expect(markers[1]?.data.childEvidence).not.toHaveProperty('scopeEscape');
      expect(markers[1]?.data.job).not.toBe(markers[0]?.data.job);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('live follower tracks the child rather than an existing parent and full collection replaces its partial copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-live-child-'));
    const parent = 'run-parent-1';
    const dir = runLedgerDir(root);
    appendRunLedgerEntry({ runId: parent, event: 'parent-start', data: {} }, dir);
    let child = '';
    let polls = 0;
    const execScripts: string[] = [];
    const full = '{"event":"child-start"}\n{"event":"child-done"}\n';
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const m = JSON.parse(input);
        if (m.kind === 'Job') child = m.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('get') && args.includes('job') && args.some((a) => a.includes('status.conditions[*].type'))) return { status: 0, stdout: ++polls < 2 ? '' : 'Complete', stderr: '' };
      if (args.includes('exec')) {
        execScripts.push(args.at(-1)!);
        return { status: 0, stdout: '{"event":"child-start"}\n', stderr: '' };
      }
      if (args.includes('logs')) return { status: 0, stdout: `ELANOUS_RUN_LEDGER ${child} 1/1 ${gzipSync(full).toString('base64')}\n{"stage":"merged","ok":true}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root }, sleep: async () => {} })({ feature: 'x', spaceId: 'live-child' }).done;
      expect(execScripts).toHaveLength(1);
      expect(execScripts[0]).toContain(`/run-ledger/${child}.jsonl`);
      expect(execScripts[0]).not.toContain(`/run-ledger/${parent}.jsonl`);
      expect(readFileSync(runLedgerPath(child, dir), 'utf8')).toBe(full);
      expect(readFileSync(runLedgerPath(parent, dir), 'utf8')).toContain('parent-start');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('failed Pod with a partial ledger marks incomplete and records its result on the host goal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-partial-ledger-'));
    const previous = process.cwd();
    const goal = 'GOAL.md';
    let child = '';
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-partial-ledger-test', emit: (record) => { if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>); } });
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const m = JSON.parse(input);
        if (m.kind === 'Job') child = m.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: args.includes('--tail=400') ? '{"stage":"gate-failed","ok":false}\n' : `ELANOUS_RUN_LEDGER ${child} 1/3 ${gzipSync('partial').toString('base64')}\nELANOUS_RUN_LEDGER ${child} 2/3 AAAA\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(root, goal), '# Goal\n');
      process.chdir(root);
      const r = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root, ELANOUS_POD_GOAL_DOC: goal } })({ feature: 'x', spaceId: 'partial-goal' }).done;
      expect(r.exitCode).toBe(1);
      expect(readFileSync(runLedgerPath(child, runLedgerDir(root)), 'utf8')).toContain('"event":"pod-ledger-incomplete"');
      expect(finished).toContainEqual(expect.objectContaining({ childRunId: child, ledgerCompleteness: 'incomplete' }));
      const hostGoal = readFileSync(join(root, goal), 'utf8');
      expect(hostGoal).toContain('## 실행 기록');
      expect(hostGoal).toContain(`- runId: ${child}`);
      expect(hostGoal).toContain('stage: gate-failed');
      expect(hostGoal).toContain('outcome: abandoned');
      expect(hostGoal).toContain('ok: false');
    } finally { process.chdir(previous); off(); rmSync(root, { recursive: true, force: true }); }
  });

  test('another run failing collection does not mark a fully collected child ledger incomplete', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-other-ledger-failure-'));
    const dir = runLedgerDir(root);
    const other = 'run-other-1';
    appendRunLedgerEntry({ runId: other, event: 'host-start', data: {} }, dir);
    const before = readFileSync(runLedgerPath(other, dir), 'utf8');
    let child = '';
    const finished: Array<Record<string, unknown>> = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'pod-other-ledger-failure-test', emit: (record) => {
      if (record.category !== 'self-implement.pod') return;
      if (record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
      if (record.event.startsWith('ledger-collect-') || record.event === 'ledger-collected') events.push({ event: record.event, data: record.data as Record<string, unknown> });
    } });
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const m = JSON.parse(input);
        if (m.kind === 'Job') child = m.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: [
        `ELANOUS_RUN_LEDGER ${child} 1/1 ${gzipSync('{"event":"child"}\n').toString('base64')}`,
        `ELANOUS_RUN_LEDGER ${other} 1/1 ${gzipSync('other\n').toString('base64')}`,
        'ELANOUS_RUN_LEDGER run-broken-1 1/2 AAAA',
        '{"stage":"merged","ok":true}',
      ].join('\n'), stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'other-ledger-failure' }).done;
      expect(result.exitCode).toBe(0);
      expect(events).toContainEqual(expect.objectContaining({ event: 'ledger-collect-incomplete', data: expect.objectContaining({ runId: 'run-broken-1', reason: 'missing chunk' }) }));
      expect(events).toContainEqual(expect.objectContaining({ event: 'ledger-collect-skipped', data: expect.objectContaining({ runId: other, reason: 'exists' }) }));
      expect(events).toContainEqual(expect.objectContaining({ event: 'ledger-collected', data: expect.objectContaining({ runId: child }) }));
      expect(readFileSync(runLedgerPath(other, dir), 'utf8')).toBe(before);
      expect(readFileSync(runLedgerPath(child, dir), 'utf8')).toBe('{"event":"child"}\n');
      expect(finished).toContainEqual(expect.objectContaining({ childRunId: child, ledgerCompleteness: 'complete' }));
    } finally { off(); rmSync(root, { recursive: true, force: true }); }
  });

  test('artifact recovery failure does not mark a fully collected child ledger incomplete', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-artifact-ledger-separation-'));
    let child = '';
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-artifact-ledger-separation-test', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const m = JSON.parse(input);
        if (m.kind === 'Job') child = m.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) {
        return { status: 0, stdout: `ELANOUS_RUN_LEDGER ${child} 1/1 ${gzipSync('{"event":"child"}\n').toString('base64')}\nELANOUS_POD_ARTIFACT ${Buffer.from('broken.txt').toString('base64url')} 1/2 ${gzipSync('partial').toString('base64')}\n{"stage":"merged","ok":true}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'artifact-ledger-separation' }).done;
      expect(finished).toContainEqual(expect.objectContaining({ childRunId: child, ledgerCompleteness: 'complete' }));
      expect(readFileSync(runLedgerPath(child, runLedgerDir(root)), 'utf8')).toBe('{"event":"child"}\n');
    } finally { off(); rmSync(root, { recursive: true, force: true }); }
  });

  test('failed Job cannot turn a successful logged result into a successful host goal record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-failed-success-log-'));
    const previous = process.cwd();
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(root, 'GOAL.md'), '# Goal\n');
      process.chdir(root);
      const { k } = fakeKubectl(['Failed'], '{"stage":"merged","merged":true,"ok":true}\n');
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_STATE_DIR: root, ELANOUS_POD_GOAL_DOC: 'GOAL.md' } })({ feature: 'x', spaceId: 'failed-success-log' }).done;
      expect(result.exitCode).toBe(1);
      expect(readFileSync(join(root, 'GOAL.md'), 'utf8')).toMatch(/outcome: abandoned\n  ok: false/);
    } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('a failed Pod without a child ledger creates an incomplete marker and an aborted host goal record once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-no-result-'));
    const previous = process.cwd();
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-no-result-test', emit: (record) => { if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>); } });
    let child = '';
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const m = JSON.parse(input);
        if (m.kind === 'Job') child = m.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: 'pod crashed before a result', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(root, 'GOAL.md'), '# Goal\n');
      process.chdir(root);
      const opts = { kubectl, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: 'GOAL.md', ELANOUS_STATE_DIR: root } };
      await podSelfImplementSpawn(opts)({ feature: 'x', spaceId: 'no-result' }).done;
      expect(finished).toContainEqual(expect.objectContaining({ childRunId: child, ledgerCompleteness: 'missing' }));
      expect(JSON.parse(readFileSync(runLedgerPath(child, runLedgerDir(root)), 'utf8'))).toMatchObject({ runId: child, event: 'pod-ledger-incomplete', data: { reason: 'child-ledger-missing' } });
      const goalFile = join(root, 'GOAL.md');
      expect(readFileSync(goalFile, 'utf8')).toContain(`- runId: ${child}\n  stage: aborted\n  outcome: pod-no-result\n  ok: false`);
    } finally { process.chdir(previous); off(); rmSync(root, { recursive: true, force: true }); }
  });

  test('completed Job collects full-log ledger at the host while preserving tail disposition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-full-logs-'));
    const id = 'run-child-1';
    const hostDir = runLedgerDir(root);
    const oldState = process.env.ELANOUS_STATE_DIR;
    const finished: Array<Record<string, unknown>> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement.pod' && event === 'job-finished') finished.push(data ?? {});
    }) as typeof debug.log);
    process.env.ELANOUS_STATE_DIR = root;
    try {
      const child = mkdtempSync(join(tmpdir(), 'pod-child-'));
      let contents: string;
      try {
        appendRunLedgerEntry({ runId: id, event: 'start', data: { origin: { podName: 'job-x-abcde' } } }, runLedgerDir(child));
        contents = readFileSync(runLedgerPath(id, runLedgerDir(child)), 'utf8');
      } finally { rmSync(child, { recursive: true, force: true }); }
      const line = `ELANOUS_RUN_LEDGER ${id} 1/1 ${gzipSync(contents).toString('base64')}`;
      const json = '{"stage":"merged","ok":true,"runId":"run-child-1"}';
      const calls: string[][] = [];
      const kubectl: Kubectl = (args) => {
        calls.push([...args]);
        if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
        if (args.includes('get')) return { status: 0, stdout: 'Complete', stderr: '' };
        if (args.includes('logs')) return { status: 0, stdout: args.includes('--tail=400') ? `${json}\n` : `${line}\n${json}\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 's' }).done;
      expect(result.exitCode).toBe(0);
      expect(result.disposition?.stage).toBe('merged');
      expect(result.disposition?.runId).toBe(id);
      expect(result.disposition?.childRunId).toBe(id);
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({ state: 'complete', stage: 'merged', childRunId: expect.stringMatching(/^run-[0-9a-f-]{36}$/), ledgerCompleteness: 'missing' });
      expect(readFileSync(runLedgerPath(id, hostDir), 'utf8')).toBe(contents);
      expect(calls.filter((args) => args.includes('logs'))).toHaveLength(2);
    } finally {
      logSpy.mockRestore();
      if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = oldState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('completed Job fetches full logs without --tail; collection failure leaves disposition unchanged', async () => {
    const json = JSON.stringify({ stage: 'pr-opened', ok: true });
    const calls: string[][] = [];
    const kubectl: Kubectl = (args) => {
      calls.push([...args]);
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('get')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs') && !args.includes('--tail=400')) return { status: 1, stdout: '', stderr: 'log fetch unavailable' };
      if (args.includes('logs')) return { status: 0, stdout: `${json}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 's' }).done;
    expect(result.exitCode).toBe(0);
    expect(result.disposition?.stage).toBe('pr-opened');
    const logCalls = calls.filter((args) => args.includes('logs'));
    expect(logCalls).toHaveLength(2);
    expect(logCalls[0]).toContain('--tail=400');
    expect(logCalls[1]).not.toContain('--tail=400');
  });

  test('every Job carries the isolation gate init container', () => {
    const m = podJobManifest({ name: 'n', namespace: 'elanous-test', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { initContainers: Array<{ name: string }> } } } };
    expect(m.spec.template.spec.initContainers[0]!.name).toBe('isolation-gate');
  });

  // 델타(대표 2026-09-26): 레지스트리 이미지는 노드가 pull 해야 한다 — Never 면 없는 층을 못 받아 ErrImageNeverPull.
  test('registry image pulls IfNotPresent; imported image stays Never', () => {
    type M = { spec: { template: { spec: { initContainers: Array<{ imagePullPolicy: string }>; containers: Array<{ image: string; imagePullPolicy: string }> } } } };
    const reg = podJobManifest({ name: 'n', namespace: 'elanous-test', image: 'k3d-elanous-registry:5050/elanous-harness:abc', imagePullPolicy: 'IfNotPresent', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as M;
    expect(reg.spec.template.spec.containers[0]!.imagePullPolicy).toBe('IfNotPresent');
    expect(reg.spec.template.spec.initContainers[0]!.imagePullPolicy).toBe('IfNotPresent');
    const local = podJobManifest({ name: 'n', namespace: 'elanous-test', image: 'elanous-harness:local', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as M;
    expect(local.spec.template.spec.containers[0]!.imagePullPolicy).toBe('Never');
  });
});

// RFC F2 — Pod 의 토큰·비용 rollup 한 줄 → 호스트 llm-usage 재방출.
import { podUsageMissingReason, podUsageReemitPlan, reemitPodUsage, podSigtermTrapScript, POD_USAGE_PARTIAL_SEQ_FILE } from './self-implement-pod.js';
import { rollup, renderRollupLine } from '../../../scripts/usage-rollup.js';

describe('pod usage rollup — round 2 must-fix', () => {
  const collect = () => { const rows: Array<{ c: string; e: string; d: Record<string, unknown> }> = []; return { rows, log: (c: string, e: string, d: Record<string, unknown>) => rows.push({ c, e, d }) }; };
  const usageRows = (rows: Array<{ c: string; e: string; d: Record<string, unknown> }>) => rows.filter((x) => x.c === 'llm.usage');
  const rollupRow = { site: 'agent-turn', provider: 'openai', model: 'gpt-6-sol', calls: 3, inputTokens: 300, outputTokens: 30, cacheReadInputTokens: 0, usdKnown: 0.3, unknownCostCalls: 0 };

  // MF-864bb316 — 송신(scripts/usage-rollup.ts renderRollupLine)과 수신(reemitPodUsage 파서)이 «같은» PARTIAL 포맷을
  // 쓰는지를 한쪽이 다른 쪽의 산출을 실제로 읽어 증명한다(포맷이 갈리면 폴백 파싱이 허수가 된다).
  test('renderRollupLine 이 낸 PARTIAL 줄을 reemitPodUsage 파서가 그대로 읽는다', () => {
    const line = renderRollupLine({ measured: true, truncated: false, runId: 'run-fmt', rows: [rollupRow] }, { partial: true, seq: 7 });
    expect(line.startsWith('ELANOUS_USAGE_ROLLUP_PARTIAL ')).toBe(true);
    const { rows, log } = collect();
    expect(reemitPodUsage(`noise\n${line}\n`, 'si-fmt', log)).toBe(1);
    const usage = usageRows(rows);
    expect(usage.length).toBe(1);
    expect(usage[0]!.d).toMatchObject({ site: 'pod-rollup:agent-turn', partial: true, partialSeq: 7, podRunId: 'run-fmt', calls: 3 });
  });

  // MF-3c0d253e — abort 경로의 PARTIAL 재방출 ⊕ 다른 경로(최종) 재방출이 만나도 rollup 은 같은 Pod 버킷을 한 번만 센다.
  test('같은 Pod 의 PARTIAL ⊕ 최종 재방출이 만나도 rollup 은 한 번만 센다(podRollupKey dedup)', () => {
    const partialLine = renderRollupLine({ measured: true, truncated: false, runId: 'run-dup', rows: [rollupRow] }, { partial: true, seq: 5 });
    const finalLine = renderRollupLine({ measured: true, truncated: false, runId: 'run-dup', rows: [rollupRow] }, { partial: false, seq: 1 });
    const a = collect(); reemitPodUsage(partialLine, 'si-dup', a.log);
    const b = collect(); reemitPodUsage(finalLine, 'si-dup', b.log);
    const lines = [...usageRows(a.rows), ...usageRows(b.rows)].map((x) => JSON.stringify({ event: 'llm-usage', data: x.d }));
    const r = rollup(lines).rows.find((x) => x.site === 'pod-rollup:agent-turn');
    expect(r?.calls).toBe(1);
  });

  // MF-3c0d253e 하위호환 — podRollupKey 없는 기존 llm-usage 행은 종전대로 행마다 센다(원장 형식 불변).
  test('podRollupKey 없는 기존 llm-usage 행은 dedup 되지 않는다', () => {
    const d = { site: 'agent-turn', provider: 'openai', model: 'gpt-6-sol', inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const r = rollup([JSON.stringify({ event: 'llm-usage', data: d }), JSON.stringify({ event: 'llm-usage', data: d })]);
    expect(r.rows[0]!.calls).toBe(2);
  });

  // MF-d3b5a70f 실물 시그널 경로 — TERM 이 wait 를 즉시 끊고 trap 이 롤업을 쏜 뒤 rc 143 을 보존한다.
  // 합성 exitCode:143 입력이 아니라 진짜 신호로 잰다(foreground 였다면 trap 은 300s 뒤에나 발화한다).
  test('실물 시그널: TERM 이 wait 를 즉시 끊고 trap 이 롤업을 쏜 뒤 exit 143 을 보존한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-sigterm-'));
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'usage-rollup.ts'), 'console.log("TRAP_ROLLUP_FIRED");\n');
    const script = ['set -u', 'si_pid=""', podSigtermTrapScript(), 'sleep 300 >/dev/null 2>&1 & si_pid=$!', 'wait "$si_pid"; rc=$?', 'exit $rc'].join('\n');
    const proc = Bun.spawn(['bash', '-c', script], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const t0 = Date.now();
    proc.kill();                                  // SIGTERM — kubectl delete job 이 Pod 에 보내는 것과 같은 신호
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(143);                       // (b) trap 이 TERM 기본 종료를 삼키지 않는다(137 이 아니라 143)
    expect(out).toContain('TRAP_ROLLUP_FIRED');   // trap 이 롤업을 실제로 쐈다 — grace 안에 발화했다
    expect(Date.now() - t0).toBeLessThan(30_000); // (a) wait 가 trap 에 즉시 끊겼다(grace 스케일 안에 종료)
  }, 25_000);
});

// ⭐ METER-POD-ROLLUP-GAP-2 — trap PARTIAL 의 seq 전달 ⊕ 재시도 Pod 가 같은 job·runId 를 써도 접히지 않는 키.
describe('pod usage rollup — gap 2 (trap seq · attempt key)', () => {
  const collect = () => { const rows: Array<{ c: string; e: string; d: Record<string, unknown> }> = []; return { rows, log: (c: string, e: string, d: Record<string, unknown>) => rows.push({ c, e, d }) }; };
  const MODEL = tierModel('balanced', 'openai');
  const bucket = { site: 'agent-turn', provider: 'openai', model: MODEL, calls: 3, inputTokens: 300, outputTokens: 30, cacheReadInputTokens: 0, usdKnown: 0.3, unknownCostCalls: 0 };
  const fakeRollupDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-gap2-'));
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'usage-rollup.ts'), 'console.log("ROLLUP_ARGS " + process.argv.slice(2).join(" "));\n');
    return dir;
  };
  const sigterm = async (dir: string, script: string, waitMs: number) => {
    // 표본기 간격 0분 — 긴 `sleep` 자식이 stdout 파이프를 붙잡지 않게(실물 Pod 에선 trap 의 exit 로 컨테이너가 같이 끝난다).
    const proc = Bun.spawn(['bash', '-c', script], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ELANOUS_USAGE_PARTIAL_MINUTES: '0' } });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    proc.kill();
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return { code, out };
  };

  test('partial rollup: real sampler + real SIGTERM — the trap PARTIAL carries the sampler seq + 1 (so it is the most complete)', async () => {
    const dir = fakeRollupDir();
    const seqFile = join(dir, 'seq');
    const manifest = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
    const sampler = manifest.spec.template.spec.containers[0]!.args[0]!.split('\n').find((line) => line.startsWith('(usage_partial_seq=0;'))!.replaceAll(POD_USAGE_PARTIAL_SEQ_FILE, seqFile);
    const script = ['set -u', 'si_pid=""', sampler, podSigtermTrapScript(seqFile), 'sleep 300 >/dev/null 2>&1 & si_pid=$!', 'wait "$si_pid"; rc=$?', 'exit $rc'].join('\n');
    const { code, out } = await sigterm(dir, script, 2500);
    expect(code).toBe(143);
    expect(out).not.toMatch(/--partial(?! --seq)/);                        // seq 없는 PARTIAL 은 더는 없다
    const seqs = [...out.matchAll(/ROLLUP_ARGS --since 12h --partial --seq (\d+)/g)].map((m) => Number(m[1]));
    expect(seqs).toContain(1);                                             // 표본기가 실제로 돌았다
    const max = Math.max(...seqs);
    expect(max).toBeGreaterThan(1);
    expect(seqs.filter((n) => n === max)).toHaveLength(1);                 // 가장 큰 seq 는 하나 = trap(표본기 seq + 1) — 표본기를 먼저 끊었다
  }, 25_000);

  test('partial rollup: trap seq falls back to 1 when the seq file is missing or not a number (rc 143 kept)', async () => {
    for (const content of [null, 'garbage', '08']) {
      const dir = fakeRollupDir();
      const seqFile = join(dir, 'seq');
      if (content !== null) writeFileSync(seqFile, `${content}\n`);
      const script = ['set -u', 'si_pid=""', podSigtermTrapScript(seqFile), 'sleep 300 >/dev/null 2>&1 & si_pid=$!', 'wait "$si_pid"; rc=$?', 'exit $rc'].join('\n');
      const { code, out } = await sigterm(dir, script, 600);
      expect(code).toBe(143);
      expect(out).toContain(`ROLLUP_ARGS --since 12h --partial --seq ${content === '08' ? 9 : 1}`);
    }
  }, 25_000);

  test('partial rollup: a usage-limit/gh-login retry (same job · same runId · new Pod) is not folded into the first attempt; partial ⊕ final of one Pod still is', () => {
    const line = (podName: string, partial: boolean, seq = 1) => renderRollupLine({ measured: true, truncated: false, runId: 'run-retry', podName, rows: [bucket] }, { partial, seq });
    const emit = (logs: string) => { const c = collect(); reemitPodUsage(logs, 'si-retry', c.log); return c.rows.filter((x) => x.c === 'llm.usage').map((x) => JSON.stringify({ event: 'llm-usage', data: x.d })); };
    const attempts = [...emit(line('si-retry-aaaaa', true, 3)), ...emit(line('si-retry-bbbbb', false))];
    expect(rollup(attempts).rows.find((x) => x.site === 'pod-rollup:agent-turn')?.calls).toBe(2);
    const onePod = [...emit(line('si-retry-aaaaa', true, 3)), ...emit(line('si-retry-aaaaa', false))];
    expect(rollup(onePod).rows.find((x) => x.site === 'pod-rollup:agent-turn')?.calls).toBe(1);
  });
});

// ⭐ METER-POD-ROLLUP-GAP-3 — 런 «도중» 호스트가 쥔 PARTIAL ⊕ 결손 행의 종료 사유(10-12 canary run-4c6a70b1: Pod 삭제 뒤 PARTIAL 유실).
describe('pod usage rollup — gap 3 (live PARTIAL capture · missing exit reason)', () => {
  const collect = () => { const rows: Array<{ c: string; e: string; d: Record<string, unknown> }> = []; return { rows, log: (c: string, e: string, d: Record<string, unknown>) => rows.push({ c, e, d }) }; };
  const MODEL = tierModel('balanced', 'openai');
  const bucket = { site: 'agent-turn', provider: 'openai', model: MODEL, calls: 4, inputTokens: 400, outputTokens: 40, cacheReadInputTokens: 0, usdKnown: 0.4, unknownCostCalls: 0 };
  const partial = (seq: number) => renderRollupLine({ measured: true, truncated: false, runId: 'run-live', podName: 'si-live-aaaaa', rows: [bucket] }, { partial: true, seq });

  test('a PARTIAL seen during the run is re-emitted when the Pod\'s final logs are gone', () => {
    const { rows, log } = collect();
    expect(reemitPodUsage('', 'si-live', log, undefined, { reason: 'logs-unavailable', runId: 'run-live', livePartialLine: partial(3) })).toBe(1);
    const usage = rows.filter((x) => x.c === 'llm.usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]!.d).toMatchObject({ site: 'pod-rollup:agent-turn', model: MODEL, calls: 4, partial: true, partialSeq: 3, partialSource: 'live-capture', podRunId: 'run-live' });
    expect(rows.some((x) => x.e === 'usage-rollup-missing')).toBe(false);
    expect(rows.find((x) => x.e === 'usage-rollup')?.d).toMatchObject({ partial: true, seq: 3, partialSource: 'live-capture' });
  });

  test('end-of-run lines still win over the live capture (final > PARTIAL in logs > live PARTIAL)', () => {
    const finalLine = renderRollupLine({ measured: true, truncated: false, runId: 'run-live', podName: 'si-live-aaaaa', rows: [bucket] }, { partial: false, seq: 1 });
    const a = collect(); reemitPodUsage(finalLine, 'si-live', a.log, undefined, { reason: 'stopped', livePartialLine: partial(2) });
    expect(a.rows.find((x) => x.c === 'llm.usage')?.d.partial).toBeUndefined();
    const b = collect(); reemitPodUsage(partial(5), 'si-live', b.log, undefined, { reason: 'stopped', livePartialLine: partial(2) });
    expect(b.rows.find((x) => x.c === 'llm.usage')?.d).toMatchObject({ partial: true, partialSeq: 5 });
    expect(b.rows.find((x) => x.c === 'llm.usage')?.d.partialSource).toBeUndefined();
  });

  test('missing row carries the exit reason (and the closed Pod exit class when known)', () => {
    const { rows, log } = collect();
    expect(reemitPodUsage('', 'si-gone', log, undefined, { reason: 'sigterm-143', runId: 'run-gone', podExitClass: 'no-result-line', livePartialLine: 'not a partial line' })).toBe(0);
    expect(rows.find((x) => x.e === 'usage-rollup-missing')?.d).toEqual({ job: 'si-gone', reason: 'sigterm-143', podExitClass: 'no-result-line', runId: 'run-gone' });
    expect(rows.find((x) => x.c === 'llm.usage')?.d).toMatchObject({ site: 'pod-rollup:missing', measured: false, reason: 'sigterm-143', podExitClass: 'no-result-line', runId: 'run-gone', podRollupKey: 'run-gone|missing' });
  });

  test('podUsageReemitPlan (pure, no kubectl): Pod killed by SIGTERM after a PARTIAL — live PARTIAL re-emitted; without it the missing row carries reason ⊕ podExitClass', () => {
    const exit = { state: 'failed' as const, failedReason: 'BackoffLimitExceeded', containerReason: 'Error', containerExitCode: 143 };
    const live = podUsageReemitPlan({ job: 'si-sim', runId: 'run-sim', logs: '', livePartialLine: partial(4), exit });
    expect(live.source).toBe('partial-live');
    expect(live.rows.find((r) => r.category === 'llm.usage')?.data).toMatchObject({ site: 'pod-rollup:agent-turn', partial: true, partialSeq: 4, partialSource: 'live-capture' });
    const gone = podUsageReemitPlan({ job: 'si-sim', runId: 'run-sim', logs: 'child started\n', livePartialLine: null, exit });
    expect(gone.source).toBe('missing');
    expect(gone.rows.find((r) => r.category === 'llm.usage')?.data).toMatchObject({ site: 'pod-rollup:missing', measured: false, reason: 'sigterm-143', podExitClass: 'no-result-line', runId: 'run-sim' });
    expect(gone.rows.find((r) => r.event === 'usage-rollup-missing')?.data).toMatchObject({ reason: 'sigterm-143', podExitClass: 'no-result-line' });
    // 로그도 사라졌으면 사유는 logs-unavailable · 완료/abort 는 분류를 싣지 않는다.
    expect(podUsageReemitPlan({ job: 'j', logs: '', exit }).rows.find((r) => r.category === 'llm.usage')?.data.reason).toBe('logs-unavailable');
    expect(podUsageReemitPlan({ job: 'j', logs: 'x\n', exit: { state: 'aborted' } }).rows.find((r) => r.category === 'llm.usage')?.data.podExitClass).toBeUndefined();
    expect(podUsageReemitPlan({ job: 'j', logs: partial(9), exit: { state: 'complete' } }).source).toBe('partial-log');
    expect(podUsageReemitPlan({ job: 'j', logs: renderRollupLine({ measured: true, truncated: false, runId: 'r', rows: [bucket] }, { partial: false, seq: 1 }), exit: { state: 'complete' } }).source).toBe('final');
  });

  test('host poll loop: the PARTIAL captured mid-run is re-emitted after the Pod (and its logs) disappear; missing row is not written', async () => {
    const usage: Array<Record<string, unknown>> = [];
    const pod: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'gap3-live-capture', emit: (record) => {
      if (record.category === 'llm.usage' && record.event === 'llm-usage') usage.push(record.data as Record<string, unknown>);
      if (record.category === 'self-implement.pod' && ['usage-partial-captured', 'usage-rollup-missing'].includes(record.event)) pod.push({ event: record.event, data: record.data as Record<string, unknown> });
    } });
    let polls = 0;
    const sinceCalls: Array<readonly string[]> = [];
    const kubectl: Kubectl = (args) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: 'BackoffLimitExceeded', stderr: '' };
      if (args.includes('get') && args.includes('pods')) return { status: 0, stdout: '', stderr: '' };   // Pod 는 이미 지워졌다
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: polls++ < 3 ? '' : 'Failed', stderr: '' };
      if (args.includes('logs')) {
        // 런 도중(--since 표본)엔 PARTIAL 이 보이고, Job 이 끝난 뒤엔 Pod 가 사라져 로그를 못 읽는다.
        if (args.some((a) => a.startsWith('--since='))) { sinceCalls.push(args); return { status: 0, stdout: `noise\n${partial(sinceCalls.length)}\nmore noise\n`, stderr: '' }; }
        return { status: 1, stdout: '', stderr: 'pods not found' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: {}, sleep: async () => {}, usagePartialCapturePolls: 1 })({ feature: 'x', spaceId: 'gap3-live' }).done;
      expect(sinceCalls.length).toBeGreaterThan(0);
      const rows = usage.filter((d) => d.job === podJobName('gap3-live'));
      expect(rows.some((d) => d.site === 'pod-rollup:missing')).toBe(false);
      expect(rows.find((d) => d.site === 'pod-rollup:agent-turn')).toMatchObject({ partial: true, partialSeq: sinceCalls.length, partialSource: 'live-capture', calls: 4 });
      expect(pod.some((p) => p.event === 'usage-partial-captured')).toBe(true);
      expect(pod.some((p) => p.event === 'usage-rollup-missing')).toBe(false);
    } finally { off(); }
  });

  test('host poll loop: without any PARTIAL, the missing row carries the exit reason of the failed Pod', async () => {
    const usage: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'gap3-missing-reason', emit: (record) => {
      if (record.category === 'llm.usage' && record.event === 'llm-usage') usage.push(record.data as Record<string, unknown>);
    } });
    const kubectl: Kubectl = (args) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: 'BackoffLimitExceeded', stderr: '' };
      if (args.includes('get') && args.includes('pods')) return { status: 0, stdout: '2026-10-12T06:10:00Z\tError\t143\n', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: 'child started\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: {}, sleep: async () => {} })({ feature: 'x', spaceId: 'gap3-missing' }).done;
      expect(usage.find((d) => d.job === podJobName('gap3-missing') && d.site === 'pod-rollup:missing')).toMatchObject({ measured: false, reason: 'sigterm-143', podExitClass: 'no-result-line' });
    } finally { off(); }
  });
});

describe('pod usage rollup', () => {
  test('rollup groups llm-usage rows by site/provider/model and keeps unknown cost separate', () => {
    const rows = [
      JSON.stringify({ event: 'llm-usage', data: { site: 'agent-turn', provider: 'openai', model: 'gpt-6-sol', inputTokens: 100, outputTokens: 5, cost: { kind: 'known', usd: 0.5 } } }),
      JSON.stringify({ event: 'llm-usage', data: { site: 'agent-turn', provider: 'openai', model: 'gpt-6-sol', inputTokens: 50, outputTokens: 1, cost: { kind: 'unknown' } } }),
      JSON.stringify({ event: 'other', data: {} }),
      'elanous logs: result may be truncated (limitReached=true)',
    ];
    const r = rollup(rows);
    expect(r.truncated).toBe(true);
    expect(r.rows).toEqual([{ site: 'agent-turn', provider: 'openai', model: 'gpt-6-sol', calls: 2, inputTokens: 150, outputTokens: 6, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreationUnmeasuredCalls: 0, usdKnown: 0.5, unknownCostCalls: 1, includedCalls: 0, apiEquivalentUsd: 0 }]);
  });
  test('the host re-emits each row as llm-usage with a pod-rollup site; partial cost when some calls were unpriced', () => {
    const out: Array<{ c: string; e: string; d: Record<string, unknown> }> = [];
    const line = `ELANOUS_USAGE_ROLLUP ${JSON.stringify({ measured: true, runId: 'run-9', rows: [{ site: 'agent-turn', provider: 'openai', model: 'gpt-6-sol', calls: 2, inputTokens: 150, outputTokens: 6, cacheReadInputTokens: 0, usdKnown: 0.5, unknownCostCalls: 1 }] })}`;
    expect(reemitPodUsage(`x\n${line}\n{"ok":true}\n`, 'si-1', (c, e, d) => out.push({ c, e, d }))).toBe(1);
    expect(out[0]).toMatchObject({ c: 'llm.usage', e: 'llm-usage', d: { site: 'pod-rollup:agent-turn', inputTokens: 150, substrate: 'pod', job: 'si-1', podRunId: 'run-9', cost: { kind: 'partial', usd: 0.5 } } });
  });
  // ⛔ 캐시 «쓰기» 토큰이 Pod→호스트 사이에서 빠지면 직접 API 팔(anthropic)의 원장이 cacheCreation=0 이 되고
  //   호스트 재매김 $ 가 캐시 쓰기 비용(입력 단가×1.25)을 잃는다(UX 실측 10-11 · cacheRead 3.49M 인데 cacheCreation 0).
  test('cache-write tokens survive pod rollup → host re-emit → host reprice', () => {
    const r = rollup([
      JSON.stringify({ event: 'llm-usage', data: { site: 'stream-llm', provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 30_000, cacheCreationInputTokens: 4_000, cost: { kind: 'unknown' } } }),
      JSON.stringify({ event: 'llm-usage', data: { site: 'stream-llm', provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 34_000, cacheCreationInputTokens: 600, cost: { kind: 'unknown' } } }),
    ]);
    expect(r.rows[0]).toMatchObject({ calls: 2, cacheReadInputTokens: 64_000, cacheCreationInputTokens: 4_600 });
    const out: Array<{ c: string; e: string; d: Record<string, unknown> }> = [];
    const seen: Array<Record<string, unknown>> = [];
    const line = `ELANOUS_USAGE_ROLLUP ${JSON.stringify({ measured: true, rows: r.rows })}`;
    expect(reemitPodUsage(line, 'si-cw', (c, e, d) => out.push({ c, e, d }), (u) => { seen.push(u); return { kind: 'known', usd: 1 }; })).toBe(1);
    expect(out[0]!.d).toMatchObject({ cacheReadInputTokens: 64_000, cacheCreationInputTokens: 4_600 });
    expect(seen[0]).toMatchObject({ cacheReadInputTokens: 64_000, cacheCreationInputTokens: 4_600 });
  });
  test('in-pod llm-usage that reports cache reads but no cache-write field is counted unmeasured and blocks host reprice', () => {
    const r = rollup([
      JSON.stringify({ event: 'llm-usage', data: { site: 's', provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 30_000, cacheCreationInputTokens: 4_000, cost: { kind: 'unknown' } } }),
      JSON.stringify({ event: 'llm-usage', data: { site: 's', provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 34_000, cost: { kind: 'unknown' } } }),
    ]);
    expect(r.rows[0]).toMatchObject({ calls: 2, cacheCreationInputTokens: 4_000, cacheCreationUnmeasuredCalls: 1 });
    const out: Array<Record<string, unknown>> = [];
    let called = 0;
    reemitPodUsage(`ELANOUS_USAGE_ROLLUP ${JSON.stringify({ measured: true, rows: r.rows })}`, 'si-u', (_c, _e, d) => out.push(d), () => { called++; return { kind: 'known', usd: 1 }; });
    expect(called).toBe(0);
    expect(out[0]).toMatchObject({ cacheCreationUnmeasuredCalls: 1, cost: { kind: 'unknown', usd: null } });
  });
  test('an older pod rollup row without the cache-write field is not re-emitted as a measured 0', () => {
    const out: Array<{ c: string; e: string; d: Record<string, unknown> }> = [];
    const line = `ELANOUS_USAGE_ROLLUP ${JSON.stringify({ measured: true, rows: [{ site: 's', provider: 'anthropic', model: 'm', calls: 1, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 5, usdKnown: 0, unknownCostCalls: 1 }] })}`;
    reemitPodUsage(line, 'si-old', (c, e, d) => out.push({ c, e, d }));
    expect('cacheCreationInputTokens' in out[0]!.d).toBe(false);
  });
  test('no rollup line → a named miss, nothing re-emitted', () => {
    const out: string[] = [];
    expect(reemitPodUsage('{"ok":true}', 'si-2', (_c, e) => out.push(e))).toBe(0);
    expect(out).toEqual(['usage-rollup-missing']);
  });

  // ⭐ METER-POD-ROLLUP-GAP — 부분 롤업 폴백·결손 행: 최종 줄이 없어도 사용량이 0 처럼 보이지 않게.
  test('final line present → re-emitted as before with no partial tail', () => {
    const out: Array<{ c: string; e: string; d: Record<string, unknown> }> = [];
    const finalLine = `ELANOUS_USAGE_ROLLUP ${JSON.stringify({ measured: true, runId: 'run-f', rows: [{ site: 'agent-turn', provider: 'openai', model: 'gpt-6-sol', calls: 2, inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, usdKnown: 0.2, unknownCostCalls: 0 }] })}`;
    const partialLine = `ELANOUS_USAGE_ROLLUP_PARTIAL ${JSON.stringify({ partial: true, seq: 3, at: '2026-10-11T00:00:00.000Z', measured: true, rows: [{ site: 'agent-turn', provider: 'openai', model: 'gpt-6-sol', calls: 1, inputTokens: 3, outputTokens: 0, cacheReadInputTokens: 0, usdKnown: 0.1, unknownCostCalls: 0 }] })}`;
    expect(reemitPodUsage(`${partialLine}\n${finalLine}\n`, 'si-f', (c, e, d) => out.push({ c, e, d }))).toBe(1);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ c: 'llm.usage', e: 'llm-usage', d: { site: 'pod-rollup:agent-turn', calls: 2, inputTokens: 10, podRunId: 'run-f' } });
    expect('partial' in out[0]!.d).toBe(false);
    expect(out[1]).toMatchObject({ c: 'self-implement.pod', e: 'usage-rollup', d: { rows: 1, measured: true } });
    expect('partial' in out[1]!.d).toBe(false);
  });
  test('no final line + two partials → the last partial is re-emitted with partial:true and its seq/at', () => {
    const out: Array<{ c: string; e: string; d: Record<string, unknown> }> = [];
    const p1 = `ELANOUS_USAGE_ROLLUP_PARTIAL ${JSON.stringify({ partial: true, seq: 1, at: '2026-10-11T00:05:00.000Z', measured: true, rows: [{ site: 'agent-turn', provider: 'openai', model: 'gpt-6-sol', calls: 1, inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 0, usdKnown: 0.1, unknownCostCalls: 0 }] })}`;
    const p2 = `ELANOUS_USAGE_ROLLUP_PARTIAL ${JSON.stringify({ partial: true, seq: 2, at: '2026-10-11T00:10:00.000Z', measured: true, runId: 'run-p', rows: [{ site: 'agent-turn', provider: 'openai', model: 'gpt-6-sol', calls: 4, inputTokens: 400, outputTokens: 4, cacheReadInputTokens: 0, usdKnown: 0.4, unknownCostCalls: 0 }] })}`;
    expect(reemitPodUsage(`${p1}\n${p2}\n`, 'si-p', (c, e, d) => out.push({ c, e, d }))).toBe(1);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ c: 'llm.usage', e: 'llm-usage', d: { site: 'pod-rollup:agent-turn', calls: 4, inputTokens: 400, partial: true, partialSeq: 2, partialAt: '2026-10-11T00:10:00.000Z', podRunId: 'run-p' } });
    expect(out[1]).toMatchObject({ c: 'self-implement.pod', e: 'usage-rollup', d: { partial: true, seq: 2 } });
  });
  test('neither line + sigterm-143 → exactly one measured:false row named for the exit reason', () => {
    const out: Array<{ c: string; e: string; d: Record<string, unknown> }> = [];
    expect(reemitPodUsage('pod died\n', 'si-143', (c, e, d) => out.push({ c, e, d }), undefined, { reason: 'sigterm-143', runId: 'run-143' })).toBe(0);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ c: 'self-implement.pod', e: 'usage-rollup-missing', d: { job: 'si-143', reason: 'sigterm-143', runId: 'run-143' } });   // METER-POD-ROLLUP-GAP-3 — 결손 이벤트도 사유를 싣는다
    expect(out[1]).toEqual({ c: 'llm.usage', e: 'llm-usage', d: { site: 'pod-rollup:missing', measured: false, reason: 'sigterm-143', job: 'si-143', runId: 'run-143', substrate: 'pod', podRollupKey: 'run-143|missing' } });
  });
  test('podUsageMissingReason maps logs availability, exit codes and job reasons onto the enumeration', () => {
    expect(podUsageMissingReason({ logsAvailable: false, exitCode: 143, failedReason: 'BackoffLimitExceeded' })).toBe('logs-unavailable');
    expect(podUsageMissingReason({ logsAvailable: true, exitCode: 143, failedReason: 'BackoffLimitExceeded' })).toBe('sigterm-143');
    expect(podUsageMissingReason({ logsAvailable: true, exitCode: 1, failedReason: 'BackoffLimitExceeded' })).toBe('backoff-limit');
    expect(podUsageMissingReason({ logsAvailable: true, exitCode: 1, failedReason: 'DeadlineExceeded' })).toBe('deadline');
    expect(podUsageMissingReason({ logsAvailable: true, exitCode: 137, failedReason: 'OOMKilled' })).toBe('oom');
    expect(podUsageMissingReason({ logsAvailable: true, exitCode: 7, failedReason: 'Error' })).toBe('stopped');
    expect(podUsageMissingReason({ logsAvailable: true })).toBe('stopped');
  });
  test('partial rollup sampler + SIGTERM trap live in the Pod script; the final rollup stays the single non-partial line', () => {
    const script = (podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } }).spec.template.spec.containers[0]!.args[0]!;
    const sampler = script.split('\n').find((line) => line.startsWith('(usage_partial_seq=0;'))!;
    expect(sampler).toContain('bun scripts/usage-rollup.ts --since 12h --partial --seq "$usage_partial_seq"');
    expect(sampler).toContain('${ELANOUS_USAGE_PARTIAL_MINUTES:-5} * 60');
    expect(sampler).toContain('sleep "$usage_partial_sleep"');
    expect(sampler).toEndWith('usage_partial_pid=$!');
    const trap = script.split('\n').find((line) => line.startsWith('trap ') && line.includes('usage-rollup.ts'))!;
    expect(trap).toContain('bun scripts/usage-rollup.ts --since 12h --partial');
    expect(trap).toBe(podSigtermTrapScript());
    expect(trap).toContain('exit 143');
    // MF-d3b5a70f — 메인 명령은 백그라운드로 띄우고 wait 로 기다려야 trap 이 grace 안에 발화한다(bash 는 foreground 명령 중 trap 을 미룬다).
    expect(script).toContain('si_pid=""');
    expect(script).toContain('& si_pid=$!');
    expect(script).toContain('wait "$si_pid"; rc=$?');
    // 최종 롤업은 그대로 — 한 번, --partial 없이, 맨 끝 JSON 앞에.
    expect(script).toContain('[ -f scripts/usage-rollup.ts ] && bun scripts/usage-rollup.ts --since 12h || echo');
    expect(script.split('\n').filter((line) => line.includes('usage-rollup.ts --since 12h') && !line.includes('--partial'))).toHaveLength(1);
    // 정리 순서 — 부분 표본기도 mem 표본기 뒤, tail 앞에 죽고 기다린다.
    // (METER-POD-ROLLUP-GAP-2 — trap 도 표본기를 끊으므로 «정리 블록» 쪽 = 마지막 kill 로 잰다.)
    expect(script.lastIndexOf('kill "$usage_partial_pid"')).toBeGreaterThan(script.indexOf('kill "$mem_sampler_pid"'));
    expect(script.indexOf('wait "$usage_partial_pid"')).toBeGreaterThan(script.indexOf('wait "$mem_sampler_pid"'));
    expect(script.indexOf('wait "$usage_partial_pid"')).toBeLessThan(script.lastIndexOf('tail -n 1 /tmp/si.out'));
  });
});

// RFC fleet 슈퍼바이저 §A3·F4 — 벤치 팔.
import { benchArmEnv, benchGoals, benchPodSpawn, parseBenchArms } from './self-implement-pod.js';
import { lookupLlmTierSpec } from '../../model-tier/llm-tier-map.js';
import { resolveEscalateTarget } from '../../self-implement/rework-policy.js';
describe('bench arms', () => {
  test('parses id=provider[:model][@KEY+KEY]', () => {
    expect(parseBenchArms('codex=openai-codex; or-kimi=openrouter:openrouter/moonshotai/kimi-k3@OPENROUTER_API_KEY; claude=anthropic:claude-sonnet-5@ANTHROPIC_API_KEY')).toEqual([
      { id: 'codex', provider: 'openai-codex', model: lookupLlmTierSpec('openai-codex', 'better').model, modelSource: 'ladder', passEnv: [] },
      { id: 'or-kimi', provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3', modelSource: 'explicit', passEnv: ['OPENROUTER_API_KEY'] },
      { id: 'claude', provider: 'anthropic', model: 'claude-sonnet-5', modelSource: 'explicit', passEnv: ['ANTHROPIC_API_KEY'] },
    ]);
  });
  test('rejects a single arm, duplicate ids and malformed parts', () => {
    expect(() => parseBenchArms('a=grok')).toThrow('둘 이상');
    expect(() => parseBenchArms('a=grok;a=openai-codex')).toThrow('겹친다');
    expect(() => parseBenchArms('a grok;b=grok')).toThrow('못 읽는');
  });
  test('goals differ by exactly one label line (A/B rule ②)', () => {
    const arms = parseBenchArms('a=grok;b=openai-codex');
    const [ga, gb] = benchGoals('대상 경로: x.md · 만든다', arms);
    expect(ga!.split('\n').slice(0, -1)).toEqual(gb!.split('\n').slice(0, -1));
    expect(ga).toEndWith('[bench-arm: a]');
    expect(gb).toEndWith('[bench-arm: b]');
  });
  test('each arm pod gets its provider/model/arm id and only its own billing key', async () => {
    const calls: Array<{ args: string; input?: string }> = [];
    const k = ((args: readonly string[], input?: string) => { calls.push({ args: args.join(' '), ...(input ? { input } : {}) }); return { status: 0, stdout: args.includes('current-context') ? 'test-context' : args.includes('get') ? 'Complete' : '', stderr: '' }; });
    const arms = parseBenchArms('codex=openai-codex;or-kimi=openrouter:openrouter/moonshotai/kimi-k3@OPENROUTER_API_KEY');
    const spawn = benchPodSpawn(arms, { kubectl: k, sleep: async () => {}, credentials: CREDS, env: {}, readKeyCache: (n) => (n === 'OPENROUTER_API_KEY' ? 'sk-or-cached' : undefined) });
    const [, gKimi] = benchGoals('g', arms);
    await spawn({ feature: gKimi!, spaceId: 's-kimi' }).done;
    const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
    expect(secret.stringData['env-OPENROUTER_API_KEY']).toBe('sk-or-cached');
    const env = job.spec.template.spec.containers[0].env as Array<{ name: string; value?: string }>;
    expect(env).toContainEqual({ name: 'ELANOUS_LLM_PROVIDER', value: 'openrouter' });
    expect(env).toContainEqual({ name: 'ELANOUS_LLM_MODEL', value: 'openrouter/moonshotai/kimi-k3' });
    expect(env).toContainEqual({ name: 'ELANOUS_ARM_ID', value: 'pod/or-kimi' });
  });
  test('an arm without a model never falls to the legacy provider constant', () => {
    const [claude] = parseBenchArms('claude=anthropic;codex=openai-codex');
    expect(claude!.model).toBe(lookupLlmTierSpec('anthropic', 'better').model);
    expect(claude!.model).not.toContain('haiku');
  });
  test('rework escalation stays inside the arm (sol and opus tiers)', () => {
    const [claude] = parseBenchArms('claude=anthropic:claude-sonnet-5;codex=openai-codex');
    const env = benchArmEnv(claude!);
    for (const tier of ['sol', 'opus'] as const) {
      expect(resolveEscalateTarget(tier, env)).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });
    }
    expect(resolveEscalateTarget('sol', {})!.provider).toBe('openai-codex');   // 대조군 — 덮지 않으면 codex 로 샌다
  });
  test('local arm: ladder model, host LLM url, and only its pod carries the local-llm egress label', async () => {
    const arms = parseBenchArms('local=local;codex=openai-codex');
    expect(arms[0]!.model).toBe(lookupLlmTierSpec('local', 'better').model);
    expect(benchArmEnv(arms[0]!).LOCAL_LLM_URL).toBe('http://host.orb.internal:1234/v1');
    expect(benchArmEnv(arms[1]!).LOCAL_LLM_URL).toBeUndefined();
    const labelsFor = async (goal: string): Promise<Record<string, string>> => {
      const calls: Array<{ args: string; input?: string }> = [];
      const k = ((args: readonly string[], input?: string) => { calls.push({ args: args.join(' '), ...(input ? { input } : {}) }); return { status: 0, stdout: args.includes('current-context') ? 'test-context' : args.includes('get') ? 'Complete' : '', stderr: '' }; });
      await benchPodSpawn(arms, { kubectl: k, sleep: async () => {}, credentials: CREDS, env: {} })({ feature: goal, spaceId: 's' }).done;
      const job = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!)).find((m) => m.kind === 'Job');
      return job.spec.template.metadata.labels;
    };
    const [gLocal, gCodex] = benchGoals('g', arms);
    expect((await labelsFor(gLocal!))['elanous.egress/local-llm']).toBe('true');
    expect((await labelsFor(gCodex!))['elanous.egress/local-llm']).toBeUndefined();
  });
  test('a goal without a known arm label fails with a named error (no silent default arm)', async () => {
    const r = await benchPodSpawn(parseBenchArms('a=grok;b=openai-codex'), { credentials: CREDS })({ feature: 'no label', spaceId: 's' }).done;
    expect(r.error?.code).toBe('bench-arm-missing');
  });
});

// BACKLOG E6 — 이미지 판 대조.
import { podImageFreshness } from './self-implement-pod.js';
describe('pod image freshness', () => {
  const fake = (head: string | null, label: string | null, imageExists = true) => (cmd: string) =>
    cmd === 'git'
      ? { status: head ? 0 : 128, stdout: head ? `${head}\n` : '' }
      : { status: imageExists ? 0 : 1, stdout: label === null ? '<no value>\n' : `${label}\n` };
  test('fresh only when the image label equals HEAD', () => {
    expect(podImageFreshness({ run: fake('abc', 'abc') }).fresh).toBe(true);
    expect(podImageFreshness({ run: fake('abc', 'old') })).toMatchObject({ fresh: false, imageCommit: 'old', headCommit: 'abc' });
  });
  test('missing label, missing image, unreadable HEAD are all stale (never assumed fresh)', () => {
    expect(podImageFreshness({ run: fake('abc', null) }).fresh).toBe(false);
    expect(podImageFreshness({ run: fake('abc', 'abc', false) }).fresh).toBe(false);
    expect(podImageFreshness({ run: fake(null, 'abc') }).fresh).toBe(false);
  });
});

// BACKLOG C5·C1b — 모름을 0 으로 보이지 않고, 호스트가 다시 매긴다.
import { podRowCost, type PodRowReprice } from './self-implement-pod.js';
import { estimateLlmCost } from '../../budget/llm-cost.js';
describe('pod rollup row cost (BACKLOG C5·C1b)', () => {
  const row = { model: 'openrouter/moonshotai/kimi-k3', calls: 16, inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, usdKnown: 0, unknownCostCalls: 16 };
  test('all-unknown without a host price is unknown with usd null — never $0', () => {
    expect(podRowCost(row)).toEqual({ kind: 'unknown', usd: null, unknownCostCalls: 16 });
    expect(podRowCost(row, () => ({ kind: 'unknown' }))).toMatchObject({ kind: 'unknown', usd: null });
  });
  test('host reprice turns pod-unknown into known with its source named', () => {
    expect(podRowCost(row, () => ({ kind: 'known', usd: 3 }))).toEqual({ kind: 'known', usd: 3, source: 'host-reprice', podUnknownCostCalls: 16 });
  });
  test('a row without the cache-write field (older pod rollup) is not host-repriced as if writes were 0', () => {
    const { cacheCreationInputTokens: _drop, ...old } = row;
    let called = 0;
    expect(podRowCost(old, () => { called++; return { kind: 'known', usd: 3 }; })).toEqual({ kind: 'unknown', usd: null, unknownCostCalls: 16 });
    expect(called).toBe(0);
  });
  test('the real host reprice path prices cache-write tokens at the catalog cache-write rate (claude-sonnet-5-5)', () => {
    const reprice = (u: Parameters<PodRowReprice>[0]) => estimateLlmCost(u) as { kind: string; usd?: number };
    const base = { site: 'stream-llm', provider: 'anthropic', model: 'claude-sonnet-5-5', calls: 2, inputTokens: 12, outputTokens: 6, cacheReadInputTokens: 64_000, usdKnown: 0, unknownCostCalls: 2 };
    const emitted = (cacheCreationInputTokens: number) => {
      const out: Array<Record<string, unknown>> = [];
      reemitPodUsage(`ELANOUS_USAGE_ROLLUP ${JSON.stringify({ measured: true, rows: [{ ...base, cacheCreationInputTokens }] })}`, 'si-p', (_c, _e, d) => out.push(d), reprice);
      return out[0]!.cost as { kind: string; usd: number; source: string };
    };
    const without = emitted(0);
    const withWrites = emitted(4_600);
    expect(withWrites).toMatchObject({ kind: 'known', source: 'host-reprice' });
    expect(withWrites.usd - without.usd).toBeCloseTo(0.0115, 10);
  });
  test('fully known rows pass through; partial keeps the known share', () => {
    expect(podRowCost({ ...row, unknownCostCalls: 0, usdKnown: 1.5 })).toEqual({ kind: 'known', usd: 1.5, unknownCostCalls: 0 });
    expect(podRowCost({ ...row, unknownCostCalls: 4, usdKnown: 1.5 })).toEqual({ kind: 'partial', usd: 1.5, unknownCostCalls: 4 });
  });
});

// BACKLOG C6 — 구독·local 은 «포함»(청구 0)이고 «모름»이 아니다.
import { llmUsageCostFields } from '../../budget/llm-cost.js';
describe('included cost for subscription/local (BACKLOG C6)', () => {
  test('subscription call is included with an api-equivalent, not a known API charge', () => {
    const f = llmUsageCostFields('gpt-6-sol', { inputTokens: 1_000_000, outputTokens: 0 }, { configPricing: {} }, 'subscription');
    expect(f.cost).toMatchObject({ kind: 'included', usd: 0, billing: 'subscription', apiEquivalentUsd: 2 });
    expect(llmUsageCostFields('gpt-6-sol', { inputTokens: 1_000_000, outputTokens: 0 }, { configPricing: {} }, 'api').cost).toMatchObject({ kind: 'known', usd: 2 });
  });
  test('rollup counts included calls apart from unknown; pod row of all-included stays included', () => {
    const r = rollup([JSON.stringify({ event: 'llm-usage', data: { site: 'agent-turn', provider: 'openai', billingProvider: 'openai-codex', model: 'gpt-6-sol', inputTokens: 10, outputTokens: 1, cost: { kind: 'included', usd: 0, apiEquivalentUsd: 0.25 } } })]);
    expect(r.rows[0]).toMatchObject({ provider: 'openai-codex', calls: 1, unknownCostCalls: 0, includedCalls: 1, apiEquivalentUsd: 0.25, usdKnown: 0 });
    expect(podRowCost(r.rows[0] as unknown as Record<string, unknown>)).toMatchObject({ kind: 'included', usd: 0, apiEquivalentUsd: 0.25 });
  });
});

// 🅣 RFC run-origin(#20457 §A3) — Pod 가 자기 출처를 env 로 갖는다(칸 이름 합의).
describe('pod run-origin env (RFC run-origin §A3)', () => {
  test('in-place switch stays off by default and follows explicit host opt-in for a single child', () => {
    const prior = process.env.ELANOUS_POD_INPLACE_WORKTREE;
    const makeEnv = () => (podJobManifest({ name: 'si-x', namespace: 'elanous-test', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }> }> } } } }).spec.template.spec.containers[0]!.env;
    try {
      delete process.env.ELANOUS_POD_INPLACE_WORKTREE;
      expect(makeEnv()).toContainEqual({ name: 'ELANOUS_POD_INPLACE_WORKTREE', value: '0' });
      process.env.ELANOUS_POD_INPLACE_WORKTREE = '1';
      const env = makeEnv();
      expect(env).toContainEqual({ name: 'ELANOUS_POD_INPLACE_WORKTREE', value: '1' });
      expect(env).toContainEqual({ name: 'ELANOUS_POD_SINGLE_CHILD', value: '1' });
    } finally {
      if (prior === undefined) delete process.env.ELANOUS_POD_INPLACE_WORKTREE;
      else process.env.ELANOUS_POD_INPLACE_WORKTREE = prior;
    }
  });
  test('downward API pod/node/namespace, supervisor hostId and image commit are in the child env', () => {
    const job = podJobManifest({ name: 'si-x', namespace: 'elanous-test', image: 'elanous-harness:local', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60, hostId: 'host-abc', imageCommit: 'deadbeef' }) as { spec: { template: { spec: { containers: Array<{ env: Array<Record<string, unknown>> }> } } } };
    const env = job.spec.template.spec.containers[0]!.env;
    expect(env).toContainEqual({ name: 'ELANOUS_POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } });
    expect(env).toContainEqual({ name: 'ELANOUS_NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } });
    expect(env).toContainEqual({ name: 'ELANOUS_POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } });
    expect(env).toContainEqual({ name: 'ELANOUS_HOST_ID', value: 'host-abc' });
    expect(env).toContainEqual({ name: 'ELANOUS_IMAGE_COMMIT', value: 'deadbeef' });
  });
  test('rollup origin fields are re-emitted on the host', () => {
    const out: Array<Record<string, unknown>> = [];
    const line = `ELANOUS_USAGE_ROLLUP ${JSON.stringify({ runId: 'r1', podName: 'si-x-abc', nodeName: 'k3d-node-0', hostId: 'host-abc', rows: [{ site: 'agent-turn', model: 'gpt-6-sol', calls: 1, inputTokens: 1, outputTokens: 1, usdKnown: 0.1, unknownCostCalls: 0 }] })}`;
    reemitPodUsage(line, 'si-x', (_c, _e, d) => out.push(d));
    expect(out[0]).toMatchObject({ podName: 'si-x-abc', nodeName: 'k3d-node-0', podHostId: 'host-abc' });
  });

  test('memory limit defaults to 16Gi (6Gi then 12Gi OOMKilled real children) and follows ELANOUS_POD_MEMORY', () => {
    const base = { name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 };
    expect(JSON.stringify(podJobManifest(base))).toContain('"memory":"16Gi"');
    expect(JSON.stringify(podJobManifest({ ...base, memoryLimit: '24Gi' }))).toContain('"memory":"24Gi"');
  });
});

// P2·P3·P4 (2026-09-26 Pod 실물 미션에서 나온 셋).
import { join as pjoin } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

describe('pod remote continuity', () => {
  const jwt = (expSec: number) => `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.s`;
  test('P4: the elanous copy carries the checked codex token, never a stale store token or any refresh token', () => {
    const dir = mkdtempSync(pjoin(tmpdir(), 'pod-cred-'));
    const codexHome = pjoin(dir, 'codex'); mkdirSync(codexHome);
    const fresh = jwt(Math.floor(Date.now() / 1000) + 200 * 3600);
    writeFileSync(pjoin(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: fresh, refresh_token: 'r-codex', account_id: 'acc' } }));
    const store = pjoin(dir, 'auth.json');
    writeFileSync(store, JSON.stringify({ version: 1, providers: { 'openai-codex:third': { codexHome, tokens: { accessToken: jwt(Math.floor(Date.now() / 1000) - 3600), expiresAt: 1, refreshToken: 'r-elanous', tokenType: 'Bearer' } } } }));
    const c = hostCredentials('third', store, () => 'gh');
    const el = JSON.parse(c.elanousAuth).providers['openai-codex'].tokens;
    expect(el.accessToken).toBe(fresh);
    expect(el.expiresAt).toBeGreaterThan(Date.now() + 100 * 3600_000);
    expect(el.refreshToken).toBe('');
    expect(JSON.parse(c.codexAuth).tokens.refresh_token).toBe('');
    expect(c.elanousAuth + c.codexAuth).not.toContain('r-codex');
    expect(c.elanousAuth + c.codexAuth).not.toContain('r-elanous');
  });

  test('default account: store key `openai-codex` without codexHome resolves to CODEX_HOME (the rotation candidate the pod broker now hands out)', () => {
    const dir = mkdtempSync(pjoin(tmpdir(), 'pod-cred-default-'));
    const codexHome = pjoin(dir, 'codex'); mkdirSync(codexHome);
    const fresh = jwt(Math.floor(Date.now() / 1000) + 200 * 3600);
    writeFileSync(pjoin(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: fresh, refresh_token: 'r', account_id: 'acc' } }));
    const store = pjoin(dir, 'auth.json');
    writeFileSync(store, JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: fresh, expiresAt: 1, refreshToken: 'r2' } } } }));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const c = hostCredentials('default', store, () => 'gh');
      expect(JSON.parse(c.elanousAuth).providers['openai-codex'].tokens.accessToken).toBe(fresh);
      expect(() => hostCredentials('ghost', store, () => 'gh')).toThrow('openai-codex:ghost');
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    }
  });

  const run = (existing: string) => {
    const calls: string[][] = [];
    const k = (args: readonly string[]) => {
      calls.push([...args]);
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx\n', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: existing ? 0 : 1, stdout: existing, stderr: existing ? '' : 'NotFound' };
      if (args.includes('jsonpath={.metadata.uid}')) return { status: 0, stdout: 'uid-1', stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    return { calls, done: podSelfImplementSpawn({ kubectl: k, pollMs: 1, imageCommit: null, sleep: async () => {}, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }) })({ spaceId: 's', feature: 'f' } as Parameters<ReturnType<typeof podSelfImplementSpawn>>[0]).done };
  };
  test('failed existing Job returns child ledger and artifact before deletion and relaunch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-failed-relaunch-'));
    const previousState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const spaceId = 'failed-relaunch';
    const job = podJobName(spaceId);
    const id = 'run-failed-before-delete';
    const ledger = '{"event":"failed"}\n';
    const artifact = `ELANOUS_POD_ARTIFACT ${Buffer.from('failure.txt').toString('base64url')} 1/1 ${gzipSync('saved before delete').toString('base64')}`;
    const logText = `ELANOUS_RUN_LEDGER ${id} 1/1 ${gzipSync(ledger).toString('base64')}\n${artifact}\n`;
    const calls: string[][] = [];
    const kubectl: Kubectl = (args) => {
      calls.push([...args]);
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Failed', stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: logText, stderr: '' };
      if (args.includes('delete') && args.includes('job')) {
        expect(readFileSync(runLedgerPath(id, runLedgerDir(root)), 'utf8')).toBe(ledger);
        expect(readFileSync(join(effectiveInstanceRoot(), 'pod-artifacts', job, 'failure.txt'), 'utf8')).toBe('saved before delete');
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } })({ feature: 'f', spaceId }).done;
      expect(result.exitCode).toBe(0);
      const logs = calls.findIndex((args) => args.includes('logs'));
      const deletion = calls.findIndex((args) => args.includes('delete') && args.includes('job'));
      expect(logs).toBeGreaterThan(-1);
      expect(calls[logs]).toContain('-c');
      expect(calls[logs]).toContain('child');
      expect(calls[logs]).not.toContain('--tail=400');
      expect(deletion).toBeGreaterThan(logs);
      expect(calls.findIndex((args) => args.includes('apply'))).toBeGreaterThan(logs);
      expect(readFileSync(runLedgerPath(id, runLedgerDir(root)), 'utf8')).toBe(ledger);
      expect(readFileSync(join(effectiveInstanceRoot(), 'pod-artifacts', job, 'failure.txt'), 'utf8')).toBe('saved before delete');
    } finally {
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unreadable failed Job logs report the reason and still delete the Job', async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'self-implement.pod') events.push({ event, data });
    }) as typeof debug.log);
    const calls: string[][] = [];
    const kubectl: Kubectl = (args) => {
      calls.push([...args]);
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Failed', stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs') && !args.includes('--tail=400')) return { status: 1, stdout: '', stderr: 'old logs unavailable' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: {} })({ feature: 'f', spaceId: 'failed-no-logs' }).done;
      const deletion = calls.findIndex((args) => args.includes('delete') && args.includes('job'));
      expect(deletion).toBeGreaterThan(calls.findIndex((args) => args.includes('logs')));
      expect(events).toContainEqual({ event: 'failed-job-logs-unavailable', data: { job: podJobName('failed-no-logs'), reason: 'old logs unavailable' } });
    } finally { logSpy.mockRestore(); }
  });

  test('empty child logs from a failed Job are reported before it is deleted', async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'self-implement.pod') events.push({ event, data });
    }) as typeof debug.log);
    const calls: string[][] = [];
    const kubectl: Kubectl = (args) => {
      calls.push([...args]);
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Failed', stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: {} })({ feature: 'f', spaceId: 'failed-empty-logs' }).done;
      const logs = calls.findIndex((args) => args.includes('logs'));
      const deletion = calls.findIndex((args) => args.includes('delete') && args.includes('job'));
      expect(logs).toBeGreaterThan(-1);
      expect(deletion).toBeGreaterThan(logs);
      expect(events).toContainEqual({ event: 'failed-job-logs-unavailable', data: { job: podJobName('failed-empty-logs'), reason: 'empty child logs' } });
    } finally { logSpy.mockRestore(); }
  });

  test('failed Job remains intact if either ledger or artifact cannot be stored on the host', async () => {
    for (const kind of ['ledger', 'artifact'] as const) {
      const root = mkdtempSync(join(tmpdir(), `pod-collection-${kind}-`));
      const previousState = process.env.ELANOUS_STATE_DIR;
      process.env.ELANOUS_STATE_DIR = root;
      const spaceId = `failed-collection-${kind}-${root.split('/').at(-1)}`;
      const job = podJobName(spaceId);
      const line = kind === 'ledger'
        ? `ELANOUS_RUN_LEDGER run-storage-failure 1/1 ${gzipSync('old ledger\n').toString('base64')}`
        : `ELANOUS_POD_ARTIFACT ${Buffer.from('blocked/output.txt').toString('base64url')} 1/1 ${gzipSync('old artifact').toString('base64')}`;
      const calls: string[][] = [];
      const kubectl: Kubectl = (args) => {
        calls.push([...args]);
        if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
        if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Failed', stderr: '' };
        if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
        if (args.includes('logs')) return { status: 0, stdout: `${line}\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      try {
        if (kind === 'ledger') mkdirSync(runLedgerPath('run-storage-failure', runLedgerDir(root)), { recursive: true });
        else {
          mkdirSync(join(root, 'pod-artifacts', job), { recursive: true });
          writeFileSync(join(root, 'pod-artifacts', job, 'blocked'), 'not a directory');
        }
        const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } })({ feature: 'f', spaceId }).done;
        expect(result.exitCode).toBe(1);
        expect(result.error?.code).toBe('pod-collection-incomplete');
        expect(calls.some((args) => args.includes('logs') && args.includes(`job/${job}`))).toBe(true);
        expect(calls.some((args) => args.includes('delete') && args.includes('job'))).toBe(false);
        expect(calls.some((args) => args.includes('apply'))).toBe(false);
      } finally {
        if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
        else process.env.ELANOUS_STATE_DIR = previousState;
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('P3: resuming uses the running Job child ID rather than the newly minted candidate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-reattach-'));
    const child = 'run-reattached-1';
    const calls: string[][] = [];
    const kubectl: Kubectl = (args) => {
      calls.push([...args]);
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b ', stderr: '' };
      if (args.includes('-o') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ spec: { template: { spec: { containers: [{ name: 'child', env: [{ name: 'ELANOUS_RUN_ID', value: child }] }] } } } }), stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: `ELANOUS_RUN_LEDGER ${child} 1/1 ${gzipSync('{"event":"reattached"}\n').toString('base64')}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      expect((await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } })({ spaceId: 'reattach', feature: 'x' }).done).exitCode).toBe(0);
      expect(readFileSync(runLedgerPath(child, runLedgerDir(root)), 'utf8')).toContain('reattached');
      expect(calls.some((c) => c.includes('delete') && c.includes('job'))).toBe(false);
      expect(calls.some((c) => c.includes('apply'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('P3: reconnecting to an already collected complete Job preserves its child ledger and completeness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-reattach-complete-'));
    const child = 'run-reattached-complete-1';
    const ledger = '{"event":"child-start"}\n{"event":"child-done"}\n';
    const finished: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    const off = debug.registerSink({ name: 'pod-reattach-complete-test', emit: (record) => {
      if (record.category !== 'self-implement.pod') return;
      events.push(record.event);
      if (record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    let applied = false;
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.includes('apply') && input && JSON.parse(input).kind === 'Job') { applied = true; return { status: 0, stdout: '', stderr: '' }; }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: applied ? 0 : 1, stdout: applied ? '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Complete' : '', stderr: '' };
      if (args.includes('-o') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ spec: { template: { spec: { containers: [{ name: 'child', env: [{ name: 'ELANOUS_RUN_ID', value: child }] }] } } } }), stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: `ELANOUS_RUN_LEDGER ${child} 1/1 ${gzipSync(ledger).toString('base64')}\n{"stage":"merged","ok":true}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const opts = { kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } };
      const dir = runLedgerDir(root);
      // First collection of the existing Job, then a second invocation attaches to the same Job.
      applied = true;
      expect((await podSelfImplementSpawn(opts)({ spaceId: 'reattach-complete', feature: 'x' }).done).exitCode).toBe(0);
      const before = readFileSync(runLedgerPath(child, dir), 'utf8');
      expect(before).toBe(ledger);
      expect((await podSelfImplementSpawn(opts)({ spaceId: 'reattach-complete', feature: 'x' }).done).exitCode).toBe(0);
      expect(readFileSync(runLedgerPath(child, dir), 'utf8')).toBe(before);
      expect(events).toContain('ledger-collect-already-complete');
      expect(events).not.toContain('ledger-collect-skipped');
      expect(finished).toHaveLength(2);
      expect(finished.every((row) => row.childRunId === child && row.ledgerCompleteness === 'complete')).toBe(true);
    } finally { off(); rmSync(root, { recursive: true, force: true }); }
  });

  test('P3: unreadable or invalid running Job child ID stops without inventing a ledger', async () => {
    for (const manifest of [null, { spec: { template: { spec: { containers: [{ name: 'child', env: [{ name: 'ELANOUS_RUN_ID', value: 'run-parent-1' }] }] } } } }]) {
      const root = mkdtempSync(join(tmpdir(), 'pod-reattach-missing-id-'));
      const calls: string[][] = [];
      const kubectl: Kubectl = (args) => {
        calls.push([...args]);
        if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
        if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b ', stderr: '' };
        if (args.includes('-o') && args.includes('json')) return { status: manifest ? 0 : 1, stdout: manifest ? JSON.stringify(manifest) : '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      try {
        const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_RUN_ID: 'run-parent-1', ELANOUS_STATE_DIR: root } })({ spaceId: 'reattach-missing', feature: 'x' }).done;
        expect(result.error?.code).toBe('pod-child-run-id');
        expect(calls.some((c) => c.includes('exec') || c.includes('logs') || c.includes('apply') || c.includes('delete'))).toBe(false);
        expect(existsSync(runLedgerDir(root))).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  test('P2: a fresh Job owns its credential secret, so k8s reaps it with the Job', async () => {
    const r = run('');
    await r.done;
    const patch = r.calls.find((c) => c.includes('patch') && c.includes('secret'));
    expect(patch).toBeDefined();
    expect(patch!.join(' ')).toContain('"ownerReferences":[{"apiVersion":"batch/v1","kind":"Job"');
    expect(patch!.join(' ')).toContain('"uid":"uid-1"');
  });
});

// P13 원격 그라운딩 — 토큰은 Secret 으로만 · 끝나면 회수 · 주소가 없으면 발급 자체를 안 한다.
describe('pod grounding token', () => {
  const k = (applied: string[]) => ((args: readonly string[], input?: string) => {
    if (input) applied.push(input);
    if (args.includes('current-context')) return { status: 0, stdout: 'ctx\n', stderr: '' };
    if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  }) as Kubectl;
  test('different owner with the same repository name never receives an App token or credential relay', async () => {
    const applied: string[] = [];
    const issued: string[] = [];
    await podSelfImplementSpawn({
      kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {}, credentials: CREDS,
      repoUrl: 'https://github.com/expected/shared.git', env: {}, groundingUrl: 'https://host:31415',
      githubInstallation: (repository) => { issued.push(repository); return { token: 'wrong-owner-installation', expires_at: '2030-01-01T00:00:00Z' }; },
      githubRepositories: async () => ['other/shared'],
      mintGrounding: async () => ({ token: 'grounding-only', exp: 9 }), revokeGrounding: () => {},
    })({ spaceId: 'owner-mismatch', feature: 'f' }).done;
    const secret = JSON.parse(applied.find((a) => a.includes('"kind":"Secret"'))!) as { stringData: Record<string, string> };
    expect(issued).toEqual(['expected/shared']);
    expect(secret.stringData['gh-token']).toBe('gho_x');
    expect(secret.stringData['env-ELANOUS_POD_GITHUB_CREDENTIAL_TOKEN']).toBeUndefined();
    expect(applied.find((a) => a.includes('"kind":"Job"'))!).not.toContain('ELANOUS_POD_GITHUB_CREDENTIAL_URL');
  });

  test('without a relay the host refreshes a verified App token; unavailable or unverified Apps keep the human credential', async () => {
    for (const [spaceId, installation, repositories, expected, reason] of [
      ['app-no-grounding', () => ({ token: 'scoped-installation', expires_at: new Date(Date.now() + 3600_000).toISOString() }), async () => ['owner/repo'], 'scoped-installation', 'verified'],
      ['app-missing', () => null, async () => ['owner/repo'], 'gho_x', 'mint-unavailable'],
      ['app-expiry-missing', () => ({ token: 'unexpiring-installation' }), async () => ['owner/repo'], 'gho_x', 'expiry-unavailable'],
      ['app-expired', () => ({ token: 'expired-installation', expires_at: '2020-01-01T00:00:00Z' }), async () => ['owner/repo'], 'gho_x', 'expired'],
      ['app-repo-mismatch', () => ({ token: 'wrong-repo-installation', expires_at: new Date(Date.now() + 3600_000).toISOString() }), async () => ['other/repo'], 'gho_x', 'repository-verification-failed'],
      ['app-mint-failed', () => { throw new Error('sensitive mint exception'); }, async () => ['owner/repo'], 'gho_x', 'mint-threw'],
      ['app-lookup-failed', () => ({ token: 'unchecked-installation', expires_at: new Date(Date.now() + 3600_000).toISOString() }), async () => { throw new Error('sensitive lookup exception'); }, 'gho_x', 'verification-threw'],
    ] as const) {
      const applied: string[] = [];
      const eventsForSkipped = new Set<string>();
      const credentialEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
      const off = debug.registerSink({ name: `app-skip-${spaceId}`, emit: (record) => {
        if (record.category === 'self-implement.pod' && record.event === 'gh-token-app-skipped') eventsForSkipped.add(spaceId);
        if (record.category === 'self-implement.pod' && ['github-app-decision', 'github-app-unavailable', 'github-credential-source'].includes(record.event)) {
          credentialEvents.push({ event: record.event, data: record.data as Record<string, unknown> });
        }
      } });
      let minted = 0;
      try {
        const result = await podSelfImplementSpawn({
          kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {}, credentials: CREDS,
          repoUrl: 'git@github.com:owner/repo.git', env: {},
          githubInstallation: installation, githubRepositories: repositories,
          mintGrounding: async () => { minted++; return { token: 'unexpected', exp: 1 }; },
          revokeGrounding: () => { throw new Error('unexpected revoke'); },
        })({ spaceId, feature: 'f' }).done;
        const [secret, job] = applied.map((text) => JSON.parse(text)).filter((m) => m.kind === 'Secret' || m.kind === 'Job');
        expect(result.exitCode).toBe(0);
        expect(secret.stringData['gh-token']).toBe(expected);
        const script: string = job.spec.template.spec.containers[0].args[0];
        expect(script).toContain(expected === 'scoped-installation' ? 'gh auth login --with-token < /creds/gh-token' : 'export GH_TOKEN="$(cat /creds/gh-token)"');
        expect(script.includes('gh auth login --with-token < /creds/gh-token')).toBe(expected === 'scoped-installation');
        expect(eventsForSkipped.has(spaceId)).toBe(expected === 'gho_x');
        expect(credentialEvents.some(({ data }) => data.reason === reason)).toBe(true);
        expect(credentialEvents.find(({ event }) => event === 'github-credential-source')?.data).toMatchObject({ repository: 'owner/repo', source: expected === 'gho_x' ? 'human-fallback' : 'verified-app' });
        expect(JSON.stringify(credentialEvents)).not.toMatch(/scoped-installation|unexpiring-installation|expired-installation|wrong-repo-installation|unchecked-installation|gho_x|sensitive/);
        expect(secret.stringData['env-ELANOUS_POD_GITHUB_CREDENTIAL_TOKEN']).toBeUndefined();
        expect(job.spec.template.spec.containers[0].env.some((entry: { name: string }) => entry.name.startsWith('ELANOUS_POD_GITHUB_CREDENTIAL_'))).toBe(false);
        expect(minted).toBe(0);
        expect(JSON.stringify(job)).not.toContain('sensitive');
      } finally { off(); }
    }
  });

  test('an App Job rejects ambient GitHub token env so gh and git use the host-refreshed credential', async () => {
    for (const app of [true, false]) {
      const { k, calls } = fakeKubectl(['Complete'], '');
      await podSelfImplementSpawn({
        kubectl: k, credentials: CREDS, env: { GH_TOKEN: 'ambient-one', GITHUB_TOKEN: 'ambient-two', GH_CONFIG_DIR: '/ambient-config' },
        passEnv: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR'], armEnv: { GH_TOKEN: 'arm-one', GITHUB_TOKEN: 'arm-two', GH_CONFIG_DIR: '/arm-config' },
        githubInstallation: () => app ? { token: 'scoped-installation', expiresAt: new Date(Date.now() + 3600_000).toISOString() } : null,
        githubRepositories: async () => ['ElanvitalAI/elanous'],
      })({ spaceId: `github-env-${app}`, feature: 'x' }).done;
      const [secret, job] = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!));
      const env = job.spec.template.spec.containers[0].env as Array<{ name: string }>;
      expect(secret.stringData['gh-token']).toBe(app ? 'scoped-installation' : CREDS().ghToken);
      for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR']) {
        expect(secret.stringData[`env-${key}`]).toBe(app ? undefined : key === 'GH_TOKEN' ? 'ambient-one' : key === 'GITHUB_TOKEN' ? 'ambient-two' : '/ambient-config');
        expect(env.filter((entry) => entry.name === key)).toHaveLength(app ? 0 : 2);
      }
    }
  });

  test('App launch logs in through gh stdin, with a private gh config read by gh and git', () => {
    const script = (podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60, appCredential: true }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } }).spec.template.spec.containers[0]!.args[0]!;
    const line = script.split('\n').find((part) => part.startsWith('unset GH_TOKEN GITHUB_TOKEN;'))!;
    const home = mkdtempSync(join(tmpdir(), 'pod-gh-app-'));
    try {
      const gh = Bun.which('gh');
      expect(gh).toBeTruthy();
      const bin = join(home, 'bin'); mkdirSync(bin);
      // Avoid GitHub's online token validation; exercise the script's stdin and the real gh/git config readers.
      writeFileSync(join(bin, 'gh'), `#!/bin/bash
if [ "$1" = auth ] && [ "$2" = login ]; then
  [ "$3" = --with-token ] || exit 9
  read -r token
  mkdir -p "$GH_CONFIG_DIR"
  printf 'github.com:\\n    oauth_token: %s\\n    git_protocol: https\\n' "$token" > "$GH_CONFIG_DIR/hosts.yml"
  printf 'version: "1"\\n' > "$GH_CONFIG_DIR/config.yml"
else
  exec ${JSON.stringify(gh)} "$@"
fi
`);
      chmodSync(join(bin, 'gh'), 0o700);
      const credential = join(home, 'gh-token');
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'ghp_human', GITHUB_TOKEN: 'ghp_human', GH_CONFIG_DIR: join(home, 'wrong-gh'), XDG_CONFIG_HOME: join(home, 'wrong-xdg') };
      writeFileSync(credential, 'ghs_FIRST\n');
      const launchLine = line.replaceAll('/creds/gh-token', credential);
      const launch = Bun.spawnSync(['bash', '-c', launchLine], { env });
      expect(launch.exitCode).toBe(0);
      const auth = join(home, '.config/gh/hosts.yml');
      expect(readFileSync(auth, 'utf8')).toContain('oauth_token: ghs_FIRST');
      expect(statSync(auth).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, '.config/gh')).mode & 0o777).toBe(0o700);
      const ghEnv = { ...env, GH_CONFIG_DIR: join(home, '.config/gh'), GH_TOKEN: '', GITHUB_TOKEN: '' };
      expect(Bun.spawnSync([gh!, 'auth', 'token'], { env: ghEnv }).stdout.toString().trim()).toBe('ghs_FIRST');
      writeFileSync(credential, 'ghs_SECOND\n');
      const refresh = Bun.spawnSync(['bash', '-c', `GH_CONFIG_DIR="$HOME/.config/gh" gh auth login --with-token < "${credential}"`], { env: ghEnv });
      expect(refresh.exitCode).toBe(0);
      expect(readFileSync(auth, 'utf8')).toContain('oauth_token: ghs_SECOND');
      expect(Bun.spawnSync([gh!, 'auth', 'token'], { env: ghEnv }).stdout.toString().trim()).toBe('ghs_SECOND');
      const gitEnv = { ...ghEnv, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0' };
      expect(Bun.spawnSync([gh!, 'auth', 'setup-git'], { env: gitEnv }).exitCode).toBe(0);
      expect(execFileSync('git', ['credential', 'fill'], { env: gitEnv, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })).toContain('password=ghs_SECOND');
      const failingBin = join(home, 'failing-bin'); mkdirSync(failingBin);
      writeFileSync(join(failingBin, 'gh'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(failingBin, 'gh'), 0o700);
      writeFileSync(credential, 'ghs_FALLBACK\n');
      const fallback = Bun.spawnSync(['bash', '-c', launchLine], { env: { ...env, PATH: `${failingBin}:${process.env.PATH}` } });
      expect(fallback.exitCode).toBe(0);
      expect(readFileSync(auth, 'utf8')).toContain('oauth_token: ghs_FALLBACK');
      expect(statSync(auth).mode & 0o777).toBe(0o600);
      expect(Bun.spawnSync([gh!, 'auth', 'token'], { env: ghEnv }).stdout.toString().trim()).toBe('ghs_FALLBACK');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('host exec writes the child gh config despite a different XDG_CONFIG_HOME and GH_CONFIG_DIR', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-gh-refresh-config-'));
    const start = Date.now();
    const gh = Bun.which('gh');
    expect(gh).toBeTruthy();
    const bin = join(home, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = login ]; then
  read -r token
  mkdir -p "$GH_CONFIG_DIR"
  printf 'github.com:\\n    oauth_token: %s\\n    git_protocol: https\\n' "$token" > "$GH_CONFIG_DIR/hosts.yml"
  printf 'version: "1"\\n' > "$GH_CONFIG_DIR/config.yml"
else
  exec ${JSON.stringify(gh)} "$@"
fi
`);
    chmodSync(join(bin, 'gh'), 0o700);
    const childEnv = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, GH_CONFIG_DIR: join(home, 'other-config'), XDG_CONFIG_HOME: join(home, 'other-xdg') };
    let polls = 0;
    let issued = 0;
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('apply') && input && JSON.parse(input).kind === 'Job') {
        const script = JSON.parse(input).spec.template.spec.containers[0].args[0] as string;
        const line = script.split('\n').find((part) => part.startsWith('unset GH_TOKEN GITHUB_TOKEN;'))!;
        const creds = join(home, 'gh-token'); writeFileSync(creds, 'ghs_FIRST\n');
        const launch = Bun.spawnSync(['bash', '-c', line.replaceAll('/creds/gh-token', creds)], { env: childEnv });
        expect(launch.exitCode).toBe(0);
      }
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: ++polls > 1 ? 'Complete' : '', stderr: '' };
      if (args.includes('exec') && args.includes('--with-token')) {
        const command = args.slice(args.indexOf('--') + 1);
        const run = Bun.spawnSync(command, { env: childEnv, stdin: Buffer.from(input!), stdout: 'pipe', stderr: 'pipe' });
        return { status: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: {}, now: () => start, sleep: async () => {},
        githubInstallation: () => ({ token: issued++ === 0 ? 'ghs_FIRST' : 'ghs_SECOND', expiresAt: start + (issued === 1 ? 5 : 60) * 60_000 }),
        githubRepositories: async () => ['ElanvitalAI/elanous'],
      })({ spaceId: 'refresh-config', feature: 'x' }).done;
      expect(issued).toBe(2);
      expect(readFileSync(join(home, '.config/gh/hosts.yml'), 'utf8')).toContain('oauth_token: ghs_SECOND');
      expect(Bun.spawnSync([gh!, 'auth', 'token'], { env: { ...childEnv, GH_TOKEN: '', GITHUB_TOKEN: '', GH_CONFIG_DIR: join(home, '.config/gh') } }).stdout.toString().trim()).toBe('ghs_SECOND');
      expect(existsSync(join(home, 'other-config/hosts.yml'))).toBe(false);
      expect(existsSync(join(home, 'other-xdg/gh/hosts.yml'))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('host pushes a newly verified App token over exec stdin at the ten-minute boundary without exposing either bearer', async () => {
    const start = Date.now();
    let clock = start;
    let issued = 0;
    let polls = 0;
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const refreshAtPoll: number[] = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const off = debug.registerSink({ name: 'pod-app-host-refresh', emit: (record) => {
      if (record.category === 'self-implement.pod') events.push({ event: record.event, data: record.data });
    } });
    const kubectl: Kubectl = (args, input) => {
      calls.push({ args: [...args], input });
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: ++polls > 3 ? 'Complete' : '', stderr: '' };
      if (args.includes('exec') && args.includes('--with-token')) refreshAtPoll.push(polls);
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const result = await podSelfImplementSpawn({
        kubectl, credentials: CREDS, env: {}, now: () => clock, sleep: async () => { clock += 60_000; },
        repoUrl: 'https://github.com/owner/repo.git',
        githubInstallation: (repository) => {
          expect(repository).toBe('owner/repo');
          return ++issued === 1
            ? { token: 'ghs_FIRST', expiresAt: start + 11 * 60_000 }
            : { token: 'ghs_SECOND', expiresAt: start + 60 * 60_000 };
        },
        githubRepositories: async (token) => token === 'ghs_FIRST' || token === 'ghs_SECOND' ? ['owner/repo'] : [],
      })({ spaceId: 'host-refresh', feature: 'x' }).done;
      expect(result.exitCode).toBe(0);
      const [secret, job] = calls.filter((call) => call.args.at(-3) === 'apply').map((call) => JSON.parse(call.input!));
      expect(secret.stringData['gh-token']).toBe('ghs_FIRST');
      const script: string = job.spec.template.spec.containers[0].args[0];
      expect(script).toContain('(umask 077; gh auth login --with-token < /creds/gh-token >"$HOME/.gh-login.log" 2>&1) || bun -e');
      expect(script).toContain('&& chmod 600 "$GH_CONFIG_DIR/hosts.yml" && chmod 700 "$GH_CONFIG_DIR" || { echo "[pod] gh-login-failed: ');
      expect(script).toContain('; exit 7; }');
      expect(script).not.toContain('export GH_TOKEN=');
      expect(script.indexOf('gh auth login --with-token')).toBeLessThan(script.indexOf('gh auth setup-git'));
      const refresh = calls.filter((call) => call.args.includes('exec') && call.args.includes('--with-token'));
      expect(refresh).toHaveLength(1);
      expect(refresh[0]!.args).toEqual(['--context', 'ctx', '-n', 'elanous-test', 'exec', '-i', `job/${podJobName('host-refresh')}`, '-c', 'child', '--', 'sh', '-c', 'unset GH_TOKEN GITHUB_TOKEN; GH_CONFIG_DIR="$HOME/.config/gh" exec "$@"', 'sh', 'gh', 'auth', 'login', '--with-token']);
      expect(refresh[0]!.input).toBe('ghs_SECOND\n');
      expect(refreshAtPoll).toEqual([2]);
      expect(issued).toBe(2);
      expect(polls).toBe(4);
      expect(events.filter((row) => row.event === 'gh-token-refreshed')).toEqual([{ event: 'gh-token-refreshed', data: expect.objectContaining({ job: podJobName('host-refresh'), expiresAt: new Date(start + 60 * 60_000).toISOString() }) }]);
      for (const token of ['ghs_FIRST', 'ghs_SECOND']) {
        expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(token);
        expect(JSON.stringify(events)).not.toContain(token);
      }
    } finally { off(); }
  });

  test('a token expiring within ten minutes is launched with the host refresh path and renewed on the first live poll', async () => {
    const start = Date.now();
    let issued = 0;
    let polls = 0;
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const kubectl: Kubectl = (args, input) => {
      calls.push({ args: [...args], input });
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: ++polls > 1 ? 'Complete' : '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    await podSelfImplementSpawn({
      kubectl, credentials: CREDS, env: {}, now: () => start, sleep: async () => {},
      githubInstallation: () => ({ token: issued++ === 0 ? 'ghs_FIRST' : 'ghs_SECOND', expiresAt: start + (issued === 1 ? 5 : 60) * 60_000 }),
      githubRepositories: async () => ['ElanvitalAI/elanous'],
    })({ spaceId: 'short-lived-app', feature: 'x' }).done;
    const secret = calls.filter((call) => call.args.includes('apply') && call.input).map((call) => JSON.parse(call.input!)).find((manifest) => manifest.kind === 'Secret');
    expect(secret.stringData['gh-token']).toBe('ghs_FIRST');
    expect(calls.filter((call) => call.args.includes('exec') && call.args.includes('--with-token'))).toEqual([expect.objectContaining({ input: 'ghs_SECOND\n' })]);
    expect(issued).toBe(2);
  });

  test('a wrong-repository refresh never reaches the Pod and retries a verified token on the next poll', async () => {
    const start = Date.now();
    let clock = start;
    let issued = 0;
    let polls = 0;
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const off = debug.registerSink({ name: 'app-refresh-scope-test', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event.startsWith('gh-token-refresh')) events.push({ event: record.event, data: record.data });
    } });
    const kubectl: Kubectl = (args, input) => {
      calls.push({ args: [...args], input });
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: ++polls > 3 ? 'Complete' : '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({
        kubectl, credentials: CREDS, env: {}, repoUrl: 'https://github.com/owner/repo.git',
        now: () => clock, sleep: async () => { clock += 60_000; },
        githubInstallation: () => ({ token: ['ghs_FIRST', 'ghs_WRONG', 'ghs_SECOND'][issued++]!, expires_at: new Date(start + (issued === 1 ? 11 : 60) * 60_000).toISOString() }),
        githubRepositories: async (token) => token === 'ghs_WRONG' ? ['other/repo'] : ['owner/repo'],
      })({ spaceId: 'refresh-repository-scope', feature: 'x' }).done;
      expect(issued).toBe(3);
      expect(events.map(({ event }) => event)).toEqual(['gh-token-refresh-failed', 'gh-token-refreshed']);
      expect(JSON.stringify(events)).not.toContain('ghs_WRONG');
      const pushed = calls.filter((call) => call.args.includes('exec') && call.args.includes('--with-token'));
      expect(pushed).toHaveLength(1);
      expect(pushed[0]!.input).toBe('ghs_SECOND\n');
      expect(JSON.stringify(calls.map((call) => call.args))).not.toContain('ghs_WRONG');
    } finally { off(); }
  });

  test('a resumed App Job refreshes its unknown expiry on the first live poll without changing the existing Job', async () => {
    const start = Date.now();
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    let polls = 0;
    let issued = 0;
    const appManifest = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60, appCredential: true }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
    const appScript = appManifest.spec.template.spec.containers[0]!.args[0]!;
    const kubectl: Kubectl = (args, input) => {
      calls.push({ args: [...args], input });
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b ', stderr: '' };
      if (args.includes('-o') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ spec: { template: { spec: { containers: [{ name: 'child', args: [appScript], env: [{ name: 'ELANOUS_RUN_ID', value: 'run-reattached-app-1' }] }] } } } }), stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: ++polls > 1 ? 'Complete' : '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, now: () => start, env: {},
      githubInstallation: () => ({ token: issued++ === 0 ? 'ghs_FIRST' : 'ghs_SECOND', expires_at: new Date(start + 60 * 60_000).toISOString() }),
      githubRepositories: async () => ['ElanvitalAI/elanous'], sleep: async () => {},
    })({ spaceId: 'reattached-app', feature: 'x' }).done;
    expect(result.exitCode).toBe(0);
    expect(issued).toBe(2);
    expect(calls.filter((call) => call.args.includes('exec') && call.args.includes('--with-token'))).toEqual([expect.objectContaining({ input: 'ghs_SECOND\n' })]);
    expect(calls.some((call) => call.args.includes('apply'))).toBe(false);
  });

  test('reattached App Job retries a failed host issuance on the next poll', async () => {
    const appManifest = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60, appCredential: true }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
    const script = appManifest.spec.template.spec.containers[0]!.args[0]!;
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const events: string[] = [];
    const off = debug.registerSink({ name: 'reattached-app-mint-retry', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event.startsWith('gh-token-refresh')) events.push(record.event);
    } });
    let polls = 0;
    let issued = 0;
    const kubectl: Kubectl = (args, input) => {
      calls.push({ args: [...args], input });
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b ', stderr: '' };
      if (args.includes('-o') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ spec: { template: { spec: { containers: [{ name: 'child', args: [script], env: [{ name: 'ELANOUS_RUN_ID', value: 'run-reattached-mint-retry-1' }] }] } } } }), stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: ++polls > 2 ? 'Complete' : '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: {}, sleep: async () => {},
        githubInstallation: () => ++issued === 3 ? { token: 'ghs_SECOND', expires_at: new Date(Date.now() + 3600_000).toISOString() } : null,
        githubRepositories: async () => ['ElanvitalAI/elanous'],
      })({ spaceId: 'reattached-mint-retry', feature: 'x' }).done;
      expect(result.exitCode).toBe(0);
      expect(issued).toBe(3);
      expect(events).toEqual(['gh-token-refresh-failed', 'gh-token-refreshed']);
      expect(calls.filter((call) => call.args.includes('exec') && call.args.includes('--with-token'))).toEqual([expect.objectContaining({ input: 'ghs_SECOND\n' })]);
      expect(calls.some((call) => call.args.includes('apply'))).toBe(false);
    } finally { off(); }
  });

  test('a failed host push retries at the next poll with a fresh verified token; a human-token Job remains byte-identical', async () => {
    // The frozen human Job carries the host quota policy; pin it so the snapshot does not depend on this machine's config.
    const savedPolicy = process.env.ELANOUS_CODEX_QUOTA_POLICY;
    process.env.ELANOUS_CODEX_QUOTA_POLICY = 'credits';
    const start = Date.now();
    let clock = start;
    let issued = 0;
    let polls = 0;
    let pushes = 0;
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const off = debug.registerSink({ name: 'pod-app-host-retry', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event.startsWith('gh-token-')) events.push({ event: record.event, data: record.data });
    } });
    const kubectl: Kubectl = (args, input) => {
      calls.push({ args: [...args], input });
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: ++polls > 3 ? 'Complete' : '', stderr: '' };
      if (args.includes('exec') && args.includes('--with-token')) return { status: 1, stdout: '', stderr: 'sensitive stderr ghs_SECOND' };
      if (args.includes('exec') && args.includes('bun')) return { status: ++pushes === 1 ? 1 : 0, stdout: '', stderr: 'sensitive stderr ghs_SECOND' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({
        kubectl, credentials: CREDS, env: {}, now: () => clock, sleep: async () => { clock += 60_000; },
        githubInstallation: () => ({ token: issued++ === 0 ? 'ghs_FIRST' : 'ghs_SECOND', expires_at: new Date(start + (issued === 1 ? 11 : 60) * 60_000).toISOString() }),
        githubRepositories: async () => ['ElanvitalAI/elanous'],
      })({ spaceId: 'retry-push', feature: 'x' }).done;
      expect(pushes).toBe(2);
      expect(events.map((row) => row.event)).toEqual(['gh-token-refresh-failed', 'gh-token-refreshed']);
      expect(calls.filter((call) => call.args.includes('exec') && call.args.includes('--with-token'))).toHaveLength(2);
      const fallbackCalls = calls.filter((call) => call.args.includes('exec') && call.args.includes('bun'));
      expect(fallbackCalls).toHaveLength(2);
      expect(fallbackCalls.every((call) => call.args.includes('unset GH_TOKEN GITHUB_TOKEN; GH_CONFIG_DIR="$HOME/.config/gh" exec "$@"') && call.input === 'ghs_SECOND\n')).toBe(true);
      expect(JSON.stringify(events)).not.toContain('ghs_SECOND');
      const human = fakeKubectl(['', '', 'Complete'], '');
      await podSelfImplementSpawn({ kubectl: human.k, credentials: CREDS, env: { ELANOUS_HOST_ID: 'frozen-human-host' }, githubInstallation: () => null, sleep: async () => {} })({ spaceId: 'human-token', feature: 'x' }).done;
      const [secret, job] = human.calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!));
      const configSnapshot = buildPodConfigSnapshot({ llm: {} } as UserConfig,
        { steps: ['codex-rotate', 'grok'], overage: 'stop', worktreeAddTimeoutSec: 1200 });
      expect(secret.stringData).toEqual({ 'elanous-auth.json': CREDS().elanousAuth, 'codex-auth.json': CREDS().codexAuth, 'gh-token': CREDS().ghToken,
        feature: 'x', 'llm-fallback-config.json': configSnapshot.configJson, 'config-snapshot.json': configSnapshot.envelopeJson });
      const child = job.spec.template.spec.containers[0];
      // Frozen from HEAD before host refresh: full human Job including script, env, mounts and volume.
      const previousHumanJob = "{\"apiVersion\":\"batch/v1\",\"kind\":\"Job\",\"metadata\":{\"name\":\"si-human-token-2ed574b3\",\"namespace\":\"elanous-test\",\"labels\":{\"elanous.substrate\":\"pod\",\"elanous.job\":\"si-human-token-2ed574b3\",\"elanous.run\":\"RUN_ID_PLACEHOLDER\"}},\"spec\":{\"backoffLimit\":0,\"ttlSecondsAfterFinished\":1800,\"activeDeadlineSeconds\":10800,\"template\":{\"metadata\":{\"labels\":{\"elanous.job\":\"si-human-token-2ed574b3\",\"elanous.run\":\"RUN_ID_PLACEHOLDER\"}},\"spec\":{\"restartPolicy\":\"Never\",\"securityContext\":{\"runAsUser\":1000,\"fsGroup\":1000},\"initContainers\":[{\"name\":\"isolation-gate\",\"image\":\"elanous-harness:local\",\"imagePullPolicy\":\"Never\",\"command\":[\"bash\",\"-c\"],\"args\":[\"ok=0\\nfor i in $(seq 1 60); do\\n  if curl -s -m 1 -o /dev/null http://host.orb.internal:31415/health || curl -s -m 1 -o /dev/null http://core.elanous-prod:8080/; then ok=0; else ok=$((ok+1)); fi\\n  [ \\\"$ok\\\" -ge 3 ] && { echo \\\"[gate] isolation enforced after ${i} probes\\\"; exit 0; }\\n  sleep 0.5\\ndone\\necho \\\"[gate] ISOLATION NOT ENFORCED within 30s\\\"; exit 1\"]}],\"containers\":[{\"name\":\"child\",\"image\":\"elanous-harness:local\",\"imagePullPolicy\":\"Never\",\"resources\":{\"requests\":{\"cpu\":\"1\",\"memory\":\"4Gi\"},\"limits\":{\"memory\":\"16Gi\",\"cpu\":\"4\"}},\"command\":[\"bash\",\"-c\"],\"args\":[\"set -u\\nmkdir -p ~/.elanous ~/.codex && cp /creds/elanous-auth.json ~/.elanous/auth.json && cp /creds/codex-auth.json ~/.codex/auth.json && chmod 600 ~/.elanous/auth.json ~/.codex/auth.json\\nexport ELANOUS_CODEX_QUOTA_POLICY='credits'\\nexport GH_TOKEN=\\\"$(cat /creds/gh-token)\\\"\\ngit config --global user.name \\\"elanous pod child\\\" && git config --global user.email \\\"noreply@anthropic.com\\\" && gh auth setup-git\\ncurl -s -m 3 -o /dev/null http://host.orb.internal:31415/health && { echo \\\"[pod] ISOLATION FAIL\\\"; exit 3; }\\nif [ -e repo ]; then exit 5; fi\\nif [ -d '/host-mirror' ] && git -C '/host-mirror' rev-parse --verify HEAD >/dev/null 2>&1 && git clone -q --shared -- '/host-mirror' repo && git -C repo rev-parse --verify HEAD >/dev/null 2>&1; then\\n  git -C repo remote set-url origin 'https://github.com/ElanvitalAI/elanous' || exit 5\\n  source_via=mirror\\nelse\\n  if [ -e repo ]; then rm -r -- repo || exit 5; fi\\n  git clone -q --depth 50 'https://github.com/ElanvitalAI/elanous' repo || exit 5\\n  source_via=github\\nfi\\nprintf 'ELANOUS_POD_SOURCE_VIA %s\\\\n' \\\"$source_via\\\"\\ncd repo || exit 5\\nif [ \\\"$source_via\\\" = mirror ]; then\\n  remote_head=$(git ls-remote origin HEAD | cut -f1) || exit 5\\n  if ! [[ \\\"$remote_head\\\" =~ ^[0-9a-f]{40}$ ]]; then exit 5; fi\\n  if [ \\\"$remote_head\\\" != \\\"$(git rev-parse HEAD)\\\" ]; then\\n    git fetch --depth 50 origin HEAD && git reset --hard FETCH_HEAD || exit 5\\n  fi\\nfi\\nhead=$(git rev-parse HEAD)\\nprintf 'ELANOUS_POD_SOURCE default %s\\\\n' \\\"$head\\\"\\n(while :; do { mem=$(if [ -r /sys/fs/cgroup/memory.current ]; then cat /sys/fs/cgroup/memory.current; elif [ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then cat /sys/fs/cgroup/memory/memory.usage_in_bytes; else printf -- -; fi); top=$(ps -eo rss=,comm=,args= --sort=-rss | head -5 | awk 'function encode(s) { gsub(/%/, \\\"%25\\\", s); gsub(/:/, \\\"%3A\\\", s); gsub(/ /, \\\"%20\\\", s); gsub(/\\\\t/, \\\"%09\\\", s); return s } { rss=$1; name=$2; sub(/^[[:space:]]*[0-9]+[[:space:]]+[^[:space:]]+[[:space:]]*/, \\\"\\\"); n=split($0, a, /[[:space:]]+/); cmd=\\\"<redacted>\\\"; if (name==\\\"sleep\\\" && a[2]==\\\"30\\\") cmd=\\\"sleep 30\\\" (n>2 ? \\\" <redacted>\\\" : \\\"\\\"); else if (name==\\\"bun\\\") { cmd=\\\"bun <redacted>\\\"; if (a[2]==\\\"test\\\") cmd=\\\"bun test <redacted>\\\"; else if (a[2]==\\\"run\\\") cmd=\\\"bun run <redacted>\\\"; else if ((a[2]==\\\"x\\\" || a[2]==\\\"exec\\\") && a[3]==\\\"tsc\\\") cmd=\\\"bun x tsc <redacted>\\\" } else if (name==\\\"tsc\\\") cmd=\\\"tsc <redacted>\\\"; else if (name==\\\"elanous\\\") { cmd=\\\"elanous <redacted>\\\"; if (a[2]==\\\"self\\\") cmd=\\\"elanous self <redacted>\\\"; else if (a[2]==\\\"harness\\\") cmd=\\\"elanous harness <redacted>\\\" } else if (name==\\\"node\\\") cmd=\\\"node <redacted>\\\"; if (name==\\\"sleep\\\" && cmd==\\\"<redacted>\\\") cmd=\\\"sleep <redacted>\\\"; else if (cmd==\\\"<redacted>\\\" && name!=\\\"bash\\\" && name!=\\\"sh\\\") name=\\\"other\\\"; printf \\\" %s:%s:%s\\\", rss, encode(name), encode(substr(cmd,1,120)) }'); printf \\\"ELANOUS_MEM %s %s%s\\\\n\\\" \\\"$(date +%s)\\\" \\\"$mem\\\" \\\"$top\\\"; } || true; sleep 15 || break; done) & mem_sampler_pid=$!\\n(usage_partial_seq=0; while :; do { usage_partial_seq=$((usage_partial_seq+1)); [ -f scripts/usage-rollup.ts ] && bun scripts/usage-rollup.ts --since 12h --partial --seq \\\"$usage_partial_seq\\\" || true; } || true; usage_partial_sleep=$(( ${ELANOUS_USAGE_PARTIAL_MINUTES:-5} * 60 )); sleep \\\"$usage_partial_sleep\\\" || break; done) & usage_partial_pid=$!\\ntrap '{ [ -f scripts/usage-rollup.ts ] && bun scripts/usage-rollup.ts --since 12h --partial; } || true' TERM\\nexport ELANOUS_HARNESS_ENTRANCE=self-implement; elanous self implement \\\"$(cat /creds/feature)\\\" --json '--open-pr' '--no-supervise' > /tmp/si.out 2>&1; rc=$?\\ncat /tmp/si.out\\n[ -f scripts/usage-rollup.ts ] && bun scripts/usage-rollup.ts --since 12h || echo \\\"ELANOUS_USAGE_ROLLUP {\\\"measured\\\":false,\\\"reason\\\":\\\"no rollup script\\\"}\\\"\\nif mkdir -p \\\"$HOME/outbox/pod-logs\\\" && elanous logs --all --include-test --since 12h --limit 20000 --json > \\\"$HOME/outbox/pod-logs/logs.jsonl\\\"; then\\n  logs_size=$(( $(wc -c < \\\"$HOME/outbox/pod-logs/logs.jsonl\\\") ))\\n  if [ \\\"$logs_size\\\" -gt 4500000 ]; then\\n    tail -c 4500000 \\\"$HOME/outbox/pod-logs/logs.jsonl\\\" | tail -n +2 > \\\"$HOME/outbox/pod-logs/logs.jsonl.tail\\\" && mv -f \\\"$HOME/outbox/pod-logs/logs.jsonl.tail\\\" \\\"$HOME/outbox/pod-logs/logs.jsonl\\\"\\n    printf 'ELANOUS_POD_LOGS_TRUNCATED %s %s\\\\n' \\\"$logs_size\\\" \\\"$(( $(wc -c < \\\"$HOME/outbox/pod-logs/logs.jsonl\\\") ))\\\"\\n  fi\\nelse\\n  logs_rc=$?\\n  rm -f \\\"$HOME/outbox/pod-logs/logs.jsonl\\\"\\n  printf 'ELANOUS_POD_LOGS_UNAVAILABLE export-exit-%s\\\\n' \\\"$logs_rc\\\"\\nfi\\nset -o pipefail\\nartifact_bytes=0\\nif [ -d \\\"$HOME/outbox\\\" ]; then\\n  while IFS= read -r -d '' file; do\\n    [ -f \\\"$file\\\" ] && [ ! -L \\\"$file\\\" ] || continue\\n    relative=${file#\\\"$HOME/outbox/\\\"}\\n    size=$(( $(wc -c < \\\"$file\\\") ))\\n    if [ \\\"$size\\\" -gt 5242880 ] || [ $((artifact_bytes + size)) -gt 20971520 ]; then\\n      printf 'ELANOUS_POD_ARTIFACT_SKIPPED %s %s\\\\n' \\\"$relative\\\" \\\"$size\\\"\\n      continue\\n    fi\\n    path_token=$(printf '%s' \\\"$relative\\\" | base64 | tr -d '\\\\n' | tr '+/' '-_' | tr -d '=')\\n    if encoded=$(gzip -c \\\"$file\\\" | base64 | tr -d '\\\\n'); then\\n      artifact_bytes=$((artifact_bytes + size))\\n      total=$(( (${#encoded} + 7999) / 8000 ))\\n      for ((n=1; n<=total; n++)); do\\n        chunk=${encoded:$(( (n-1)*8000 )):8000}\\n        printf 'ELANOUS_POD_ARTIFACT %s %s/%s %s\\\\n' \\\"$path_token\\\" \\\"$n\\\" \\\"$total\\\" \\\"$chunk\\\"\\n      done\\n    else\\n      printf 'ELANOUS_POD_ARTIFACT_SKIPPED %s %s\\\\n' \\\"$relative\\\" \\\"$size\\\"\\n    fi\\n  done < <(find \\\"$HOME/outbox\\\" -type f -print0 | while IFS= read -r -d '' f; do printf '%s\\\\t%s\\\\0' \\\"$(( $(wc -c < \\\"$f\\\") ))\\\" \\\"$f\\\"; done | sort -z -n -k1,1 | while IFS= read -r -d '' row; do printf '%s\\\\0' \\\"${row#*$'\\\\t'}\\\"; done)\\nfi\\nfound=0\\nfor ledger in \\\"${ELANOUS_STATE_DIR:-$HOME/.elanous}\\\"/run-ledger/*.jsonl; do\\n  [ -f \\\"$ledger\\\" ] || continue\\n  found=1\\n  run_id=${ledger##*/}; run_id=${run_id%.jsonl}\\n  if encoded=$(gzip -c \\\"$ledger\\\" | base64 | tr -d '\\\\n'); then\\n    total=$(( (${#encoded} + 7999) / 8000 ))\\n    for ((n=1; n<=total; n++)); do\\n      chunk=${encoded:$(( (n-1)*8000 )):8000}\\n      printf 'ELANOUS_RUN_LEDGER %s %s/%s %s\\\\n' \\\"$run_id\\\" \\\"$n\\\" \\\"$total\\\" \\\"$chunk\\\"\\n    done\\n  else\\n    echo \\\"[pod] ledger transfer failed: $run_id\\\" >&2\\n  fi\\ndone\\nif [ \\\"$found\\\" -eq 0 ]; then echo ELANOUS_RUN_LEDGER_NONE; fi\\nkill \\\"$mem_sampler_pid\\\" 2>/dev/null || true\\n[ -n \\\"${usage_partial_pid:-}\\\" ] && kill \\\"$usage_partial_pid\\\" 2>/dev/null || true\\nwait \\\"$mem_sampler_pid\\\" 2>/dev/null || true\\n[ -n \\\"${usage_partial_pid:-}\\\" ] && wait \\\"$usage_partial_pid\\\" 2>/dev/null || true\\ntail -n 1 /tmp/si.out\\nif [ \\\"${rc:-0}\\\" -ne 0 ]; then\\n  job_name=\\\"${ELANOUS_POD_NAME:-unknown-job}\\\"\\n  salvage_any=0\\n  while IFS= read -r wt; do\\n    [ -n \\\"$wt\\\" ] || continue\\n    case \\\"$wt\\\" in\\n      /*) ;;\\n      *) printf 'ELANOUS_POD_SALVAGE_NONE bad-worktree-path\\\\n'; continue ;;\\n    esac\\n    wt_name=$(basename -- \\\"$wt\\\")\\n    case \\\"$wt_name\\\" in\\n      ''|.*|*/*|*'..'*) printf 'ELANOUS_POD_SALVAGE_NONE bad-worktree-name\\\\n'; continue ;;\\n    esac\\n    branch=\\\"salvage/${job_name}/${wt_name}\\\"\\n    case \\\"$branch\\\" in\\n      salvage/*) ;;\\n      *) printf 'ELANOUS_POD_SALVAGE_NONE refused-prefix\\\\n'; continue ;;\\n    esac\\n    case \\\"$branch\\\" in\\n      main|self-impl|self-impl/*) printf 'ELANOUS_POD_SALVAGE_NONE refused-prefix\\\\n'; continue ;;\\n    esac\\n    (\\n      set +e\\n      cd -- \\\"$wt\\\" || { printf 'ELANOUS_POD_SALVAGE_NONE cd-failed\\\\n'; exit 0; }\\n      git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf 'ELANOUS_POD_SALVAGE_NONE not-a-worktree\\\\n'; exit 0; }\\n      dirty=0\\n      git diff --quiet || dirty=1\\n      git diff --cached --quiet || dirty=1\\n      if [ -n \\\"$(git ls-files --others --exclude-standard)\\\" ]; then dirty=1; fi\\n      ahead=0\\n      if git rev-parse --verify HEAD >/dev/null 2>&1; then\\n        if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then\\n          if [ \\\"$(git rev-list --count '@{u}..HEAD' 2>/dev/null || true)\\\" != 0 ]; then ahead=1; fi\\n        else\\n          if git rev-parse --verify origin/HEAD >/dev/null 2>&1; then\\n            base=$(git rev-parse origin/HEAD)\\n          elif git rev-parse --verify origin/main >/dev/null 2>&1; then\\n            base=$(git rev-parse origin/main)\\n          else\\n            base=$(git rev-list --max-parents=0 HEAD 2>/dev/null | head -n 1)\\n          fi\\n          if [ -n \\\"$base\\\" ] && [ \\\"$(git rev-list --count \\\"${base}..HEAD\\\" 2>/dev/null || true)\\\" != 0 ]; then ahead=1; fi\\n        fi\\n      fi\\n      if [ \\\"$dirty\\\" -eq 0 ] && [ \\\"$ahead\\\" -eq 0 ]; then\\n        printf 'ELANOUS_POD_SALVAGE_NONE clean\\\\n'\\n        exit 0\\n      fi\\n      if [ \\\"$dirty\\\" -eq 1 ]; then\\n        git add -A -- . || { printf 'ELANOUS_POD_SALVAGE_NONE add-failed\\\\n'; exit 0; }\\n        git commit -m \\\"salvage: ${job_name} rc=${rc}\\\" || { printf 'ELANOUS_POD_SALVAGE_NONE commit-failed\\\\n'; exit 0; }\\n      fi\\n      git push origin \\\"HEAD:refs/heads/${branch}\\\" || { printf 'ELANOUS_POD_SALVAGE_NONE push-failed\\\\n'; exit 0; }\\n      commit=$(git rev-parse HEAD) || { printf 'ELANOUS_POD_SALVAGE_NONE rev-parse-failed\\\\n'; exit 0; }\\n      printf 'ELANOUS_POD_SALVAGE %s %s\\\\n' \\\"$branch\\\" \\\"$commit\\\"\\n    )\\n    salvage_any=1\\n  done < <(git worktree list --porcelain | awk '/^worktree / { sub(/^worktree /, \\\"\\\"); print }')\\n  if [ \\\"$salvage_any\\\" -eq 0 ]; then printf 'ELANOUS_POD_SALVAGE_NONE no-worktree\\\\n'; fi\\nfi\\nexit $rc\"],\"env\":[{\"name\":\"ELANOUS_RUN_ID\",\"value\":\"RUN_ID_PLACEHOLDER\"},{\"name\":\"ELANOUS_SUBSTRATE\",\"value\":\"pod\"},{\"name\":\"ELANOUS_CONTROL_INBOX_DIR\",\"value\":\"/tmp/elanous-control.inbox\"},{\"name\":\"ELANOUS_POD_NAME\",\"valueFrom\":{\"fieldRef\":{\"fieldPath\":\"metadata.name\"}}},{\"name\":\"ELANOUS_NODE_NAME\",\"valueFrom\":{\"fieldRef\":{\"fieldPath\":\"spec.nodeName\"}}},{\"name\":\"ELANOUS_POD_NAMESPACE\",\"valueFrom\":{\"fieldRef\":{\"fieldPath\":\"metadata.namespace\"}}},{\"name\":\"ELANOUS_SUBSTRATE\",\"value\":\"pod\"},{\"name\":\"ELANOUS_RUN_CONTRACT\",\"value\":\"{\\\"substrate\\\":\\\"pod\\\"}\"}],\"volumeMounts\":[{\"name\":\"creds\",\"mountPath\":\"/creds\",\"readOnly\":true}]}],\"volumes\":[{\"name\":\"creds\",\"secret\":{\"secretName\":\"si-human-token-2ed574b3-creds\",\"defaultMode\":256}}]}}}}";
      const actualRunId = child.env.find((entry: { name: string }) => entry.name === 'ELANOUS_RUN_ID').value;
      const expectedHumanJob = JSON.parse(previousHumanJob.replaceAll('RUN_ID_PLACEHOLDER', actualRunId));
      expectedHumanJob.metadata.labels['elanous.child-run'] = actualRunId;
      expectedHumanJob.spec.template.metadata.labels['elanous.child-run'] = actualRunId;
      expectedHumanJob.spec.template.spec.containers[0].env.splice(6, 0, { name: 'ELANOUS_HOST_ID', value: 'frozen-human-host' });
      // POD9 adds the execution identity annotations (attempt 1 on a first launch).
      expect(job.metadata.annotations?.['elanous.dev/attempt']).toBe('1');
      expectedHumanJob.metadata.annotations = job.metadata.annotations;
      // The work label and the minimal fallback-chain config are the intentional additions.
      expectedHumanJob.metadata.labels['elanous.work'] = 'harness';
      expectedHumanJob.spec.template.metadata.labels['elanous.work'] = 'harness';
      // POD-LAUNCH-PROVENANCE slice 2 — the si-task provenance set (labels ⊕ template annotations ⊕ child env) is the intentional addition.
      const provenanceLabels = Object.fromEntries(Object.entries(job.metadata.labels as Record<string, string>).filter(([key]) => key.startsWith('elanous.ai/')));
      expect([provenanceLabels['elanous.ai/kind'], provenanceLabels['elanous.ai/phase']]).toEqual(['si-task', 'impl']);
      expect(Boolean(provenanceLabels['elanous.ai/actor-kind'] && provenanceLabels['elanous.ai/actor'])).toBe(true);
      Object.assign(expectedHumanJob.metadata.labels, provenanceLabels);
      Object.assign(expectedHumanJob.spec.template.metadata.labels, provenanceLabels);
      expectedHumanJob.spec.template.metadata.annotations = job.spec.template.metadata.annotations;
      const provenanceEnv = child.env.filter((entry: { name: string }) => POD_PROVENANCE_ENV_NAMES.includes(entry.name));
      const frozenEnv = expectedHumanJob.spec.template.spec.containers[0].env as Array<{ name: string; value?: string }>;
      // POD-INPLACE-WORKTREE: the explicit disabled default and single-child guard are the only new env fields.
      frozenEnv.splice(frozenEnv.findIndex((entry) => entry.name === 'ELANOUS_SUBSTRATE') + 1, 0,
        { name: 'ELANOUS_POD_SINGLE_CHILD', value: '1' }, { name: 'ELANOUS_POD_INPLACE_WORKTREE', value: '0' });
      frozenEnv.splice(frozenEnv.findIndex((entry) => entry.name === 'ELANOUS_HOST_ID') + 1, 0, ...provenanceEnv);
      // SI-TASK-ADMIT-RIGHTSIZE: the default request is 3Gi; the 16Gi limit stays byte-identical.
      expectedHumanJob.spec.template.spec.containers[0].resources.requests.memory = '3Gi';
      // POD-CPU-REQUEST-RIGHTSIZE (10-09) lowered the harness CPU request 1 → 250m (limit 4 unchanged).
      expectedHumanJob.spec.template.spec.containers[0].resources.requests.cpu = '250m';
      // MF-d3b5a70f (round 2) — 메인 명령이 `& si_pid=$!` + wait 구조로 바뀌고 trap 이 podSigtermTrapScript() 로 갈았다:
      // fixture 의 스크립트를 같은 모양으로 갱신한다(트랩이 grace 안에 발화하고 rc 143 을 보존한다).
      const round2Script = (s: string) => s
        .replace("trap '{ [ -f scripts/usage-rollup.ts ] && bun scripts/usage-rollup.ts --since 12h --partial; } || true' TERM", `si_pid=\"\"\n${podSigtermTrapScript()}`)
        .replace(`elanous self implement "$(cat /creds/feature)" --json '--open-pr' '--no-supervise' > /tmp/si.out 2>&1; rc=$?`, `elanous self implement "$(cat /creds/feature)" --json '--open-pr' '--no-supervise' > /tmp/si.out 2>&1 & si_pid=$!; wait "$si_pid"; rc=$?`);
      // METER-POD-ROLLUP-GAP-2 — 표본기가 방금 낸 seq 를 파일에 적는다(trap 이 +1 해 마지막 PARTIAL 의 seq 를 가장 크게 한다).
      const gap2Script = (s: string) => s.replace('usage_partial_seq=$((usage_partial_seq+1)); [ -f scripts', `usage_partial_seq=$((usage_partial_seq+1)); printf '%s\\n' "$usage_partial_seq" > ${POD_USAGE_PARTIAL_SEQ_FILE} 2>/dev/null || true; [ -f scripts`);
      expectedHumanJob.spec.template.spec.containers[0].args[0] = gap2Script(expectedHumanJob.spec.template.spec.containers[0].args[0] as string);
      expectedHumanJob.spec.template.spec.containers[0].args[0] = round2Script(expectedHumanJob.spec.template.spec.containers[0].args[0] as string);
      expectedHumanJob.spec.template.spec.containers[0].args[0] = (expectedHumanJob.spec.template.spec.containers[0].args[0] as string)
        .replace('[ -f scripts/usage-rollup.ts ] && bun scripts/usage-rollup.ts --since 12h || echo', `${podSalvageScript()}\n${podSalvageBundleScript()}\n[ -f scripts/usage-rollup.ts ] && bun scripts/usage-rollup.ts --since 12h || echo`)
        .replace(`${podSalvageScript()}\nexit $rc`, 'exit $rc');
      // GROK-CHILD-GIT-GUARD (10-11) installs the pre-push guard right after `gh auth setup-git`; everything else is unchanged.
      const frozenArgs = expectedHumanJob.spec.template.spec.containers[0].args as string[];
      // Artifact export has its own focused budget tests; keep this frozen human-token comparison on the remaining Job.
      const exportBlock = (script: string) => script.slice(script.indexOf('set -o pipefail\n'), script.indexOf('\nfound=0'));
      frozenArgs[frozenArgs.length - 1] = frozenArgs[frozenArgs.length - 1]!.replace(
        exportBlock(frozenArgs[frozenArgs.length - 1]!), () => exportBlock(child.args[0]));
      frozenArgs[frozenArgs.length - 1] = frozenArgs[frozenArgs.length - 1]!.replace('gh auth setup-git\n', `gh auth setup-git\n${podGitPushGuardScript(actualRunId)}\n`);
      const snapshotPrelude = child.args[0].slice('set -u\n'.length, child.args[0].indexOf('mkdir -p "$HOME/.elanous"'));
      expect(snapshotPrelude).toContain('/creds/config-snapshot.json');
      expect(snapshotPrelude).toContain('if (h !== e.hash || JSON.stringify(c) !== JSON.stringify(e.keys)) process.exit(1)');
      frozenArgs[frozenArgs.length - 1] = frozenArgs[frozenArgs.length - 1]!.replace('set -u\n', `set -u\n${snapshotPrelude}mkdir -p "$HOME/.elanous" && { [ -e "$HOME/.elanous/config.json" ] || [ -L "$HOME/.elanous/config.json" ] || install -m 600 /creds/llm-fallback-config.json "$HOME/.elanous/config.json"; } || exit 6\necho "ELANOUS_POD_FALLBACK_CHAIN source=default steps=codex-rotate,grok"\n`);
      // The source step intentionally changed for POD-MIRROR-IO. Pin that whole block by hash,
      // then keep byte-for-byte equality for the rest of the frozen human Job.
      const sourceStart = (script: string) => script.slice(script.indexOf('if [ -e repo ]; then exit 5; fi\n'), script.indexOf("printf 'ELANOUS_POD_SOURCE_VIA"));
      const currentSourceStart = sourceStart(child.args[0]);
      expect(createHash('sha256').update(currentSourceStart).digest('hex')).toBe('c586f42492c51da561829089905124e4e25a901390ed10de872f5feb04d1c1f9');
      frozenArgs[frozenArgs.length - 1] = frozenArgs[frozenArgs.length - 1]!.replace(sourceStart(frozenArgs[frozenArgs.length - 1]!), currentSourceStart);
      const sourceTail = (script: string) => script.slice(script.indexOf("printf 'ELANOUS_POD_SOURCE_VIA"), script.indexOf("printf 'ELANOUS_POD_SOURCE default"));
      const currentSourceTail = sourceTail(child.args[0]);
      expect(createHash('sha256').update(currentSourceTail).digest('hex')).toBe('3aa8d082b6e63d5f9204694bcf50b2b886229c5c62353f4bb3e7a445a5ce76c8');
      frozenArgs[frozenArgs.length - 1] = frozenArgs[frozenArgs.length - 1]!.replace(sourceTail(frozenArgs[frozenArgs.length - 1]!), currentSourceTail);
      const sourceIoPrelude = (script: string) => {
        const start = script.indexOf('pod_source_io_origin_calls=');
        if (start < 0) return '';
        return script.slice(start, script.indexOf('if [ -e repo ]; then exit 5; fi\n', start));
      };
      frozenArgs[frozenArgs.length - 1] = frozenArgs[frozenArgs.length - 1]!.replace(
        'if [ -e repo ]; then exit 5; fi\n', `${sourceIoPrelude(child.args[0])}if [ -e repo ]; then exit 5; fi\n`,
      );
      // SI-POD-STAGE-MARKERS — Pod 시계 단계 표지: clone 은 소스 받기 앞뒤 · run 은 본체 앞뒤(rc 줄 뒤). 문자열 고정(재생성 아님).
      const marker = (stage: string, edge: string) => `printf 'ELANOUS_POD_STAGE ${stage} ${edge} %s\\n' "$(date +%s)" || true`;
      frozenArgs[frozenArgs.length - 1] = frozenArgs[frozenArgs.length - 1]!
        .replace(`exit 3; }\n${sourceIoPrelude(child.args[0])}if [ -e repo ]; then exit 5; fi\n`, `exit 3; }\n${marker('clone', 'start')}\n${sourceIoPrelude(child.args[0])}if [ -e repo ]; then exit 5; fi\n`)
        .replace(`printf 'ELANOUS_POD_SOURCE default %s\\n' "$head"\n`, `printf 'ELANOUS_POD_SOURCE default %s\\n' "$head"\npod_source_io_emit\n${marker('clone', 'end')}\nprintf 'ELANOUS_POD_DEPS skipped %s image-prepared-no-install\\n' "$(date +%s)" || true\n`)
        .replace('export ELANOUS_HARNESS_ENTRANCE=self-implement; elanous self implement', `${marker('run', 'start')}\nexport ELANOUS_HARNESS_ENTRANCE=self-implement; elanous self implement`)
        .replace('wait "$si_pid"; rc=$?\ncat /tmp/si.out\n', `wait "$si_pid"; rc=$?; ${marker('run', 'end')}\ncat /tmp/si.out\n`);
      frozenArgs[frozenArgs.length - 1] = frozenArgs[frozenArgs.length - 1]!
        .replace(`${marker('run', 'end')}\ncat /tmp/si.out\n`, `${marker('run', 'end')}; ${POD_RESULT_FLATTEN}\ncat /tmp/si.out\n`);
      // Deadline watchdog has its own executable short-deadline test above. This frozen comparison
      // checks that host-token refresh did not change the remaining human Job bytes.
      const withoutDeadlineWatchdog = (script: string): string => script
        .replace(`${podDeadlineWatchdogScript({ deadlineSeconds: 10_800, job: job.metadata.name, runId: actualRunId })}\n`, '')
        .replace("printf 'setup\\n' > /tmp/si.stage\n", '')
        .replace("printf 'run\\n' > /tmp/si.stage\n", '')
        .replace("; printf '%s\\n' \"$si_pid\" > /tmp/si.pid", '')
        .replace('; touch /tmp/si.finished', '')
        .replace('; rm -f /tmp/si.pid', '')
        .replace(`; ${POD_DEADLINE_AFTER_WAIT}`, '')
        .replace('if [ "$rc" -ne 0 ] && [ -f /tmp/si.deadline-result ]; then rc=124; fi\n', '')
        .replace('touch /tmp/si.finished; kill "$si_deadline_watch_pid" 2>/dev/null || true; [ -f /tmp/si.deadline-marker ] && cat /tmp/si.deadline-marker || true\n', '');
      const withoutWatchdogJob = structuredClone(job);
      withoutWatchdogJob.spec.template.spec.containers[0].args[0] = withoutDeadlineWatchdog(child.args[0]);
      expect(JSON.stringify(withoutWatchdogJob)).toBe(JSON.stringify(expectedHumanJob));
      expect(child.args[0]).toContain('export GH_TOKEN="$(cat /creds/gh-token)"');
      expect(human.calls.filter((call) => call.args.includes('exec') && call.args.includes('--with-token'))).toHaveLength(0);
    } finally {
      off();
      if (savedPolicy === undefined) delete process.env.ELANOUS_CODEX_QUOTA_POLICY; else process.env.ELANOUS_CODEX_QUOTA_POLICY = savedPolicy;
    }
  });

  test('host-bound run token from Pod issuance reaches GitHub relay for exactly its repository', async () => {
    resetPodCredentialRateForTesting();
    const applied: string[] = [];
    const revoked: string[] = [];
    const now = Date.parse('2026-09-26T12:00:00Z');
    const tokenDeps = { key: async () => 'run-signing-key', now: () => now, revokedPath: join(mkdtempSync(join(tmpdir(), 'pod-gh-')), 'revoked.jsonl') };
    const issued: string[] = [];
    const minted: Array<{ runId: string; job: string; ttlMs: number; scope?: string; repository?: string }> = [];
    await podSelfImplementSpawn({
      kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {}, credentials: CREDS,
      repoUrl: 'https://github.com/host-owner/run-repo.git', env: { ELANOUS_RUN_ID: 'host-run', ELANOUS_POD_GITHUB_CREDENTIAL_TOKEN: 'attacker-token' },
      passEnv: ['ELANOUS_POD_GITHUB_CREDENTIAL_TOKEN'], armEnv: { ELANOUS_POD_GITHUB_CREDENTIAL_TOKEN: 'attacker-token' },
      groundingUrl: 'https://host:31415',
      now: () => now,
      githubInstallation: (repository) => { issued.push(repository); return { token: 'initial-installation', expires_at: new Date(now + 3600_000).toISOString() }; },
      githubRepositories: async () => ['host-owner/run-repo'],
      mintGrounding: (claims) => { minted.push(claims); return mintGroundingToken(claims, tokenDeps); }, revokeGrounding: (runId) => revoked.push(runId),
    })({ spaceId: 's', feature: 'f' }).done;
    expect(minted).toEqual([
      { runId: 'host-run', job: podJobName('s'), ttlMs: POD_JOB_DEADLINE_SECONDS * 1000 },
      { runId: 'host-run', job: podJobName('s'), ttlMs: POD_JOB_DEADLINE_SECONDS * 1000, scope: 'gh-credential', repository: 'host-owner/run-repo' },
    ]);
    const secret = JSON.parse(applied.find((a) => a.includes('"kind":"Secret"'))!) as { stringData: Record<string, string> };
    const job = applied.find((a) => a.includes('"kind":"Job"'))!;
    expect(secret.stringData['gh-token']).toBe('initial-installation');
    const bearer = secret.stringData['env-ELANOUS_POD_GITHUB_CREDENTIAL_TOKEN'];
    expect(typeof bearer).toBe('string');
    expect(job).not.toContain(bearer!);
    expect(job).not.toContain('attacker-token');
    expect(secret.stringData['env-ELANOUS_POD_GITHUB_CREDENTIAL_TOKEN']).not.toBe('attacker-token');
    expect(job).toContain('"name":"ELANOUS_POD_GITHUB_CREDENTIAL_TOKEN","valueFrom":{"secretKeyRef"');
    expect(job).toContain('"name":"ELANOUS_POD_GITHUB_CREDENTIAL_URL","value":"https://host:31415/v1/pod/credential/github"');
    const response = await handlePodGithubCredential(new Request('https://host:31415/v1/pod/credential/github', {
      method: 'POST', headers: { authorization: `Bearer ${bearer}` }, body: JSON.stringify({ repository: 'attacker-repo' }),
    }), { token: tokenDeps, now: () => now, mintInstallation: (repository) => {
      issued.push(repository);
      return { token: 'fresh-installation', expires_at: new Date(now + 3600_000).toISOString() };
    }, installationRepositories: async () => ['host-owner/run-repo'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: 'fresh-installation', expires_at: new Date(now + 3600_000).toISOString() });
    expect(issued).toEqual(['host-owner/run-repo', 'host-owner/run-repo']);
    expect(revoked).toEqual(['host-run']);
    resetPodCredentialRateForTesting();
  });
  test('with a grounding URL: token only in the Secret, URL as plain env, revoked when the Job ends', async () => {
    const applied: string[] = [];
    const revoked: string[] = [];
    await podSelfImplementSpawn({
      kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {}, credentials: CREDS, env: { ELANOUS_RUN_ID: 'run-g1' },
      groundingUrl: 'http://100.64.0.1:31415', mintGrounding: async (c) => ({ token: `tok-for-${c.runId}`, exp: 9 }), revokeGrounding: (r) => revoked.push(r),
    })({ spaceId: 's', feature: 'f' }).done;
    const secret = applied.find((a) => a.includes('"kind":"Secret"'))!;
    const job = applied.find((a) => a.includes('"kind":"Job"'))!;
    expect(JSON.parse(secret).stringData['env-ELANOUS_GROUNDING_TOKEN']).toBe('tok-for-run-g1');
    expect(job).not.toContain('tok-for-run-g1');   // 매니페스트에는 값이 없다 — secretKeyRef 만
    expect(job).toContain('"name":"ELANOUS_GROUNDING_TOKEN","valueFrom":{"secretKeyRef"');
    expect(job).toContain('"name":"ELANOUS_GROUNDING_URL","value":"http://100.64.0.1:31415"');
    expect(revoked).toEqual(['run-g1']);
  });
  test('grok subscription with a grounding URL mints llm-credential onto the same run and the same revoke', async () => {
    const applied: string[] = [];
    const minted: Array<{ runId: string; job: string; ttlMs: number; scope?: string }> = [];
    const revoked: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement.pod' && (event === 'credential-relay' || event === 'credential-relay-skipped')) events.push({ event, ...(data ?? {}) });
    }) as typeof debug.log);
    try {
      await podSelfImplementSpawn({
        githubInstallation: () => null,
        provider: 'grok', kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {},
        grokCredentials: () => ({ grokAuth: JSON.stringify({ scope: { key: 'access-x' } }), ghToken: 'gh' }),
        env: { ELANOUS_RUN_ID: 'run-g1' }, deadlineSeconds: 180,
        groundingUrl: 'https://host:31415',
        mintGrounding: async (c) => { minted.push({ ...c }); return { token: c.scope === 'llm-credential' ? 'relay-tok' : `tok-for-${c.runId}`, exp: 9 }; },
        revokeGrounding: (r) => revoked.push(r),
      })({ spaceId: 's', feature: 'f' }).done;
    } finally { logSpy.mockRestore(); }
    const secret = JSON.parse(applied.find((a) => a.includes('"kind":"Secret"'))!);
    const job = applied.find((a) => a.includes('"kind":"Job"'))!;
    expect(minted).toEqual([
      { runId: 'run-g1', job: podJobName('s'), ttlMs: 180_000 },
      { runId: 'run-g1', job: podJobName('s'), ttlMs: 180_000, scope: 'llm-credential' },
    ]);
    expect(secret.stringData['env-ELANOUS_GROUNDING_TOKEN']).toBe('tok-for-run-g1');
    expect(secret.stringData['env-ELANOUS_POD_CREDENTIAL_TOKEN']).toBe('relay-tok');
    expect(job).not.toContain('relay-tok');
    expect(job).toContain('"name":"ELANOUS_POD_CREDENTIAL_TOKEN","valueFrom":{"secretKeyRef"');
    expect(job).toContain('"name":"ELANOUS_POD_CREDENTIAL_URL","value":"https://host:31415/v1/pod/credential/grok"');
    expect(job).not.toContain('elanous.egress/host-grounding');
    expect(revoked).toEqual(['run-g1']);
    expect(events).toEqual([{ event: 'credential-relay', job: podJobName('s'), runId: 'run-g1', exp: 9 }]);
    expect(JSON.stringify(events)).not.toContain('relay-tok');
  });
  test('codex with a grounding URL does not mint llm-credential', async () => {
    const applied: string[] = [];
    const minted: Array<{ scope?: string }> = [];
    await podSelfImplementSpawn({
        githubInstallation: () => null,
      kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {},
      credentials: () => ({ ...CREDS(), grokAuth: JSON.stringify({ scope: { key: 'access-x' } }) }),
      env: { ELANOUS_RUN_ID: 'run-g1' },
      groundingUrl: 'https://host:31415',
      mintGrounding: async (c) => { minted.push({ ...(c.scope ? { scope: c.scope } : {}) }); return { token: `tok-for-${c.runId}`, exp: 9 }; },
      revokeGrounding: () => {},
    })({ spaceId: 's', feature: 'f' }).done;
    const secret = JSON.parse(applied.find((a) => a.includes('"kind":"Secret"'))!);
    const job = applied.find((a) => a.includes('"kind":"Job"'))!;
    expect(minted).toEqual([{}]);
    expect(secret.stringData['env-ELANOUS_POD_CREDENTIAL_TOKEN']).toBeUndefined();
    expect(job).not.toContain('ELANOUS_POD_CREDENTIAL');
    expect(job).toContain('"name":"ELANOUS_GROUNDING_URL","value":"https://host:31415"');
  });
  test('without a grounding URL nothing is minted', async () => {
    const applied: string[] = [];
    let minted = 0;
    await podSelfImplementSpawn({
      kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {}, credentials: CREDS, env: {},
      mintGrounding: async () => { minted++; return { token: 't', exp: 1 }; }, revokeGrounding: () => { throw new Error('must not revoke'); },
    })({ spaceId: 's', feature: 'f' }).done;
    expect(minted).toBe(0);
    expect(applied.join('')).not.toContain('GROUNDING');
  });
  test('grok subscription without a grounding URL skips the credential relay', async () => {
    const applied: string[] = [];
    const minted: unknown[] = [];
    const events: Array<Record<string, unknown>> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement.pod' && event === 'credential-relay-skipped') events.push(data ?? {});
    }) as typeof debug.log);
    try {
      await podSelfImplementSpawn({
        provider: 'grok', kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {},
        grokCredentials: () => ({ grokAuth: JSON.stringify({ scope: { key: 'access-x' } }), ghToken: 'gh' }),
        env: {},
        mintGrounding: async (c) => { minted.push(c); return { token: 't', exp: 1 }; },
        revokeGrounding: () => { throw new Error('must not revoke'); },
      })({ spaceId: 's', feature: 'f' }).done;
    } finally { logSpy.mockRestore(); }
    expect(minted).toEqual([]);
    expect(applied.join('')).not.toContain('ELANOUS_POD_CREDENTIAL');
    expect(applied.join('')).not.toContain('GROUNDING');
    expect(events).toEqual([{ reason: 'no-host-url' }]);
  });
  test('grok API key with a grounding URL does not mint llm-credential', async () => {
    const applied: string[] = [];
    const minted: Array<{ scope?: string }> = [];
    await podSelfImplementSpawn({
        githubInstallation: () => null,
      provider: 'grok', grokApiKeyOptIn: true, kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {},
      grokCredentials: () => ({ grokApiKey: 'paid-key', ghToken: 'gh' }),
      env: {}, groundingUrl: 'https://host:31415',
      mintGrounding: async (c) => { minted.push({ ...(c.scope ? { scope: c.scope } : {}) }); return { token: 'ground-tok', exp: 1 }; },
      revokeGrounding: () => {},
    })({ spaceId: 's', feature: 'f' }).done;
    const secret = JSON.parse(applied.find((a) => a.includes('"kind":"Secret"'))!);
    const job = applied.find((a) => a.includes('"kind":"Job"'))!;
    expect(minted).toEqual([{}]);
    expect(secret.stringData['env-ELANOUS_POD_CREDENTIAL_TOKEN']).toBeUndefined();
    expect(job).not.toContain('ELANOUS_POD_CREDENTIAL');
  });
});

describe('pod job deadline', () => {
  test('기본 Job 수명 상한은 180분이다', () => {
    expect(POD_JOB_DEADLINE_SECONDS).toBe(10_800);
  });
});

function jobScript(): string {
  const manifest = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
  return manifest.spec.template.spec.containers[0]!.args[0]!;
}

describe('pod salvage', () => {
  test('fake gh PR failure runs Pod scripts and production host collection records the clone-verified bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-salvage-e2e-'));
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const bare = join(root, 'remote.git');
    const repo = join(root, 'repo');
    const worktree = join(root, 'wt-commit');
    const hostClone = join(root, 'host-clone');
    const state = join(root, 'state');
    mkdirSync(home); mkdirSync(bin); mkdirSync(state);
    try {
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      execFileSync('git', ['-C', repo, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', repo, 'config', 'user.name', 'pod']);
      writeFileSync(join(repo, 'base.txt'), 'base\n');
      execFileSync('git', ['-C', repo, 'add', 'base.txt']);
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
      execFileSync('git', ['init', '--bare', '-q', bare]);
      execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare]);
      execFileSync('git', ['-C', bare, 'fetch', '-q', repo, 'main:main']);
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'child', worktree]);
      writeFileSync(join(worktree, 'kept.txt'), 'preserved\n');
      writeFileSync(join(worktree, 'large.bin'), randomBytes(6 * 1024 * 1024));
      execFileSync('git', ['-C', worktree, 'add', 'kept.txt', 'large.bin']);
      execFileSync('git', ['-C', worktree, 'commit', '-qm', 'preserved']);
      execFileSync('git', ['-C', worktree, 'branch', '--set-upstream-to=main', 'child']);
      const gh = join(bin, 'gh');
      writeFileSync(gh, '#!/bin/sh\necho fake-gh-pr-create-failed >&2\nexit 1\n');
      chmodSync(gh, 0o755);
      const elanous = join(bin, 'elanous');
      writeFileSync(elanous, '#!/bin/sh\nif [ "$1 $2" = "self implement" ]; then gh pr create --draft; echo \'{"stage":"error","ok":false,"error":"draft PR 생성 실패: fake gh exit 1"}\'; exit 1; fi\nexit 1\n');
      chmodSync(elanous, 0o755);
      const sourceHead = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const manifestScript = jobScript();
      const childStart = manifestScript.lastIndexOf('\n', manifestScript.indexOf('elanous self implement "$(cat /creds/feature)" --json')) + 1;
      const childTail = manifestScript.slice(childStart).replaceAll('/tmp/si.out', join(root, 'si.out'));
      // Execute the generated child-command-to-exit path; only the mounted Secret path and output file are isolated.
      const run = Bun.spawnSync(['bash', '-c', `cat() { if [ "$1" = /creds/feature ]; then printf 'fixture'; else command cat "$@"; fi; }\nmem_sampler_pid=''\nusage_partial_pid=''\n${childTail}`], {
        cwd: repo, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ELANOUS_STATE_DIR: state, ELANOUS_POD_CHILD_OUTPUT: join(root, 'si.out') },
      });
      expect(run.exitCode).toBe(1);
      expect(run.stdout.toString()).toContain('fake-gh-pr-create-failed');
      const podBundle = join(home, 'outbox', 'pod-salvage', 'wt-commit.bundle');
      const podBundleBytes = readFileSync(podBundle);
      expect(podBundleBytes.length).toBeGreaterThan(5 * 1024 * 1024);
      const parsedArtifact = parsePodArtifactChunks(run.stdout.toString());
      expect(Array.isArray(parsedArtifact)).toBe(true);
      if (!Array.isArray(parsedArtifact)) throw new Error(JSON.stringify(parsedArtifact.error));
      expect(parsedArtifact.find((a) => a.path === 'pod-salvage/wt-commit.bundle')?.bytes).toEqual(podBundleBytes);
      const stateRoot = join(root, 'host-state');
      mkdirSync(stateRoot);
      const oldState = process.env.ELANOUS_STATE_DIR;
      process.env.ELANOUS_STATE_DIR = stateRoot;
      try {
        const childJson = '{"stage":"error","ok":false,"error":"draft PR 생성 실패: fake gh exit 1"}';
        const kubectl: Kubectl = (args) => {
          if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
          if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
          if (args.includes('get')) return { status: 0, stdout: 'Complete', stderr: '' };
          if (args.includes('logs')) return { status: 0, stdout: args.includes('--tail=400') ? `${childJson}\\n` : `${run.stdout.toString()}${childJson}\\n`, stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        };
        await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_RUN_ID: 'run-salvage-e2e-parent', ELANOUS_STATE_DIR: stateRoot } })({ feature: 'x', spaceId: 'salvage-e2e' }).done;
        const returnedBundle = join(effectiveInstanceRoot(), 'pod-artifacts', podJobName('salvage-e2e'), 'pod-salvage', 'wt-commit.bundle');
        expect(existsSync(returnedBundle)).toBe(true);
        expect(readFileSync(returnedBundle)).toEqual(podBundleBytes);
        expect(readFileSync(returnedBundle).length).toBeGreaterThan(5 * 1024 * 1024);
        execFileSync('git', ['clone', '-q', '-b', 'child', returnedBundle, hostClone]);
        expect(execFileSync('git', ['-C', hostClone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(sourceHead);
        const parentLedger = readFileSync(runLedgerPath('run-salvage-e2e-parent', runLedgerDir(stateRoot)), 'utf8');
        expect(parentLedger).toContain('"event":"pod-salvage-bundle"');
        expect(parentLedger).toContain('"commitCount":1,"diffLines":1');
        expect(parentLedger).toContain(`"head":"${sourceHead}"`);
        expect(parentLedger).not.toContain('fake-gh-pr-create-failed');
        expect(readFileSync(returnedBundle).includes(Buffer.from('fake-gh-pr-create-failed'))).toBe(false);
      } finally {
        if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR;
        else process.env.ELANOUS_STATE_DIR = oldState;
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('POD-PR-FAIL-SALVAGE-BUNDLE: failure creates a credential-free commit bundle before outbox export', () => {
    const script = jobScript();
    expect(script).toContain('ELANOUS_POD_SALVAGE_BUNDLE');
    expect(script).toContain('pod-salvage/$wt_name.bundle');
    expect(script).toContain('commitCount');
    expect(script).toContain('diffLines');
    expect(script.indexOf('pod-salvage/salvage.bundle')).toBeLessThan(script.indexOf('artifact_bytes=0'));
  });

  test('oversized salvage bundle is skipped before base64 export and leaves an explicit receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-salvage-size-'));
    const home = join(root, 'home');
    const salvage = join(home, 'outbox', 'pod-salvage');
    try {
      mkdirSync(salvage, { recursive: true });
      writeFileSync(join(salvage, 'too-large.bundle'), '');
      truncateSync(join(salvage, 'too-large.bundle'), 160 * 1024 * 1024 + 1);
      const script = jobScript();
      const exportScript = script.slice(script.indexOf('set -o pipefail\n'), script.indexOf('\nfound=0'));
      const run = Bun.spawnSync(['bash', '-c', exportScript], { env: { ...process.env, HOME: home } });
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toContain('ELANOUS_POD_ARTIFACT_SKIPPED pod-salvage/too-large.bundle 167772161');
      expect(run.stdout.toString()).not.toContain('ELANOUS_POD_ARTIFACT ');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('bundle export keeps a separate budget from ordinary diagnostic artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-salvage-budgets-'));
    const home = join(root, 'home');
    try {
      for (let i = 0; i < 4; i++) {
        const path = join(home, 'outbox', 'diagnostics', `log-${i}.txt`);
        mkdirSync(join(home, 'outbox', 'diagnostics'), { recursive: true });
        writeFileSync(path, Buffer.alloc(5 * 1024 * 1024));
      }
      const salvage = join(home, 'outbox', 'pod-salvage');
      mkdirSync(salvage, { recursive: true });
      for (const name of ['one.bundle', 'two.bundle']) {
        const path = join(salvage, name);
        writeFileSync(path, '');
        truncateSync(path, 81 * 1024 * 1024);
      }
      const script = jobScript();
      const exportScript = script.slice(script.indexOf('set -o pipefail\n'), script.indexOf('\nfound=0'));
      const run = Bun.spawnSync(['bash', '-c', exportScript], { env: { ...process.env, HOME: home } });
      expect(run.exitCode).toBe(0);
      const output = run.stdout.toString();
      expect(output).not.toContain('ELANOUS_POD_ARTIFACT_SKIPPED');
      for (const name of ['one.bundle', 'two.bundle']) {
        expect(output).toContain(`ELANOUS_POD_ARTIFACT ${Buffer.from(`pod-salvage/${name}`).toString('base64url')}`);
      }
      for (let i = 0; i < 4; i++) {
        expect(output).toContain(`ELANOUS_POD_ARTIFACT ${Buffer.from(`diagnostics/log-${i}.txt`).toString('base64url')}`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('bundle script preserves committed worktree history and reports zero commits without a bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-salvage-bundle-'));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    const worktree = join(root, 'wt-commit');
    const clone = join(root, 'clone');
    try {
      mkdirSync(home);
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      execFileSync('git', ['-C', repo, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', repo, 'config', 'user.name', 'pod']);
      writeFileSync(join(repo, 'base.txt'), 'base\\n');
      execFileSync('git', ['-C', repo, 'add', 'base.txt']);
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'child', worktree]);
      writeFileSync(join(worktree, 'kept.txt'), 'kept\\n');
      execFileSync('git', ['-C', worktree, 'add', 'kept.txt']);
      execFileSync('git', ['-C', worktree, 'commit', '-qm', 'kept']);
      execFileSync('git', ['-C', worktree, 'branch', '--set-upstream-to=main', 'child']);
      const childOutput = join(root, 'si.out');
      writeFileSync(childOutput, 'draft PR 생성 실패\n');
      const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), ELANOUS_POD_CHILD_OUTPUT: childOutput };
      const result = Bun.spawnSync(['bash', '-c', `rc=7\n${podSalvageBundleScript()}`], { cwd: repo, env });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('ELANOUS_POD_SALVAGE_BUNDLE pod-salvage/wt-commit.bundle 1 1');
      writeFileSync(childOutput, 'unit test failure\n');
      const otherFailure = Bun.spawnSync(['bash', '-c', `rc=7\n${podSalvageBundleScript()}`], { cwd: repo, env });
      expect(otherFailure.stdout.toString()).toBe('');
      writeFileSync(childOutput, 'draft PR 생성 실패\n');
      const bundlePath = join(home, 'outbox', 'pod-salvage', 'wt-commit.bundle');
      const expected = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      expect(existsSync(bundlePath)).toBe(true);
      execFileSync('git', ['clone', '-q', '-b', 'child', bundlePath, clone]);
      expect(execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(expected);
      execFileSync('git', ['-C', repo, 'worktree', 'remove', '-f', worktree]);
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'child-empty', join(root, 'wt-empty'), 'main']);
      const empty = Bun.spawnSync(['bash', '-c', `rc=7\n${podSalvageBundleScript()}`], { cwd: repo, env });
      expect(empty.stdout.toString()).toContain('ELANOUS_POD_SALVAGE_NONE no-commits');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('commit inspection failures are preservation failures, never no-commits or successful bundle records', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-salvage-count-failure-'));
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const repo = join(root, 'repo');
    const worktree = join(root, 'wt-count');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    try {
      mkdirSync(home); mkdirSync(bin);
      execFileSync(realGit, ['init', '-q', '-b', 'main', repo]);
      execFileSync(realGit, ['-C', repo, 'config', 'user.email', 'pod@example.com']);
      execFileSync(realGit, ['-C', repo, 'config', 'user.name', 'pod']);
      writeFileSync(join(repo, 'base.txt'), 'base\\n');
      execFileSync(realGit, ['-C', repo, 'add', 'base.txt']);
      execFileSync(realGit, ['-C', repo, 'commit', '-qm', 'base']);
      execFileSync(realGit, ['-C', repo, 'worktree', 'add', '-q', '-b', 'child', worktree]);
      writeFileSync(join(worktree, 'kept.txt'), 'kept\\n');
      execFileSync(realGit, ['-C', worktree, 'add', 'kept.txt']);
      execFileSync(realGit, ['-C', worktree, 'commit', '-qm', 'kept']);
      const childOutput = join(root, 'si.out');
      writeFileSync(childOutput, 'draft PR 생성 실패\n');
      const wrapper = join(bin, 'git');
      for (const fault of ['--count', '--numstat']) {
        writeFileSync(wrapper, `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = ${fault} ] && exit 1; done\nexec ${realGit} "$@"\n`);
        chmodSync(wrapper, 0o755);
        const result = Bun.spawnSync(['bash', '-c', `rc=7\n${podSalvageBundleScript()}`], {
          cwd: repo, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ELANOUS_POD_CHILD_OUTPUT: childOutput },
        });
        const output = result.stdout.toString();
        expect(output).toContain('ELANOUS_POD_SALVAGE_FAILED incomplete');
        expect(output).not.toContain('ELANOUS_POD_SALVAGE_NONE no-commits');
        expect(output).not.toContain('ELANOUS_POD_SALVAGE_BUNDLE');
      }
      writeFileSync(wrapper, `#!/bin/sh\nprevious=\nfor arg in "$@"; do\n  if [ "$previous" = create ]; then truncate -s 167772161 "$arg"; exit $?; fi\n  previous="$arg"\ndone\nexec ${realGit} "$@"\n`);
      chmodSync(wrapper, 0o755);
      const oversized = Bun.spawnSync(['bash', '-c', `rc=7\n${podSalvageBundleScript()}`], {
        cwd: repo, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ELANOUS_POD_CHILD_OUTPUT: childOutput },
      });
      expect(oversized.stdout.toString()).toContain('ELANOUS_POD_SALVAGE_FAILED size-limit wt-count 167772161');
      expect(oversized.stdout.toString()).not.toContain('ELANOUS_POD_SALVAGE_BUNDLE');
      expect(existsSync(join(home, 'outbox', 'pod-salvage', 'wt-count.bundle'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('manifest salvages only when rc is not 0, pushes only under salvage/, and keeps exit $rc last', () => {
    const script = jobScript();
    const salvage = podSalvageScript();
    expect(script).toContain(salvage);
    expect(script.trimEnd().endsWith('exit $rc')).toBe(true);
    expect(script.indexOf(salvage)).toBeLessThan(script.indexOf('ELANOUS_POD_SALVAGE_BUNDLE'));
    expect(script.indexOf('ELANOUS_POD_SALVAGE_BUNDLE')).toBeLessThan(script.indexOf('artifact_bytes=0'));
    expect(script.indexOf(salvage)).toBeLessThan(script.lastIndexOf('exit $rc'));
    expect(salvage.startsWith('if [ "${rc:-0}" -ne 0 ]; then')).toBe(true);
    expect(salvage).toContain('git worktree list --porcelain');
    expect(salvage).toContain('branch="salvage/${job_name}/${wt_name}"');
    expect(salvage).toContain('git push origin "HEAD:refs/heads/${branch}"');
    expect(salvage).toContain('git commit -m "salvage: ${job_name} rc=${rc}"');
    expect(salvage).toContain("printf 'ELANOUS_POD_SALVAGE %s %s\\n'");
    expect(salvage).toContain("printf 'ELANOUS_POD_SALVAGE_NONE clean\\n'");
    expect(salvage).not.toMatch(/git push[^\\n]*\bmain\b/);
    expect(salvage).not.toMatch(/git push[^\\n]*self-impl\//);
    const rc0 = Bun.spawnSync(['bash', '-c', `rc=0\n${salvage}\necho AFTER:$?`], { env: { ...process.env, ELANOUS_POD_NAME: 'job-a' } });
    expect(rc0.exitCode).toBe(0);
    expect(rc0.stdout.toString()).toBe('AFTER:0\n');
    expect(rc0.stdout.toString()).not.toContain('ELANOUS_POD_SALVAGE');
  });

  test('real bash against a local bare remote salvages a dirty worktree and prints NONE for a clean one', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-salvage-'));
    try {
      const bare = join(root, 'remote.git');
      const main = join(root, 'main');
      const dirty = join(root, 'wt-dirty');
      const clean = join(root, 'wt-clean');
      execFileSync('git', ['init', '--bare', '-q', bare]);
      execFileSync('git', ['clone', '-q', bare, main]);
      execFileSync('git', ['-C', main, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', main, 'config', 'user.name', 'pod']);
      execFileSync('git', ['-C', main, 'config', 'core.hooksPath', '/dev/null']);
      writeFileSync(join(main, 'README'), 'base\n');
      execFileSync('git', ['-C', main, 'add', 'README']);
      execFileSync('git', ['-C', main, 'commit', '-qm', 'base']);
      execFileSync('git', ['-C', main, 'push', '-q', 'origin', 'HEAD:refs/heads/main']);
      execFileSync('git', ['-C', main, 'fetch', '-q', 'origin']);
      execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'child-dirty', dirty, 'origin/main']);
      execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'child-clean', clean, 'origin/main']);
      writeFileSync(join(dirty, 'changed.txt'), 'kept\n');
      const salvage = podSalvageScript();
      const testHome = join(root, 'home');
      mkdirSync(testHome);
      const env = { ...process.env, HOME: testHome, GIT_CONFIG_GLOBAL: join(testHome, '.gitconfig'), ELANOUS_POD_NAME: 'job-a', GIT_AUTHOR_NAME: 'pod', GIT_AUTHOR_EMAIL: 'pod@example.com', GIT_COMMITTER_NAME: 'pod', GIT_COMMITTER_EMAIL: 'pod@example.com' };
      const failed = Bun.spawnSync(['bash', '-c', `cd ${main} && rc=7\n${salvage}\nexit $rc`], { env });
      expect(failed.exitCode).toBe(7);
      const lines = failed.stdout.toString().trim().split('\n');
      const pushed = lines.find((line) => line.startsWith('ELANOUS_POD_SALVAGE '));
      expect(pushed).toBeDefined();
      const [, branch, commit] = pushed!.split(' ');
      expect(branch).toBe('salvage/job-a/wt-dirty');
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      expect(lines).toContain('ELANOUS_POD_SALVAGE_NONE clean');
      expect(execFileSync('git', ['-C', bare, 'rev-parse', branch], { encoding: 'utf8' }).trim()).toBe(commit);
      expect(execFileSync('git', ['-C', bare, 'ls-tree', '-r', '--name-only', commit], { encoding: 'utf8' })).toContain('changed.txt');
      const subject = execFileSync('git', ['-C', bare, 'log', '-1', '--format=%s', commit], { encoding: 'utf8' }).trim();
      expect(subject).toBe('salvage: job-a rc=7');
      expect(execFileSync('git', ['-C', bare, 'branch', '--list', 'salvage/*'], { encoding: 'utf8' })).toContain('salvage/job-a/wt-dirty');
      // `--format` — `* main` 여부는 bare 저장소 HEAD(= git 기본 브랜치 설정)에 따라 달라진다(Pod linux ↔ mac).
      expect(execFileSync('git', ['-C', bare, 'branch', '--list', 'main', '--format=%(refname:short)'], { encoding: 'utf8' }).trim()).toBe('main');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('Job log salvage line is recorded as salvage-pushed and appended to the human run-result line', async () => {
    const branch = 'salvage/job-a/wt-dirty';
    const commit = 'abc123def456';
    const json = JSON.stringify({ stage: 'gate-failed', ok: false });
    const logs = `noise\nELANOUS_POD_SALVAGE ${branch} ${commit}\n${json}\n`;
    const events: Array<Record<string, unknown>> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement.pod' && event === 'salvage-pushed') events.push(data ?? {});
    }) as typeof debug.log);
    const { k } = fakeKubectl(['Failed'], logs);
    try {
      const result = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS })({ feature: 'x', spaceId: 'salvage-host' }).done;
      expect(events).toEqual([{ job: podJobName('salvage-host'), branch, commit }]);
      expect(result.output).toContain(`수확할 브랜치: ${branch}`);
      expect(recordPodSalvage('ELANOUS_POD_SALVAGE main deadbeef\nELANOUS_POD_SALVAGE_NONE clean\n', 'j', () => { throw new Error('must not log'); })).toEqual([]);
    } finally { logSpy.mockRestore(); }
  });
});

describe('Pod 자식 요청(requests) — 예약은 실사용에, 상한은 그대로 (2026-09-27)', () => {
  test('podJobManifest 는 cpu 250m · 메모리 3Gi 를 요청하고 상한 cpu 4 · 16Gi 를 유지한다(POD-CPU-REQUEST-RIGHTSIZE)', () => {
    const m = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ resources: { requests?: Record<string, string>; limits: Record<string, string> } }> } } } };
    const r = m.spec.template.spec.containers[0]!.resources;
    expect(r.requests).toEqual({ cpu: '250m', memory: '3Gi' });
    expect(r.limits).toEqual({ memory: '16Gi', cpu: '4' });
  });
});


describe('pod log export stays under the artifact limit instead of being skipped', () => {
  test('an oversized export keeps the newest whole lines under POD_LOGS_KEEP_BYTES and says it was truncated', () => {
    const script = (podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } }).spec.template.spec.containers[0]!.args[0]!;
    const start = script.indexOf('if mkdir -p "$HOME/outbox/pod-logs"');
    const end = script.indexOf('\nfi', start) + 3;
    expect(start).toBeGreaterThan(-1);
    const block = script.slice(start, end);
    const home = mkdtempSync(join(tmpdir(), 'pod-logs-trunc-'));
    try {
      mkdirSync(join(home, 'bin'));
      // Fake exporter: ~5.5MB of numbered JSON lines (newest last).
      writeFileSync(join(home, 'bin', 'elanous'), '#!/bin/sh\ni=0; while [ $i -lt 55000 ]; do printf \'{"n":%d,"pad":"%0100d"}\\n\' $i 0; i=$((i+1)); done\n');
      chmodSync(join(home, 'bin', 'elanous'), 0o755);
      const out = execFileSync('bash', ['-c', block], { env: { ...process.env, HOME: home, PATH: `${join(home, 'bin')}:${process.env.PATH}` }, encoding: 'utf8' });
      const file = readFileSync(join(home, 'outbox', 'pod-logs', 'logs.jsonl'), 'utf8');
      expect(Buffer.byteLength(file)).toBeLessThanOrEqual(POD_LOGS_KEEP_BYTES);
      const lines = file.trimEnd().split('\n');
      expect(() => JSON.parse(lines[0]!)).not.toThrow();
      expect(JSON.parse(lines.at(-1)!).n).toBe(54999);
      expect(out).toMatch(/^ELANOUS_POD_LOGS_TRUNCATED \d+ \d+$/m);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('the host records pod-logs-truncated from the marker line', async () => {
    const { collectPodArtifacts } = await import('./pod-artifact-return.js');
    const events: Array<[string, Record<string, unknown>]> = [];
    const dir = mkdtempSync(join(tmpdir(), 'pod-art-'));
    try {
      collectPodArtifacts('ELANOUS_POD_LOGS_TRUNCATED 5500000 4499000\n', { dir, job: 'j1', log: (_c, e, d) => events.push([e, d]) });
      expect(events.find(([e]) => e === 'pod-logs-truncated')?.[1]).toMatchObject({ job: 'j1', originalBytes: 5500000, keptBytes: 4499000 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Pod run label — harness stop ⊕ 오케스트레이터 신호 정리가 고르는 라벨', () => {
  test('elanous.run = 오케스트레이터 런(parentRunId) · 자식은 elanous.child-run · Job 과 Pod 템플릿 둘 다', () => {
    expect(podRunLabels({ runId: 'run-child', parentRunId: 'run-parent' })).toEqual({ 'elanous.run': 'run-parent', 'elanous.child-run': 'run-child' });
    expect(podRunLabels({ runId: 'run-solo' })).toEqual({ 'elanous.run': 'run-solo', 'elanous.child-run': 'run-solo' });
    const job = podJobManifest({ name: 'si-x', namespace: 'elanous-test', image: 'img', repoUrl: 'https://example.invalid/r', args: [], passEnv: [], deadlineSeconds: 60, runId: 'run-abc', parentRunId: 'run-p' }) as {
      metadata: { labels: Record<string, string> }; spec: { template: { metadata: { labels: Record<string, string> } } };
    };
    expect(job.metadata.labels).toMatchObject({ 'elanous.job': 'si-x', 'elanous.run': 'run-p', 'elanous.child-run': 'run-abc' });
    expect(job.spec.template.metadata.labels).toMatchObject({ 'elanous.run': 'run-p', 'elanous.child-run': 'run-abc' });
    const solo = podJobManifest({ name: 'si-solo', namespace: 'elanous-test', image: 'img', repoUrl: 'https://example.invalid/r', args: [], passEnv: [], deadlineSeconds: 60, runId: 'run-solo' }) as typeof job;
    expect(solo.spec.template.metadata.labels).toMatchObject({ 'elanous.run': 'run-solo', 'elanous.child-run': 'run-solo' });
  });
  test('k8s 라벨 값 규칙 — 63자 · 영숫자 양끝 · 허용 문자 밖은 정리', () => {
    expect(k8sLabelValue('run-' + 'a'.repeat(80))!.length).toBeLessThanOrEqual(63);
    expect(k8sLabelValue('--run/x y--')).toBe('run-x-y');
    expect(k8sLabelValue('')).toBeUndefined();
  });
});

test('the Pod start script hands the host codex quota policy down, so a Pod child can rotate onto credits', () => {
  const saved = process.env.ELANOUS_CODEX_QUOTA_POLICY;
  process.env.ELANOUS_CODEX_QUOTA_POLICY = 'credits';
  try {
    for (const extra of [{}, { codexAccounts: ['team', 'third'] }]) {
      const script = (podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60, ...extra }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } }).spec.template.spec.containers[0]!.args[0]!;
      expect(script).toContain("export ELANOUS_CODEX_QUOTA_POLICY='credits'");
    }
  } finally {
    if (saved === undefined) delete process.env.ELANOUS_CODEX_QUOTA_POLICY; else process.env.ELANOUS_CODEX_QUOTA_POLICY = saved;
  }
});

describe('pod GitHub token watchdog (host refresher gone)', () => {
  const appScript = (extra: Record<string, unknown> = {}) => (podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60, appCredential: true, ...extra }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } }).spec.template.spec.containers[0]!.args[0]!;

  test('App-credential Pods start the watchdog before the child and stop it before the final salvage; others do not', () => {
    const script = appScript();
    const watch = podGithubWatchdogScript(POD_GH_STALE_SECONDS);
    expect(POD_GH_STALE_SECONDS).toBeGreaterThan(50 * 60);
    expect(POD_GH_STALE_SECONDS).toBeLessThan(60 * 60);
    expect(script).toContain(watch);
    expect(script.indexOf(watch)).toBeLessThan(script.indexOf('elanous self implement'));
    expect(script.indexOf('kill "$gh_watch_pid"')).toBeLessThan(script.indexOf(podSalvageScript()));
    expect(jobScript()).not.toContain('gh_watch_pid');
    expect(appScript({ githubStaleSeconds: 120 })).toContain('[ "$age" -ge 120 ]');
  });

  function repoWithDirtyWorktree() {
    const root = mkdtempSync(join(tmpdir(), 'pod-gh-watch-'));
    const bare = join(root, 'remote.git');
    const main = join(root, 'main');
    const wt = join(root, 'wt-child');
    const gh = join(root, 'gh');
    try {
      execFileSync('git', ['init', '--bare', '-q', bare]);
      execFileSync('git', ['clone', '-q', bare, main], { timeout: 10_000 });
      for (const [k, v] of [['user.email', 'pod@example.com'], ['user.name', 'pod']]) execFileSync('git', ['-C', main, 'config', k!, v!]);
      execFileSync('git', ['-C', main, 'config', 'core.hooksPath', '/dev/null']);
      writeFileSync(join(main, 'README'), 'base\n');
      execFileSync('git', ['-C', main, 'add', 'README']);
      execFileSync('git', ['-C', main, 'commit', '-qm', 'base']);
      execFileSync('git', ['-C', main, 'push', '-q', 'origin', 'HEAD:refs/heads/main']);
      execFileSync('git', ['-C', main, 'fetch', '-q', 'origin']);
      execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'child', wt, 'origin/main']);
      writeFileSync(join(wt, 'README'), 'edited\n');
      writeFileSync(join(wt, 'new.txt'), 'untracked\n');
      mkdirSync(gh);
      writeFileSync(join(gh, 'hosts.yml'), 'github.com: {}\n');
      const env = { ...process.env, ELANOUS_POD_NAME: 'job-w', GH_CONFIG_DIR: gh, GIT_AUTHOR_NAME: 'pod', GIT_AUTHOR_EMAIL: 'pod@example.com', GIT_COMMITTER_NAME: 'pod', GIT_COMMITTER_EMAIL: 'pod@example.com' };
      return { root, bare, main, wt, gh, env };
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  test('real bash: a stale hosts.yml pushes a snapshot of the dirty worktree and leaves the child untouched', () => {
    const r = repoWithDirtyWorktree();
    try {
      execFileSync('touch', ['-t', '202001010000', join(r.gh, 'hosts.yml')]);
      const headBefore = execFileSync('git', ['-C', r.wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const statusBefore = execFileSync('git', ['-C', r.wt, 'status', '--porcelain'], { encoding: 'utf8' });
      const run = Bun.spawnSync(['bash', '-c', `cd ${r.main}\n${podGithubWatchdogScript(60, 1)}\nwait "$gh_watch_pid"`], { env: r.env });
      const lines = run.stdout.toString().trim().split('\n');
      expect(lines[0]).toMatch(/^ELANOUS_POD_GH_STALE \d+$/);
      const pushed = lines.find((l) => l.startsWith('ELANOUS_POD_SALVAGE ') && l.includes('wt-child'));
      expect(pushed).toBeDefined();
      const [, branch, commit] = pushed!.split(' ');
      expect(branch).toBe('salvage/job-w/wt-child-early');
      expect(execFileSync('git', ['-C', r.bare, 'rev-parse', branch!], { encoding: 'utf8' }).trim()).toBe(commit);
      expect(execFileSync('git', ['-C', r.bare, 'show', `${commit}:README`], { encoding: 'utf8' })).toBe('edited\n');
      expect(execFileSync('git', ['-C', r.bare, 'show', `${commit}:new.txt`], { encoding: 'utf8' })).toBe('untracked\n');
      expect(execFileSync('git', ['-C', r.wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(headBefore);
      expect(execFileSync('git', ['-C', r.wt, 'status', '--porcelain'], { encoding: 'utf8' })).toBe(statusBefore);
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });

  test('real bash: a hosts.yml the host keeps rewriting never fires', () => {
    const r = repoWithDirtyWorktree();
    try {
      const run = Bun.spawnSync(['bash', '-c', `cd ${r.main}\n${podGithubWatchdogScript(60, 1)}\nsleep 3; kill "$gh_watch_pid"; wait "$gh_watch_pid" 2>/dev/null; echo DONE`], { env: r.env });
      expect(run.stdout.toString()).toBe('DONE\n');
      expect(execFileSync('git', ['-C', r.bare, 'branch', '--list', 'salvage/*'], { encoding: 'utf8' }).trim()).toBe('');
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });

  test('early snapshot of a clean worktree pushes nothing', () => {
    const r = repoWithDirtyWorktree();
    try {
      execFileSync('git', ['-C', r.wt, 'checkout', '-q', '--', 'README']);
      rmSync(join(r.wt, 'new.txt'));
      const run = Bun.spawnSync(['bash', '-c', `cd ${r.main}\n${podEarlySalvageScript()}`], { env: r.env });
      expect(run.stdout.toString()).not.toContain('ELANOUS_POD_SALVAGE ');
      expect(run.stdout.toString()).toContain('ELANOUS_POD_SALVAGE_NONE clean');
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });
});

describe('named child provider in Pod runs (10-05 PODPROVIDER)', () => {
  test('grok child gets the named model, and codex gets flags only when named', async () => {
    const { podChildLlmArgs } = await import('./self-implement-pod.js');
    expect(podChildLlmArgs({ provider: 'grok', childModel: 'grok-4.7', childEffort: 'high', childProviderExplicit: true }))
      .toEqual(['--child-llm-provider', 'grok', '--child-llm-model', 'grok-4.7']); // effort is not a `self implement` flag
    expect(podChildLlmArgs({ provider: 'grok' }).slice(0, 2)).toEqual(['--child-llm-provider', 'grok']);
    expect(podChildLlmArgs({ provider: 'openai-codex', childModel: 'gpt-6-sol', childProviderExplicit: true }))
      .toEqual(['--child-llm-provider', 'openai-codex', '--child-llm-model', 'gpt-6-sol']);
    expect(podChildLlmArgs({ provider: 'openai-codex' })).toEqual([]);
  });
  test('a named grok child without a usable credential is refused, never a silent codex', async () => {
    const { podNamedChildProvider } = await import('./self-implement-pod.js');
    expect(podNamedChildProvider('grok', { grokSubscription: true, grokApiKey: false })).toEqual({ provider: 'grok' });
    expect(podNamedChildProvider('grok', { grokSubscription: false, grokApiKey: true })).toEqual({ provider: 'grok' });
    expect(podNamedChildProvider('grok', { grokSubscription: false, grokApiKey: false }).refuse).toContain('grok 자격 없음');
    expect(podNamedChildProvider('openai-codex', { grokSubscription: false, grokApiKey: false })).toEqual({ provider: 'openai-codex' });
    // POD-ANTHROPIC-PROVIDER — anthropic 은 이제 목록 안(키 없으면 거부) · 목록 밖은 gemini 로 본다.
    expect(podNamedChildProvider('anthropic', { grokSubscription: true, grokApiKey: true }).refuse).toContain('anthropic 키 없음');
    expect(podNamedChildProvider('opengateway', { grokSubscription: false, grokApiKey: false, openGatewayKey: true }, 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast')).toEqual({ provider: 'opengateway' });
    expect(podNamedChildProvider('opengateway', { grokSubscription: false, grokApiKey: false, openGatewayKey: true }, 'opengateway/unknown/model').refuse).toContain('model not verified');
    expect(podNamedChildProvider('opengateway', { grokSubscription: false, grokApiKey: false }).refuse).toContain('OPENGATEWAY_API_KEY');
    expect(podNamedChildProvider('gemini', { grokSubscription: true, grokApiKey: true }).refuse).toContain('openai-codex|grok|openrouter|opengateway|anthropic');
    expect(podNamedChildProvider(undefined, { grokSubscription: true, grokApiKey: true })).toEqual({});
  });
});

test('a named codex child plans with grok fallback off, so no codex account means refusal (10-05 PODPROVIDER)', async () => {
  const { podFallbackCredentials } = await import('./self-implement-pod.js');
  const { planPodProvider } = await import('./pod-account-broker.js');
  expect(podFallbackCredentials('openai-codex', { grokSubscription: true, grokApiKey: true })).toEqual({ grokSubscription: false, grokApiKey: false });
  expect(podFallbackCredentials(undefined, { grokSubscription: true, grokApiKey: false })).toEqual({ grokSubscription: true, grokApiKey: false });
  const named = planPodProvider({ codexCandidates: [], grokApiKeyOptIn: false, ...podFallbackCredentials('openai-codex', { grokSubscription: true, grokApiKey: false }) });
  expect(named.provider).toBeNull();
  const unnamed = planPodProvider({ codexCandidates: [], grokApiKeyOptIn: false, ...podFallbackCredentials(undefined, { grokSubscription: true, grokApiKey: false }) });
  expect(unnamed.provider).toBe('grok');
});

describe('AUTHOR-POD2 — host authoring knob relay', () => {
  test('an explicit luna child supplies the Pod authoring model when planning has no model', async () => {
    const { getUserConfig } = await import('../../user-config.js');
    const config = getUserConfig();
    const { k, calls } = fakeKubectl(['Complete'], '');
    const result = await podSelfImplementSpawn({
      kubectl: k, credentials: CREDS,
      provider: 'openai-codex', childProviderExplicit: true, childModel: 'gpt-6-luna',
      env: { ELANOUS_POD_AUTHOR_ON_POD: '1' },
      authorConfig: () => ({ ...config, roleLlm: { planning: {} }, llm: { ...config.llm, provider: 'local' } }),
      pollMs: 1,
    })({ feature: 'write a goal', spaceId: 'author-luna-child' }).done;
    expect(result.exitCode).toBe(0);
    const job = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!)).find((item) => item.kind === 'Job');
    const entries = job.spec.template.spec.containers[0].env;
    expect(entries).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_MODEL', value: 'gpt-6-luna' });
    expect(entries).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_MODEL_RELAY', value: 'pod' });
    expect(entries).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_MODEL_SOURCE', value: 'child' });
    expect(job.spec.template.spec.containers[0].args[0]).toContain("'--child-llm-model' 'gpt-6-luna'");

    const explicit = fakeKubectl(['Complete'], '');
    await podSelfImplementSpawn({
      kubectl: explicit.k, credentials: CREDS,
      provider: 'openai-codex', childProviderExplicit: true, childModel: 'gpt-6-luna',
      env: { ELANOUS_POD_AUTHOR_ON_POD: '1' },
      authorConfig: () => ({ ...config, roleLlm: { planning: { model: 'gpt-6-sol' } }, llm: { ...config.llm, provider: 'local' } }),
      pollMs: 1,
    })({ feature: 'write a goal', spaceId: 'author-explicit-planning' }).done;
    const explicitJob = explicit.calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!)).find((item) => item.kind === 'Job');
    expect(explicitJob.spec.template.spec.containers[0].env).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_MODEL', value: 'gpt-6-sol' });
    expect(explicitJob.spec.template.spec.containers[0].env).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_MODEL_SOURCE', value: 'config-role' });
  });

  test('selected authoring knobs reach only the Pod Job, including the default Codex model', async () => {
    const { getUserConfig } = await import('../../user-config.js');
    const config = getUserConfig();
    const defaultRelay = { ELANOUS_PROMPT_ENHANCE_MODEL: 'gpt-6-sol', ELANOUS_PROMPT_ENHANCE_MODEL_RELAY: 'pod', ELANOUS_PROMPT_ENHANCE_MODEL_SOURCE: 'default' };
    const cases = [
      { planning: { model: 'gpt-6-sol', effort: 'medium' as const }, expected: { ELANOUS_PROMPT_ENHANCE_MODEL: 'gpt-6-sol', ELANOUS_PROMPT_ENHANCE_MODEL_RELAY: 'pod', ELANOUS_PROMPT_ENHANCE_MODEL_SOURCE: 'config-role', ELANOUS_PROMPT_ENHANCE_EFFORT: 'medium' } },
      { planning: { effort: 'low' as const }, env: { ELANOUS_PR_REVIEW_MODEL: 'gpt-6-sol' }, expected: { ...defaultRelay, ELANOUS_PROMPT_ENHANCE_EFFORT: 'low' } },
      // Select a Codex default explicitly: host tier defaults differ, while the Pod still needs this model and provenance.
      { planning: {}, env: { ELANOUS_PR_REVIEW_MODEL: 'gpt-6-sol' }, expected: defaultRelay },
      { planning: { model: 'ignored-model', effort: 'low' as const }, env: { ELANOUS_PROMPT_ENHANCE_MODEL: 'env-model', ELANOUS_PROMPT_ENHANCE_MODEL_RELAY: 'pod', ELANOUS_PROMPT_ENHANCE_MODEL_SOURCE: 'config-role', ELANOUS_PROMPT_ENHANCE_EFFORT: 'high' }, expected: { ELANOUS_PROMPT_ENHANCE_MODEL: 'env-model', ELANOUS_PROMPT_ENHANCE_MODEL_RELAY: 'pod', ELANOUS_PROMPT_ENHANCE_MODEL_SOURCE: 'env', ELANOUS_PROMPT_ENHANCE_EFFORT: 'high' } },
    ];
    for (const { planning, expected, env } of cases) {
      const { k, calls } = fakeKubectl(['Complete'], '');
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_AUTHOR_ON_POD: '1', ...env }, authorConfig: () => ({ ...config, roleLlm: { planning }, llm: { ...config.llm, provider: 'local' } }), pollMs: 1 })({ feature: 'write a goal', spaceId: `author-knob-${Object.keys(expected).length}` }).done;
      expect(result.exitCode).toBe(0);
      const [secret, job] = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!));
      const entries = job.spec.template.spec.containers[0].env.filter((entry: { name: string }) => entry.name.startsWith('ELANOUS_PROMPT_ENHANCE_'));
      expect(Object.fromEntries(entries.map((entry: { name: string; value: string }) => [entry.name, entry.value]))).toEqual(expected);
      expect(Object.keys(secret.stringData).filter((key) => key.includes('PROMPT_ENHANCE'))).toEqual([]);
    }
    // A caller's armEnv never smuggles the knobs: not into a non-author Job, nor past the host's default selection.
    const armEnv = { ELANOUS_PROMPT_ENHANCE_MODEL: 'arm-model', ELANOUS_PROMPT_ENHANCE_MODEL_RELAY: 'pod', ELANOUS_PROMPT_ENHANCE_MODEL_SOURCE: 'config-role', ELANOUS_PROMPT_ENHANCE_MODEL_FALLBACK_REASON: 'injected', ELANOUS_PROMPT_ENHANCE_REQUESTED_MODEL: 'injected', ELANOUS_PROMPT_ENHANCE_EFFORT: 'low' };
    for (const { env, authorConfig, spaceId, expected } of [
      { env: {}, authorConfig: () => { throw new Error('not an author Job'); }, spaceId: 'not-author-knob', expected: {} },
      { env: { ELANOUS_POD_AUTHOR_ON_POD: '1', ELANOUS_PR_REVIEW_MODEL: 'gpt-6-sol' }, authorConfig: () => ({ ...config, roleLlm: { planning: {} }, llm: { ...config.llm, provider: 'local' as const } }), spaceId: 'author-default-knob', expected: defaultRelay },
    ]) {
      const { k, calls } = fakeKubectl(['Complete'], '');
      await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env, armEnv, authorConfig, pollMs: 1 })({ feature: spaceId === 'not-author-knob' ? 'fix code' : 'write a goal', spaceId }).done;
      const job = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!)).find((item) => item.kind === 'Job');
      const entries = job.spec.template.spec.containers[0].env.filter((entry: { name: string }) => entry.name.startsWith('ELANOUS_PROMPT_ENHANCE_'));
      expect(Object.fromEntries(entries.map((entry: { name: string; value: string }) => [entry.name, entry.value]))).toEqual(expected);
    }
  });
});

describe('AUTHOR-POD2 — authoring runs inside the Pod', () => {
  const scriptOf = (extra: Record<string, unknown>) => (podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: ['--open-pr', '--base', 'main'], passEnv: [], deadlineSeconds: 60, ...extra }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } }).spec.template.spec.containers[0]!.args[0]!;

  test('authorSentence runs harness say on the verbatim sentence, never harness ask or self implement', () => {
    const script = scriptOf({ authorSentence: true });
    expect(script).toContain(`elanous harness say --substrate local --json '--base' 'main' --no-auto-merge -- "$(cat /creds/feature)"`);
    expect(script).not.toContain('ELANOUS_POD_AUTHOR_ON_POD=1 elanous');
    expect(script).toContain('ELANOUS_AUTHOR_ON_POD started host=$(hostname)');
    expect(script).toContain('ELANOUS_AUTHOR_ON_POD finished host=$(hostname) rc=$rc');
    expect(script).not.toContain('elanous harness ask');
    expect(script).not.toContain('elanous self implement');
  });

  test('a sentence that starts with a dash or holds quotes, $ and backticks reaches harness say as one argument', () => {
    const script = scriptOf({ authorSentence: true });
    const line = script.split('\n').find((l) => l.includes('harness say --substrate local'))!;
    const call = line.slice(line.indexOf('elanous harness say'), line.indexOf(' > /tmp/si.out'));
    const root = mkdtempSync(join(tmpdir(), 'author-say-'));
    try {
      const sentence = `-x "quoted" $HOME \`tick\` it's`;
      writeFileSync(join(root, 'feature'), sentence);
      writeFileSync(join(root, 'elanous'), '#!/bin/sh\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\n');
      chmodSync(join(root, 'elanous'), 0o755);
      const out = execFileSync('sh', ['-c', `PATH="${root}:$PATH"; ${call.replace('/creds/feature', join(root, 'feature'))}`], { encoding: 'utf8' });
      expect(out.trim().split('\n').at(-1)).toBe(`[${sentence}]`);
      expect(out).toContain('[--]');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('without the marker the Pod keeps the self implement path', () => {
    const script = scriptOf({});
    expect(script).toContain('elanous self implement "$(cat /creds/feature)"');
    expect(script).not.toContain('harness say --substrate local');
  });
});

// GROK-CHILD-GIT-GUARD — the Pod's global pre-push hook lets a run push only its own branches (real sh, real hook file).
describe('pod git push guard', () => {
  const zero = '0'.repeat(40);
  const sha = 'a'.repeat(40);
  const runHook = (lines: string, runId?: string) => {
    const home = mkdtempSync(join(tmpdir(), 'pod-git-guard-'));
    try {
      const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig') };
      const install = spawnSync('sh', ['-c', podGitPushGuardScript(runId)], { env, encoding: 'utf8' });
      expect(install.status).toBe(0);
      const hooksPath = spawnSync('git', ['config', '--global', 'core.hooksPath'], { env, encoding: 'utf8' }).stdout.trim();
      expect(hooksPath).toBe(join(home, '.elanous-git-hooks'));
      return spawnSync(join(hooksPath, 'pre-push'), ['origin', 'https://example.invalid/repo.git'], { env, input: lines, encoding: 'utf8' });
    } finally { rmSync(home, { recursive: true, force: true }); }
  };
  test('a run pushes its own self-impl, salvage and bench arm branches', () => {
    for (const ref of ['refs/heads/self-impl/goalid-x-r1', 'refs/heads/salvage/si-task-1/wt', 'refs/heads/bench/chk-1011/glm-5.3-flash-fc1fdf']) {
      expect(runHook(`HEAD ${sha} ${ref} ${zero}\n`).status).toBe(0);
    }
  });
  test('a run uploads and cleans up its own PR scratch ref but cannot push another run branch', () => {
    const runId = 'run-a1b2c3d4-1111-2222-3333-444444444444';
    const scratch = 'refs/heads/self-impl/pr-create-ra1b2c3-12345678-1234-1234-1234-123456789abc';
    expect(runHook(`HEAD ${sha} ${scratch} ${zero}\n`, runId).status).toBe(0);
    expect(runHook(`(delete) ${zero} ${scratch} ${sha}\n`, runId).status).toBe(0);
    const update = runHook(`HEAD ${sha} ${scratch} ${'b'.repeat(40)}\n`, runId);
    expect(update.status).toBe(1);
    expect(update.stderr).toContain('refused scratch ref update');
    expect(runHook(`HEAD ${sha} refs/heads/self-impl/goalid-a-work-ra1b2c3 ${zero}\n`, runId).status).toBe(0);
    const other = runHook(`HEAD ${sha} refs/heads/self-impl/goalid-b-work-rfba80c ${zero}\n`, runId);
    expect(other.status).toBe(1);
    expect(other.stderr).toContain('another run');
    expect(runHook(`(delete) ${zero} refs/heads/self-impl/pr-create-rfba80c-1234 ${sha}\n`, runId).status).toBe(1);
  });
  test('a second Pod run may advance only its bound card PR ref in a real bare origin', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-same-cell-guard-'));
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    const home = join(root, 'home');
    mkdirSync(work);
    mkdirSync(home);
    const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), ELANOUS_TASK_CARD_ID: 'ta-123' };
    const git = (args: readonly string[], cwd = work, commandEnv = env) => spawnSync('git', [...args], { cwd, env: commandEnv, encoding: 'utf8', timeout: 10_000 });
    const checked = (args: readonly string[], cwd = work) => {
      const result = git(args, cwd);
      expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toMatchObject({ status: 0, error: undefined });
      return result.stdout.trim();
    };
    const ref = 'refs/heads/self-impl/same-cell-ra1b2c3';
    const otherRef = 'refs/heads/self-impl/other-card-ra1b2c3';
    try {
      checked(['init', '--bare', '-q', origin], root);
      checked(['init', '-q']);
      checked(['config', 'user.email', 'pod@example.invalid']);
      checked(['config', 'user.name', 'Pod Test']);
      checked(['remote', 'add', 'origin', origin]);
      writeFileSync(join(work, 'change.txt'), 'first\n');
      checked(['add', 'change.txt']);
      checked(['commit', '-qm', 'first']);
      const first = checked(['rev-parse', 'HEAD']);
      checked(['push', 'origin', `HEAD:${ref}`]);
      checked(['switch', '-qc', 'self-impl/second-rfba80c']);
      checked(['branch', '-f', 'main', first]);
      const install = spawnSync('sh', ['-c', podGitPushGuardScript('run-fba80c00-1111-2222-3333-444444444444')], { cwd: work, env, encoding: 'utf8' });
      expect(install.status).toBe(0);
      writeFileSync(join(work, 'change.txt'), 'second\n');
      checked(['commit', '-qam', 'second']);
      const withoutBinding = git(['push', `--force-with-lease=${ref}:${first}`, 'origin', `HEAD:${ref}`]);
      expect(withoutBinding.status).toBe(1);
      expect(withoutBinding.stderr).toContain('(another run)');
      const prBranch = ref.replace('refs/heads/', '');
      const body = '칸: SAMECELL-REUSE-POD-PUSH\n카드: ta-123';
      const url = 'https://github.com/example/repo/pull/7';
      const run: CmdRunner = (command, args) => {
        if (command === 'git') {
          const result = git(args);
          return { ok: result.status === 0, out: result.stdout, err: result.stderr, rc: result.status ?? 1 };
        }
        if (command === 'gh' && args[0] === 'pr' && args[1] === 'view')
          return { ok: true, out: JSON.stringify({ state: 'OPEN', headRefOid: first, headRefName: prBranch, body, isCrossRepository: false, isDraft: true, url }) };
        return { ok: true, out: '' };
      };
      const inventory = { status: 'checked' as const, prs: [{ number: 7, headRefName: prBranch, title: 'first', draft: true,
        updatedAt: '2026-10-21T00:00:00Z', headSha: first, labels: [], files: ['change.txt'], seat: null,
        cellId: 'SAMECELL-REUSE-POD-PUSH', cardId: 'ta-123' }] };
      const guard = () => guardNewPr({ files: ['change.txt'], cellId: 'SAMECELL-REUSE-POD-PUSH', cardId: 'ta-123' }, inventory);
      const priorCard = process.env.ELANOUS_TASK_CARD_ID;
      const decisionLog = spyOn(debug, 'log').mockImplementation(() => {});
      try {
        process.env.ELANOUS_TASK_CARD_ID = 'ta-123';
        const outcome = makePrManager(run, guard).upsertPr({ branch: 'self-impl/second-rfba80c', worktreePath: work,
          title: 'second', body, base: 'main', commitMessage: 'second run', runId: 'run-fba80c00-1111-2222-3333-444444444444' });
        expect(outcome).toEqual({ ok: true, url, reused: true, boundCardHeadRefName: prBranch });
        expect(decisionLog).toHaveBeenCalledWith('autopilot.pr-manager', 'same-cell-push-decision',
          { ref, remoteHead: first, cardId: 'ta-123', outcome: 'allowed', reason: 'bound-card-pr-head-fast-forward' });
      } finally {
        decisionLog.mockRestore();
        if (priorCard === undefined) delete process.env.ELANOUS_TASK_CARD_ID;
        else process.env.ELANOUS_TASK_CARD_ID = priorCard;
      }
      const second = checked(['rev-parse', 'HEAD']);
      expect(checked(['ls-remote', 'origin', ref])).toBe(`${second}\t${ref}`);
      writeFileSync(join(work, 'change.txt'), 'third\n');
      checked(['commit', '-qam', 'third']);
      const afterOnePush = git(['push', `--force-with-lease=${ref}:${second}`, 'origin', `HEAD:${ref}`]);
      expect(afterOnePush.status).toBe(1);
      expect(afterOnePush.stderr).toContain('(another run)');
      const wrongCard = git(['-c', `elanous.sameCellReuseRef=${ref}`, '-c', `elanous.sameCellReuseHead=${second}`, '-c', 'elanous.sameCellReuseCard=ta-other',
        'push', `--force-with-lease=${ref}:${second}`, 'origin', `HEAD:${ref}`]);
      expect(wrongCard.status).toBe(1);
      expect(wrongCard.stderr).toContain('card-mismatch');
      const wrongRef = git(['-c', `elanous.sameCellReuseRef=${ref}`, '-c', `elanous.sameCellReuseHead=${second}`, '-c', 'elanous.sameCellReuseCard=ta-123',
        'push', 'origin', `HEAD:${otherRef}`]);
      expect(wrongRef.status).toBe(1);
      checked(['reset', '--hard', first]);
      writeFileSync(join(work, 'change.txt'), 'diverged\n');
      checked(['commit', '-qam', 'diverged']);
      const nonFf = git(['-c', `elanous.sameCellReuseRef=${ref}`, '-c', `elanous.sameCellReuseHead=${second}`, '-c', 'elanous.sameCellReuseCard=ta-123',
        'push', `--force-with-lease=${ref}:${second}`, 'origin', `HEAD:${ref}`]);
      expect(nonFf.status).toBe(1);
      expect(nonFf.stderr).toContain('non-fast-forward');
      expect(checked(['ls-remote', 'origin', ref])).toBe(`${second}\t${ref}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('push to main, another branch, a tag or the shared bench base is refused', () => {
    for (const ref of ['refs/heads/main', 'refs/heads/feature/x', 'refs/tags/v1', 'refs/heads/bench/chk-1011/base']) {
      const r = runHook(`HEAD ${sha} ${ref} ${sha}\n`);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[pod] git-guard: refused');
    }
  });
  test('deleting a remote branch is refused even under the run prefix', () => {
    const r = runHook(`(delete) ${zero} refs/heads/self-impl/goalid-x-r1 ${sha}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refused remote delete');
  });
  test('one bad ref in a multi-ref push refuses the whole push', () => {
    expect(runHook(`HEAD ${sha} refs/heads/self-impl/ok ${zero}\nHEAD ${sha} refs/heads/main ${sha}\n`).status).toBe(1);
  });
  test('the Job script installs the guard right after git credentials are set up', () => {
    const job = podJobManifest({ name: 'si-task-guard', namespace: 'elanous-test', image: 'img', repoUrl: 'https://example.invalid/r.git', args: [], passEnv: [], deadlineSeconds: 60,
      runId: 'run-a1b2c3d4-1111-2222-3333-444444444444' });
    const script = JSON.stringify(job);
    const setup = script.indexOf('gh auth setup-git');
    const guard = script.indexOf('core.hooksPath');
    expect(setup).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(setup);
    expect(script).toContain('self-impl/pr-create-ra1b2c3-');
  });
});

describe('BUDGET-SNAPSHOT-TO-POD — the host budget snapshot rides the Job env', () => {
  const snapshotEnv = (job: { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }> }> } } } }) =>
    job.spec.template.spec.containers[0]!.env.filter((entry) => entry.name === 'ELANOUS_BUDGET_SNAPSHOT');

  test('the default host measurement reaches Job and Pod even with an injected kubectl adapter', async () => {
    const { k, calls } = fakeKubectl(['Complete'], '');
    const result = await realPodSelfImplementSpawn({
      kubectl: k, credentials: CREDS, env: {}, pollMs: 1,
      budgetInputDeps: {
        config: { tools: { selfImplement: { childLlm: { mode: 'auto', chain: [{ provider: 'openai-codex' }, { provider: 'grok' }] } } }, llm: {} } as never,
        inspectCodex: (() => ({ candidates: [{ name: 'team', usedPercent: 95 }] })) as never,
        grokSnapshot: () => undefined,
        readLiveGrok: async () => 7,
      },
    })({ feature: 'fix it', spaceId: 'budget-host-default' }).done;
    expect(result.exitCode).toBe(0);
    const job = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!)).find((item) => item.kind === 'Job');
    const carried = snapshotEnv(job);
    expect(carried).toHaveLength(1);
    const snapshot = JSON.parse(carried[0]!.value!);
    expect(snapshot.provider).toBe('grok');
    expect(snapshot.decision.action).toBe('next-provider');
    expect(JSON.stringify(job.spec.template)).toContain('ELANOUS_BUDGET_SNAPSHOT');
  });

  test('a measured snapshot for the Job provider reaches the Pod env as numbers and names only, never the Secret', async () => {
    const asked: unknown[] = [];
    const { k, calls } = fakeKubectl(['Complete'], '');
    const result = await podSelfImplementSpawn({
      kubectl: k, credentials: CREDS, env: {}, pollMs: 1,
      budgetSnapshot: (childLlm) => { asked.push(childLlm); return { provider: 'openai-codex', remaining: 42, window: 'weekly', measuredAt: 1_000, host: 'host-a', decision: { action: 'next-provider', provider: 'grok' } }; },
    })({ feature: 'fix it', spaceId: 'budget-snapshot-carried' }).done;
    expect(result.exitCode).toBe(0);
    expect(asked).toEqual([{}]);
    const [secret, job] = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!));
    const carried = snapshotEnv(job);
    expect(carried).toHaveLength(1);
    expect(JSON.parse(carried[0]!.value!)).toEqual({ provider: 'openai-codex', remaining: 42, window: 'weekly', measuredAt: 1_000, host: 'host-a', decision: { action: 'next-provider', provider: 'grok' } });
    expect(Object.keys(secret.stringData).filter((key) => key.includes('BUDGET'))).toEqual([]);
  });

  test('the host verdict answers the same child-LLM question the Pod harness gate will ask', async () => {
    const asked: unknown[] = [];
    const { k } = fakeKubectl(['Complete'], '');
    const result = await podSelfImplementSpawn({
      kubectl: k, credentials: CREDS, env: {}, pollMs: 1, provider: 'openai-codex', childProviderExplicit: true,
      budgetSnapshot: (childLlm) => { asked.push(childLlm); return undefined; },
    })({ feature: 'fix it', spaceId: 'budget-snapshot-explicit' }).done;
    expect(result.exitCode).toBe(0);
    expect(asked).toEqual([{ provider: 'openai-codex' }]);
  });

  test('a failed or empty host measurement carries no snapshot and still launches', async () => {
    for (const budgetSnapshot of [() => undefined, () => { throw new Error('usage unreadable'); }, async () => { throw new Error('usage unreadable'); }]) {
      const { k, calls } = fakeKubectl(['Complete'], '');
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {}, pollMs: 1, budgetSnapshot })({ feature: 'fix it', spaceId: 'budget-snapshot-absent' }).done;
      expect(result.exitCode).toBe(0);
      const job = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!)).find((item) => item.kind === 'Job');
      expect(snapshotEnv(job)).toEqual([]);
    }
  });

  test('a stuck host measurement gives the Job its admission back after 10 seconds', async () => {
    const { k, calls } = fakeKubectl(['Complete'], '');
    const result = await podSelfImplementSpawn({
      kubectl: k, credentials: CREDS, env: {}, pollMs: 1,
      budgetSnapshot: () => new Promise(() => {}),
    })({ feature: 'fix it', spaceId: 'budget-snapshot-stuck' }).done;
    expect(result.exitCode).toBe(0);
    const job = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!)).find((item) => item.kind === 'Job');
    expect(snapshotEnv(job)).toEqual([]);
  }, 20_000);
});

// ── POD-FAIL-EVIDENCE-CAPTURE-FU (#29346 잔여) ─────────────────────────────────────────────
// provider-error 우선순위 · duplicate-cap 귀속(canonical prefix·동일 terminal 직전만) · lookalike/연속 실패 부정.
// 모든 시험은 실 생산 진입점 podSelfImplementSpawn → parseSelfImplementJson/classifyPodTerminal/extractPodFailureReason
// → appendRunLedgerEntry(pod-child-evidence) ⊕ podUsageReemitPlan(classifyPodExit) 를 지난다.
describe('POD-FAIL-EVIDENCE-CAPTURE-FU: provider-error 우선순위 ⊕ duplicate-cap 귀속', () => {
  type PodRecord = { event: string; data: Record<string, unknown> };

  const failedJob = async (logs: string, spaceId: string): Promise<{ message: string; events: PodRecord[] }> => {
    const { k } = fakeKubectl(['Failed'], logs);
    const events: PodRecord[] = [];
    const off = debug.registerSink({ name: `pod-fu-${spaceId}`, emit: (record) => {
      if (record.category.startsWith('self-implement.pod')) events.push({ event: record.event, data: record.data as Record<string, unknown> });
    } });
    try {
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: {}, pollMs: 1 })({ feature: 'x', spaceId }).done;
      return { message: result.error?.message ?? '', events };
    } finally { off(); }
  };

  const exitClassOf = (events: PodRecord[]): unknown => events.find((record) => 'podExitClass' in record.data)?.data.podExitClass;

  test('provider error classified before generic failure', async () => {
    const provider = await failedJob('llm.codex response error: provider overloaded (429)\n', 'fu-provider-priority');
    expect(exitClassOf(provider.events)).toBe('provider-error');
    // 대조군 — provider 신호가 없는 실패는 지금처럼 generic(child-error)로 남는다.
    const generic = await failedJob('Error: dev child exited with code 1\n', 'fu-provider-priority-generic');
    expect(exitClassOf(generic.events)).toBe('child-error');
    expect(generic.message).toContain('childError=no-result-line · reason=Error: dev child exited with code 1');
    // provider error 는 결과행 없음(no-result-line)보다도 먼저다.
    const credential = await failedJob('llm.claude credential error: upstream 503\n', 'fu-provider-priority-credential');
    expect(exitClassOf(credential.events)).toBe('provider-error');
  });

  test('provider error of an earlier terminal is not reused by the last terminal', async () => {
    const logs = [
      'llm.codex response error: provider overloaded (429)',
      JSON.stringify({ kind: 'self', stage: 'aborted', ok: false, error: 'Error: previous attempt failed' }),
      JSON.stringify({ kind: 'self', stage: 'merged', ok: true }),
    ].join('\n');
    const { events } = await failedJob(logs, 'fu-provider-stale');
    expect(exitClassOf(events)).toBe('unknown');
  });

  test('duplicate-cap attribution keeps only the canonical child terminal (lookalike 행 배제)', async () => {
    const lookalike = JSON.stringify({ kind: 'pod-capture', stage: 'shrink', ok: false, error: 'lookalike boom' });
    const secret = 'OPENROUTER_API_KEY=sk-abcdefghijklmnop';
    const canonical = JSON.stringify({ kind: 'self', stage: 'dev', ok: false, error: `nested child failed ${secret}` });
    const kept = await failedJob(`${canonical}\n${lookalike}\n`, 'fu-attribution-canonical');
    expect(kept.message).toContain('childStage=dev · childError=nested child failed');
    expect(kept.message).not.toContain(secret);
    expect(JSON.stringify(kept.events)).not.toContain(secret);
    expect(kept.message).not.toContain('lookalike boom');
    // lookalike 만 있으면 실패를 귀속하지 않는다 — 생산 경로는 no-result-line 으로 닫힌다.
    const onlyLookalike = await failedJob(`${lookalike}\n`, 'fu-attribution-lookalike');
    expect(onlyLookalike.message).toContain('childError=no-result-line');
    expect(onlyLookalike.message).not.toContain('lookalike boom');
  });

  test('a canonical success terminal does not reuse an earlier failure (연속 실패 부정)', async () => {
    const logs = [
      JSON.stringify({ kind: 'self', stage: 'dev', ok: false, error: 'previous attempt failed' }),
      JSON.stringify({ kind: 'self', stage: 'merged', ok: true }),
    ].join('\n');
    const { message } = await failedJob(`${logs}\n`, 'fu-attribution-success');
    expect(message).not.toContain('previous attempt failed');
  });

  test('a bookkeeping-only error line is not attributed as childEvidence', async () => {
    const logs = JSON.stringify({ kind: 'self', stage: 'dev', ok: false, error: 'ELANOUS_USAGE_ROLLUP {}' });
    const { message } = await failedJob(`${logs}\n`, 'fu-attribution-bookkeeping');
    expect(message).not.toBe('');
    expect(message).not.toContain('childError=ELANOUS_USAGE_ROLLUP');
  });
});
