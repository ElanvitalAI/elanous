import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { publishInsideEvent } from './inside-events.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { resetUserConfig } from '../../user-config.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest } from './http-server.js';
import { defaultTrainArtifactDirectory, readReleaseRuns, resolveTrainArtifactDirectory, setOverviewCacheForTest } from './ops-api.js';
import { setResourceLedgerSnapshotForTest } from './resource-ledger.js';
import * as guardianReconcile from '../../resource-ledger/guardian-reconcile.js';
import { setLatestResourceSnapshotForTest, type ResourceReconcileSnapshot } from '../../resource-ledger/guardian-reconcile.js';
import * as resourceCli from '../../cli/resource-ledger-cli.js';
import * as resourceLedger from '../../resource-ledger/resource-ledger.js';
import { buildResourceLedgerSnapshot } from '../../cli/resource-ledger-cli.js';
import { createOverviewCache } from '../../ops/overview-cache.js';
import { okCell, unmeasured, type OverviewSnapshot } from '../../ops/overview.js';
import { gateShardsPath, writeGateShards } from '../../release-loop/gate-shards.js';
import { issueMemberToken } from '../../control-plane/member-tokens.js';

const SECRET = 'op-proxy-secret-0123456789abcdef';
const API_KEY = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
const OWNER = 'owner-token';
const dirs: string[] = [];
const originalTrainArtifactDir = process.env.ELANOUS_TRAIN_ARTIFACT_DIR;
const originalTrainSummaryDir = process.env.ELANOUS_TRAIN_SUMMARY_DIR;
const originalHome = process.env.HOME;

// The legacy XDG config is pointed at a per-test temp dir and restored — never the person's own.
const originalXdgConfig = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  setOverviewCacheForTest(null);
  setResourceLedgerSnapshotForTest(null);
  setLatestResourceSnapshotForTest(null);
  if (originalXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfig;
  resetUserConfig();
  resetElanousConfigDir();
  if (originalTrainArtifactDir === undefined) delete process.env.ELANOUS_TRAIN_ARTIFACT_DIR; else process.env.ELANOUS_TRAIN_ARTIFACT_DIR = originalTrainArtifactDir;
  if (originalTrainSummaryDir === undefined) delete process.env.ELANOUS_TRAIN_SUMMARY_DIR; else process.env.ELANOUS_TRAIN_SUMMARY_DIR = originalTrainSummaryDir;
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(enabled: boolean | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-api-'));
  dirs.push(dir);
  const xdgConfig = join(dir, 'xdg');
  process.env.XDG_CONFIG_HOME = xdgConfig;
  const legacyDir = join(xdgConfig, 'elanous');
  mkdirSync(legacyDir, { recursive: true });
  if (enabled !== undefined) writeFileSync(join(legacyDir, 'config.json'), JSON.stringify({ operator: { enabled, proxySecretFile: join(dir, 'secret') } }));
  setElanousConfigDir(dir);
  resetUserConfig();
  if (enabled !== undefined) writeFileSync(join(dir, 'config.json'), JSON.stringify({ operator: { enabled, proxySecretFile: join(dir, 'secret') } }));
  writeFileSync(join(dir, 'secret'), SECRET, { mode: 0o600 });
  chmodSync(join(dir, 'secret'), 0o600);
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const opts = { state, registry: new TabRegistry(state), eventBus: new NexusEventBus(), metaApi: { bearerToken: OWNER, noAuth: false } };
  const send = (path: string, headers: Record<string, string> = {}, method = 'GET', signal?: AbortSignal) => {
    const request = new Request(`http://ops.test${path}`, { method, signal, headers: { 'sec-fetch-site': 'cross-site', ...headers } });
    return routeRequest(request, opts, {} as never, null, createDevProxyRuntimeRef());
  };
  const sendSecure = (path: string, headers: Record<string, string>, method: string, body?: string) => {
    const request = new Request(`https://ops.test${path}`, { method, ...(body === undefined ? {} : { body }), headers });
    return routeRequest(request, opts, {} as never, null, createDevProxyRuntimeRef());
  };
  const run = (id: string, startedAt: string, version = '0.2.9', output: unknown = JSON.stringify({ summary: 'ok' })) => {
    const folder = join(dir, 'graph-runs', 'release-loop');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${id}.json`), JSON.stringify({
      graphId: 'release-loop', runId: id, status: 'running', path: ['version-release'], startedAt,
      input: { version }, nodes: [{ nodeId: 'version-release', ok: true, exit: 0, output }],
    }));
  };
  return { dir, send, sendSecure, run };
}

test('train throughput source defaults to the canonical OP artifact directory and allows an explicit override', () => {
  expect(defaultTrainArtifactDirectory('/home/operator')).toBe('/home/operator/elanous-hq/seat-state/OP/train-artifacts');
  expect(resolveTrainArtifactDirectory({}, '/home/operator')).toBe('/home/operator/elanous-hq/seat-state/OP/train-artifacts');
  expect(resolveTrainArtifactDirectory({ ELANOUS_TRAIN_ARTIFACT_DIR: '/data/train-artifacts' }, '/ignored'))
    .toBe('/data/train-artifacts');
});

test('train throughput API discovers the train loop output under the operator home without extra setup', async () => {
  const { dir, send } = fixture(true);
  const home = join(dir, 'operator-home');
  const artifacts = defaultTrainArtifactDirectory(home);
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, 'train-auto-loop-aws-prod.log'), [
    '11-02 14:40:00 [aws-prod] manager assigned stage=group prs=9 base=abc run=run-a slot=1',
    '11-02 14:48:00 [aws-prod] manager done stage=group run=run-a rc=0 · completed',
  ].join('\n'));
  delete process.env.ELANOUS_TRAIN_ARTIFACT_DIR;
  delete process.env.ELANOUS_TRAIN_SUMMARY_DIR;
  process.env.HOME = home;
  const response = await send('/v1/ops/train-throughput?date=2026-11-02', { authorization: `Bearer ${OWNER}` });
  if (!response) throw new Error('train throughput route returned no response');
  expect(response.status).toBe(200);
  const body = await response.json() as { hosts: Record<string, { assigned: number; succeeded: number }> };
  expect(body.hosts['aws-prod']).toMatchObject({ assigned: 1, succeeded: 1 });
});

test('train throughput API aggregates host logs and batch summary rejection categories behind operator auth', async () => {
  const { dir, send } = fixture(true);
  const artifacts = join(dir, 'train-artifacts');
  mkdirSync(join(artifacts, 'batch-aws-prod-run-a'), { recursive: true });
  mkdirSync(join(artifacts, 'batch-aws-prod-corrupt'), { recursive: true });
  writeFileSync(join(artifacts, 'batch-aws-prod-corrupt', 'summary.json'), '{ incomplete');
  process.env.ELANOUS_TRAIN_ARTIFACT_DIR = artifacts;
  writeFileSync(join(artifacts, 'train-auto-loop-aws-prod.log'), [
    '11-02 14:40:00 [aws-prod] manager assigned stage=group prs=1,2 base=abc run=run-a slot=2',
    '11-02 14:48:00 [aws-prod] manager done stage=group run=run-a rc=2 · BATCH REFUSED: gate verdict not pass',
  ].join('\n'));
  writeFileSync(join(artifacts, 'batch-aws-prod-run-a', 'manifest.json'), JSON.stringify({ host: 'aws-prod', base: 'base40', members: [{ pr: '1', head: 'head40' }, { pr: '2', head: 'head41' }] }));
  writeFileSync(join(artifacts, 'batch-aws-prod-run-a', 'summary.json'), JSON.stringify({
    verdict: 'failed', exitCode: 1, typecheck: { status: 'failed' }, trainAlwaysRatchets: { status: 'passed' },
    introduced: 1, preconditionUnmet: 0,
  }));
  const headers = { authorization: `Bearer ${OWNER}` };
  expect((await send('/v1/ops/train-throughput?date=2026-02-30', headers))?.status).toBe(400);
  expect((await send('/v1/ops/train-throughput?date=2026-11-02'))?.status).toBe(403);
  const response = await send('/v1/ops/train-throughput?date=2026-11-02', headers);
  if (!response) throw new Error('train throughput route returned no response');
  expect(response.status).toBe(200);
  const body = await response.json() as { sourceIncomplete: boolean; hosts: Record<string, { assigned: number; rejectedByReason: Record<string, number> }>; attempts: Array<{ ledgerKeys?: Array<{ pr: string; head: string; base: string }> }> };
  expect(body.sourceIncomplete).toBe(true);
  expect(body.hosts['aws-prod']?.assigned).toBe(1);
  expect(body.hosts['aws-prod']?.rejectedByReason).toMatchObject({ typecheck: 1, introduced: 1 });
  expect(body.attempts[0]?.ledgerKeys).toEqual([{ pr: '1', head: 'head40', base: 'base40' }, { pr: '2', head: 'head41', base: 'base40' }]);
});

test('resource ledger: operator-gated handler returns the mocked host/lane snapshot without local paths', async () => {
  const { send } = fixture(true);
  const at = '2026-11-02T00:00:00.000Z';
  let reads = 0;
  setResourceLedgerSnapshotForTest(() => {
    reads++;
    const snapshot = buildResourceLedgerSnapshot({
      events: () => [
        { event: 'lease-created', at, lease: { id: 'fp_ledger1234', fp: 'fp_ledger1234', host: 'gcp2', lane: 'gate', resources: {}, mission: {},
          ttlMs: 60_000, heartbeatAt: at, startedAt: at } },
        { event: 'lease-ended', at, id: 'fp_ledger1234', reason: 'open:/private/config C:\\Users\\secret Bearer ' + API_KEY,
          stoppedBy: 'guardian-reconcile /var/lib/private Bearer ' + API_KEY },
      ],
      hosts: () => [{ host: 'gcp2', poolMapped: true, capacity: { gate: 4 } }],
      now: () => new Date(at),
      run: (command, args) => {
        if (command === 'kubectl' && args.includes('nodes')) return { status: 0,
          stdout: JSON.stringify({ items: [{ metadata: { name: 'gcp2-node' } }] }), stderr: '' };
        if (command === 'kubectl') return { status: 0, stdout: JSON.stringify({ items: [{
          metadata: { namespace: 'harness', name: 'gate-pod', labels: { 'elanous.ai/fp': 'fp_ledger1234', 'elanous.ai/lane': 'gate' } },
          status: { phase: 'Running' }, spec: { nodeName: 'gcp2-node', containers: [{ resources: { requests: { cpu: '500m', memory: '128Mi' } } }] },
        }] }), stderr: '' };
        if (command === 'ps') return { status: 0, stdout: '123 1 elanous train fp_ledger1234\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    return { ...snapshot,
      findings: [...snapshot.findings, { kind: 'measurement-unavailable' as const, host: 'gcp2', id: 'fixture',
        detail: `open:/비밀/설정; unc=//비밀 Bearer ${API_KEY}`, action: 'report-only' as const }],
      measurements: snapshot.measurements.map(measurement => ({ ...measurement,
        errors: [`kubectl: /tmp/kubeconfig Bearer ${API_KEY}`],
        processes: [{ id: 'pid:123', fp: 'fp_ledger1234', command: `kubectl --token ${API_KEY} --kubeconfig /tmp/kubeconfig` }],
      })),
    };
  });

  expect((await send('/v1/ops/resources/ledger'))?.status).toBe(401);
  expect((await send('/v1/ops/resources/ledger', { 'x-elanous-operator': 'forged-forged-forged-forged' }))?.status).toBe(403);
  expect(reads).toBe(0);
  const response = await send('/v1/ops/resources/ledger', { 'x-elanous-operator': SECRET });
  expect(response?.status).toBe(200);
  expect(response?.headers.get('cache-control')).toBe('no-store');
  const responseText = await response?.text() ?? '';
  const body = JSON.parse(responseText) as { ledgerPath?: string; observedAt: string; matrix: Array<{ host: string; lane: string; leases: number; measuredPods: number | null }>;
    findings: Array<{ detail: string }>; measurements: Array<{ host: string; pods: Array<{ phase: string }>; processes: Array<{ id: string; fp?: string; command?: string }>;
      errors: string[] }> };
  expect(body.ledgerPath).toBeUndefined();
  expect(responseText).not.toContain('/tmp/kubeconfig');
  expect(responseText).not.toContain('/home/operator/.kube/config');
  expect(responseText).not.toContain('/비밀/설정');
  expect(responseText).not.toContain('//비밀');
  expect(responseText).not.toContain(API_KEY);
  expect(responseText).not.toContain('kubectl --token');
  expect(responseText).not.toContain('open:/비밀/설정');
  expect(responseText).not.toContain('C:\\Users\\secret');
  expect(responseText).toContain("\"reason\":\"[path] [path] Bearer sk-***\"");
  expect(responseText).toContain("\"stoppedBy\":\"guardian-reconcile [path] Bearer sk-***\"");
  expect(body.measurements[0]?.processes).toEqual([{ id: 'pid:123', fp: 'fp_ledger1234' }]);
  expect(body.observedAt).toBe(at);
  expect(body.matrix).toContainEqual(expect.objectContaining({ host: 'gcp2', lane: 'gate', leases: 0, measuredPods: 1 }));
  expect(body.measurements[0]).toMatchObject({ host: 'gcp2', pods: [{ phase: 'Running' }] });
  expect(reads).toBe(1);
  expect((await send('/v1/ops/resources/ledger', { 'x-elanous-operator': SECRET }, 'POST'))?.status).toBe(405);
  expect(reads).toBe(1);
});

test('resource ledger accepts host heartbeat only from its matching expiring machine token', async () => {
  const { dir, sendSecure } = fixture(undefined);
  const token = issueMemberToken('minim5', dir);
  const heartbeat = { at: new Date().toISOString(), sshAvailable: true, maintenance: false, gateProtected: false,
    tools: { bun: true, repoGit: true }, sample: { loadPercent: 10, load15Percent: 20, memoryAvailablePercent: 50,
      rootDiskUsedPercent: 60, tmpDiskUsedPercent: 60 } };
  const path = '/v1/resource-ledger/host-readiness';
  const mismatched = await sendSecure(path, { authorization: `Bearer ${token}` }, 'POST', JSON.stringify({ ...heartbeat, host: 'aws1' }));
  expect(mismatched?.status).toBe(403);
  expect(resourceLedger.readResourceLedger(resourceLedger.resourceLedgerPath(dir))).toEqual([]);
  const accepted = await sendSecure(path, { authorization: `Bearer ${token}` }, 'POST', JSON.stringify(heartbeat));
  expect(accepted?.status).toBe(201);
  expect(accepted?.headers.get('cache-control')).toBe('no-store');
  expect(resourceLedger.readResourceLedger(resourceLedger.resourceLedgerPath(dir))).toMatchObject([
    { event: 'host-readiness-heartbeat', heartbeat: { host: 'minim5', at: heartbeat.at } },
  ]);
});

test('guardian resource route is a read-only projection of the cached snapshot', async () => {
  const { send } = fixture(true);
  setLatestResourceSnapshotForTest(null);
  const headers = { 'x-elanous-operator': SECRET };
  expect((await send('/v1/ops/resources/guardian'))?.status).toBe(401);
  expect((await send('/v1/ops/resources/guardian', { 'x-elanous-operator': 'forged-forged-forged-forged' }))?.status).toBe(403);
  const pending = await (await send('/v1/ops/resources/guardian', headers))?.json() as { state: string; observedAt: string | null };
  expect(pending).toMatchObject({ state: 'pending', observedAt: null });

  const at = '2026-11-02T00:00:00.000Z';
  const lease = { id: 'fp_guardian01', fp: 'fp_guardian01', host: 'aws2', lane: 'gate' as const, resources: {}, mission: {},
    ttlMs: 60_000, heartbeatAt: at, startedAt: at };
  setLatestResourceSnapshotForTest({ observedAt: at, matrix: [], leases: [lease], measurements: [],
    findings: [{ kind: 'drift', host: 'gcp2', id: lease.fp, fp: lease.fp, detail: 'self-gate expected=gcp2/gate lease=aws2/gate', action: 'report-only' }],
    cleanup: { mode: 'dry-run', candidates: [], reaped: [], skipped: [], errors: [], mutations: [] },
    releaseReservation: { status: 'free' }, stale: false } as unknown as ResourceReconcileSnapshot);
  const tick = spyOn(guardianReconcile, 'resourceReconcileTick');
  const collect = spyOn(resourceCli, 'defaultResourceRun');
  const reap = spyOn(resourceLedger, 'reapResourceLeaseIfCurrent');
  try {
    const response = await send('/v1/ops/resources/guardian', headers);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    const body = await response?.json() as { state: string; observedAt: string; findings: Array<{ kind: string; id: string }>; cleanup: { reaped: number }; releaseReservation: { status: string; reason: string } };
    expect(body).toMatchObject({ state: 'ready', observedAt: at, cleanup: { reaped: 0 } });
    expect(body.findings).toContainEqual(expect.objectContaining({ kind: 'drift', id: lease.fp }));
    await send('/v1/ops/resources/guardian', headers);
    await send('/v1/ops/resources/guardian', headers);
    expect((await send('/v1/ops/resources/guardian', headers))?.status).toBe(200);
    expect(body.releaseReservation).toEqual(expect.objectContaining({ status: expect.any(String), reason: expect.any(String) }));
    expect(tick).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    expect(reap).not.toHaveBeenCalled();
    expect((await send('/v1/ops/resources/guardian', headers, 'POST'))?.status).toBe(405);
  } finally {
    tick.mockRestore(); collect.mockRestore(); reap.mockRestore();
  }
});

test('overview: routeRequest reuses operator gate, no-store, snapshot memo and background-only Pod measurement', async () => {
  const { send } = fixture(true);
  let clock = Date.now();
  let collects = 0;
  let podCalls = 0;
  let tick = () => {};
  let interval = 0;
  const cell = <T>(value: T) => okCell(value, 'test ledger', new Date(clock).toISOString());
  const collect = async (): Promise<OverviewSnapshot> => {
    collects++;
    return {
      generatedAt: new Date(clock).toISOString(), instanceRoot: '/test', since: '최근 1h',
      release: { version: cell('0.2.24'), run: cell('none' as const), schedule: cell('none' as const), checklist: cell({ green: 1, yellow: 0, red: 0, done: 0, p0Yellow: 0 }) },
      tasks: { byOwner: cell({}), done: unmeasured('test', 'not connected'),
        launchable: cell({ count: 0, ids: [], skipped: { noTargetPath: 0, predecessorOpen: 0, alreadyHanded: 0 }, interim: true }),
        capacity: cell({ podUsed: 0, podTarget: 2, localUsed: 0, localMax: 0, free: 2 }) },
      machines: { hosts: [], pods: [{ context: 'pool-a', capacity: 2, occupied: unmeasured('pod pool', 'pending') }], parents: cell({ count: 0, staleOver6h: 0, oldestHours: null }) },
      landings: cell({ count: 0, recent: [] }), loops: [],
    };
  };
  setOverviewCacheForTest(createOverviewCache({ now: () => clock, collect, measurePods: async () => {
    podCalls++;
    return [{ context: 'pool-a', occupied: 1, reason: null, observedAt: clock }];
  }, schedule: (fn, ms) => { interval = ms; tick = fn; return ({ unref() {} }) as ReturnType<typeof setInterval>; } }));
  const headers = { 'x-elanous-operator': SECRET };
  expect((await send('/v1/ops/overview'))?.status).toBe(403);
  expect((await send('/v1/ops/overview', { 'x-elanous-operator': 'forged-forged-forged-forged' }))?.status).toBe(403);
  expect(collects).toBe(0);
  expect((await send('/v1/ops/overview?since=bad', headers))?.status).toBe(400);
  const started = performance.now();
  const first = await send('/v1/ops/overview', headers);
  const durationMs = performance.now() - started;
  expect(durationMs).toBeLessThan(2_000);
  expect(first?.status).toBe(200);
  expect(first?.headers.get('cache-control')).toBe('no-store');
  const body = await first?.json() as { verdict: string; reasons: string[]; machines: OverviewSnapshot['machines']; cacheAgeMs: number };
  expect(body.verdict).toBe('supply-empty');
  expect(body.reasons[0]).toContain('빈 자리 2');
  expect(body.machines.pods[0]?.occupied).toMatchObject({ value: null, status: 'unmeasured' });
  expect(podCalls).toBe(0);
  expect(interval).toBe(60_000);
  clock += 9_999;
  expect((await (await send('/v1/ops/overview', { authorization: `Bearer ${OWNER}` }))?.json() as { cacheAgeMs: number }).cacheAgeMs).toBe(9_999);
  expect(collects).toBe(1);
  tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clock++;
  const refreshed = await (await send('/v1/ops/overview', headers))?.json() as { machines: OverviewSnapshot['machines'] };
  expect(refreshed.machines.pods[0]?.occupied.value).toBe(1);
  expect(collects).toBe(2);
  expect(podCalls).toBe(1);
  expect((await send('/v1/ops/release/runs', headers))?.status).toBe(200);
});

test('overview default background snapshot: first read returns pending promptly and repeated reads remain available', async () => {
  const { send } = fixture(true);
  const start = performance.now();
  const first = await send('/v1/ops/overview', { 'x-elanous-operator': SECRET });
  expect(performance.now() - start).toBeLessThan(2_000);
  expect(first?.status).toBe(200);
  expect((await first?.json() as { verdict: string }).verdict).toBe('unobservable');
  const second = await send('/v1/ops/overview', { 'x-elanous-operator': SECRET });
  expect(second?.status).toBe(200);
  expect((await second?.json() as { generatedAt: string }).generatedAt).toBeTruthy();
  // The real worker collection lands: a version only the request carries comes back measured.
  const path = '/v1/ops/overview?version=9.9.77';
  const pendingRead = await (await send(path, { 'x-elanous-operator': SECRET }))?.json() as { release: { version: { value: string | null } } };
  expect(pendingRead.release.version.value).toBeNull();
  let collected: { release: { version: { value: string | null; status: string } } } | undefined;
  for (let attempt = 0; attempt < 100 && collected?.release.version.value !== '9.9.77'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    collected = await (await send(path, { 'x-elanous-operator': SECRET }))?.json() as typeof collected;
  }
  expect(collected?.release.version).toMatchObject({ value: '9.9.77', status: 'ok' });
}, 30_000);

test('default install with owner bearer refuses all ops data', async () => {
  const { send, run } = fixture(undefined);
  run('run-1', '2026-10-02T00:00:00Z');
  for (const path of ['/v1/ops/overview', '/v1/ops/loops-map', '/v1/ops/release/runs', '/v1/ops/release/runs/run-1/nodes/version-release/log', '/v1/ops/checklist?version=0.2.9']) {
    const response = await send(path, { authorization: `Bearer ${OWNER}` });
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: 'forbidden' });
  }
});

test('enabled but forged proxy header without owner token is refused', async () => {
  const { send } = fixture(true);
  expect((await send('/v1/ops/release/runs', { 'x-elanous-operator': 'forged-forged-forged-forged' }))?.status).toBe(403);
});

test('enabled and correct proxy header serves redacted run summaries and node logs, without bearer', async () => {
  const { send, run } = fixture(true);
  const summary = `${API_KEY} ${'a'.repeat(310)}`;
  const log = `begin ${'z'.repeat(4100)} ${API_KEY} end`;
  run('run-1', '2026-10-02T00:00:00Z', '0.2.9', JSON.stringify({ summary, log }));
  const headers = { 'x-elanous-operator': SECRET };
  const response = await send('/v1/ops/release/runs?version=0.2.9', headers);
  expect(response?.status).toBe(200);
  expect(response?.headers.get('cache-control')).toBe('no-store');
  const runs = await response?.json() as Array<{ runId: string; status: string; startedAt: string; version: string; path: string[];
    graph?: { nodes: Array<{ nodeId: string; kind: string }> }; nodes: Array<{ nodeId: string; ok: boolean; summary: string }> }>;
  const { graph, ...runSummary } = runs[0]!;
  expect([runSummary]).toEqual([{
    runId: 'run-1', status: 'running', startedAt: '2026-10-02T00:00:00Z', version: '0.2.9', path: ['version-release'],
    nodes: [{ nodeId: 'version-release', ok: true, summary: `sk-*** ${'a'.repeat(293)}` }],
  }]);
  expect(graph?.nodes.some((node) => node.nodeId === 'gate' && node.kind === 'gate')).toBe(true);
  expect(JSON.stringify(runs)).not.toContain(API_KEY);
  const logResponse = await send('/v1/ops/release/runs/run-1/nodes/version-release/log', headers);
  expect(logResponse?.status).toBe(200);
  const body = await logResponse?.json() as { log: string };
  expect(body.log.length).toBe(4000);
  expect(JSON.stringify(body)).not.toContain(API_KEY);
  expect((await send('/v1/ops/release/runs/run-1/nodes/missing/log', headers))?.status).toBe(404);
});

test('run list redacts secrets in stored metadata without a version filter', async () => {
  const { dir, send } = fixture(true);
  const folder = join(dir, 'graph-runs', 'release-loop');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'run-1.json'), JSON.stringify({
    status: `running ${API_KEY}`, path: [`version-release ${API_KEY}`],
    startedAt: `2026-10-02T00:00:00Z ${API_KEY}`,
    input: { version: API_KEY },
    nodes: [{ nodeId: `version-release ${API_KEY}`, ok: true, output: { summary: 'ok' } }],
  }));
  const response = await send('/v1/ops/release/runs', { 'x-elanous-operator': SECRET });
  expect(response?.status).toBe(200);
  const body = await response?.text() ?? '';
  expect(body).not.toContain(API_KEY);
  const parsedRuns = JSON.parse(body) as Array<{ graph?: { nodes: Array<{ nodeId: string; kind: string }> }; runId: string;
    status: string; startedAt: string; version: string | null; path: string[]; nodes: Array<{ nodeId: string; ok: boolean; summary: string }> }>;
  const { graph, ...runSummary } = parsedRuns[0]!;
  expect([runSummary]).toEqual([{
    runId: 'run-1', status: 'running sk-***', startedAt: '2026-10-02T00:00:00Z sk-***',
    version: null, path: ['version-release sk-***'],
    nodes: [{ nodeId: 'version-release sk-***', ok: true, summary: 'ok' }],
  }]);
  expect(graph?.nodes.some((node) => node.nodeId === 'gate' && node.kind === 'gate')).toBe(true);
  writeFileSync(join(folder, `${API_KEY}.json`), JSON.stringify({
    status: 'running', path: [], startedAt: '2026-10-01T00:00:00Z',
    input: { version: '0.2.9' }, nodes: [],
  }));
  const withSecretId = await send('/v1/ops/release/runs', { 'x-elanous-operator': SECRET });
  const withSecretIdBody = await withSecretId?.text() ?? '';
  expect(withSecretIdBody).not.toContain(API_KEY);
  expect(JSON.parse(withSecretIdBody)[1]?.runId).toBe('sk-***');
});

test('run list never returns a malformed node ok containing a secret', async () => {
  const { dir, send } = fixture(true);
  const folder = join(dir, 'graph-runs', 'release-loop');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'run-1.json'), JSON.stringify({
    status: 'running', path: [], startedAt: '2026-10-02T00:00:00Z',
    input: { version: '0.2.9' },
    nodes: [{ nodeId: 'version-release', ok: { key: API_KEY }, output: { summary: 'ok' } }],
  }));
  const response = await send('/v1/ops/release/runs', { 'x-elanous-operator': SECRET });
  expect(response?.status).toBe(200);
  const body = await response?.text() ?? '';
  expect(body).not.toContain(API_KEY);
  expect(JSON.parse(body)[0]?.nodes).toEqual([{ nodeId: 'version-release', ok: null, summary: 'ok' }]);
});

test('run summary reads the last JSON object from multi-line node output', async () => {
  const { send, run } = fixture(true);
  run('run-1', '2026-10-02T00:00:00Z', '0.2.9', `first line\n${JSON.stringify({ summary: `completed ${API_KEY}` })}\n`);
  const response = await send('/v1/ops/release/runs', { 'x-elanous-operator': SECRET });
  const runs = await response?.json() as Array<{ nodes: Array<{ summary: string }> }>;
  expect(runs[0]?.nodes[0]?.summary).toBe('completed sk-***');
});

test('enabled owner bearer serves the listChecklist data plus the version schedule (null when unset)', async () => {
  const { dir, send } = fixture(true);
  const folder = join(dir, 'release', '0.2.9');
  mkdirSync(folder, { recursive: true });
  const item = { id: 'OPS1', title: 'release', status: 'green', updatedAt: '2026-10-02', updatedBy: 'test' };
  writeFileSync(join(folder, 'checklist.json'), JSON.stringify({ version: '0.2.9', released: '', dev: '', items: [item], history: [] }));
  const { listChecklist } = await import('../../release-loop/checklist.js');
  const expected = listChecklist('0.2.9');
  const response = await send('/v1/ops/checklist?version=0.2.9', { authorization: `Bearer ${OWNER}` });
  expect(response?.status).toBe(200);
  const body = await response?.json() as { items: Array<{ id: string }> };
  expect(body.items).toContainEqual(item);
  expect(body as unknown).toEqual({ ...expected, schedule: null });
  expect((await send('/v1/ops/checklist?version=../../secrets', { authorization: `Bearer ${OWNER}` }))?.status).toBe(400);
});

test('rejects traversal and invalid ids before touching the filesystem', async () => {
  const { send } = fixture(true);
  const headers = { 'x-elanous-operator': SECRET };
  expect((await send('/v1/ops/release/runs/../nodes/one/log', headers))?.status).toBe(400);
  for (const id of ['..%2Fsecret', '%2E%2E%5Csecret', 'bad_id']) {
    expect((await send(`/v1/ops/release/runs/${id}/nodes/one/log`, headers))?.status).toBe(400);
  }
  expect((await send('/v1/ops/release/runs/run-1/nodes/bad_id/log', headers))?.status).toBe(400);
  expect((await send('/v1/ops/release/runs?version=../', headers))?.status).toBe(400);
  expect((await send('/v1/ops/release/runs', headers, 'POST'))?.status).toBe(405);
});

test('run list filters by version, orders newest first and caps at 20', async () => {
  const { send, run } = fixture(true);
  for (let i = 0; i < 22; i++) run(`run-${i}`, `2026-10-02T00:00:${String(i).padStart(2, '0')}Z`);
  run('other-version', '2026-10-02T01:00:00Z', '0.2.8');
  const response = await send('/v1/ops/release/runs?version=0.2.9', { authorization: `Bearer ${OWNER}` });
  const runs = await response?.json() as Array<{ runId: string }>;
  expect(runs).toHaveLength(20);
  expect(runs[0]?.runId).toBe('run-21');
  expect(runs.at(-1)?.runId).toBe('run-2');
});

test('ops observability records path and source, never credentials', async () => {
  const { send } = fixture(true);
  const records: unknown[] = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'ops.api' && (event === 'served' || event === 'refused')) records.push({ event, data });
  });
  try {
    await send('/v1/ops/release/runs', { 'x-elanous-operator': 'forged-forged-forged-forged' });
    await send('/v1/ops/release/runs', { 'x-elanous-operator': SECRET });
    expect(records).toEqual([
      { event: 'refused', data: { path: '/v1/ops/release/runs', source: null } },
      { event: 'served', data: { path: '/v1/ops/release/runs', source: 'op-proxy' } },
    ]);
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(JSON.stringify(records)).not.toContain(OWNER);
  } finally { spy.mockRestore(); }
});

test('seats: refused without the operator signal, 400 on a bad date, and served from the (injected) board', async () => {
  const { setSeatsCacheForTest } = await import('./ops-api.js');
  const { createSeatsCache } = await import('./ops-seats.js');
  const { send } = fixture(true);
  setSeatsCacheForTest(createSeatsCache({ channel: async () => null, merged: async () => null, checklist: () => null, openDecisionRaisers: () => [] }));
  try {
    expect((await send('/v1/ops/seats'))?.status).toBe(403);
    expect((await send('/v1/ops/seats', { 'x-elanous-operator': 'forged-forged-forged-forged' }))?.status).toBe(403);
    const headers = { 'x-elanous-operator': SECRET };
    expect((await send('/v1/ops/seats?date=2026-13-45', headers))?.status).toBe(400);
    expect((await send('/v1/ops/seats?date=yesterday', headers))?.status).toBe(400);
    const response = await send('/v1/ops/seats?date=2026-10-02', headers);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    const board = await response?.json() as { date: string; seats: Array<{ seat: string; now: unknown; pendingDecisions: unknown }> };
    expect(board.date).toBe('2026-10-02');
    expect(board.seats.map((row) => [row.seat, row.now, row.pendingDecisions])).toEqual([['OP', null, 0], ['TC', null, 0], ['MK', null, 0], ['UX', null, 0]]);
  } finally { setSeatsCacheForTest(null); }
});

test('checklist carries the version schedule (cut · land-by) or null when none is set', async () => {
  const { setSchedule } = await import('../../release-loop/release-schedule.js');
  const { send } = fixture(true);
  const headers = { 'x-elanous-operator': SECRET };
  const before = await (await send('/v1/ops/checklist?version=0.2.10', headers))!.json() as { schedule: unknown };
  expect(before.schedule).toBeNull();
  setSchedule('0.2.10', { cutAt: '2026-10-03T08:00+09:00', landBy: '2026-10-03T06:30+09:00' }, 'test');
  const after = await (await send('/v1/ops/checklist?version=0.2.10', headers))!.json() as { schedule: { cutAt: string; landBy: string | null } };
  expect(after.schedule).toEqual({ cutAt: '2026-10-02T23:00:00.000Z', landBy: '2026-10-02T21:30:00.000Z' });
});

test('GRAPH-NODE-TIMES: run list carries ledger node times and the running node start; old ledgers carry none', async () => {
  const { dir, send } = fixture(true);
  const folder = join(dir, 'graph-runs', 'release-loop');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'timed.json'), JSON.stringify({
    status: 'running', path: ['version-release', 'gate'], startedAt: '2026-10-07T00:00:00.000Z', input: { version: '0.2.19' },
    nodes: [{ nodeId: 'version-release', ok: true, output: '', startedAt: '2026-10-07T00:00:01.000Z', endedAt: '2026-10-07T00:02:00.000Z', seconds: 119 }],
    currentNode: { nodeId: 'gate', startedAt: '2026-10-07T00:02:01.000Z' },
  }));
  writeFileSync(join(folder, 'legacy.json'), JSON.stringify({
    status: 'failed', path: ['version-release'], startedAt: '2026-10-06T00:00:00.000Z', input: { version: '0.2.18' },
    nodes: [{ nodeId: 'version-release', ok: false, output: '', startedAt: 'not a time', endedAt: 'October 7, 2026' }],
    currentNode: { nodeId: 'version-release', startedAt: '2026-10-06T00:00:01.000Z' },
  }));
  const response = await send('/v1/ops/release/runs', { 'x-elanous-operator': SECRET });
  const runs = await response?.json() as Array<{ runId: string; nodes: unknown[] }>;
  expect(runs.find((run) => run.runId === 'timed')?.nodes).toEqual([
    { nodeId: 'version-release', ok: true, summary: '', startedAt: '2026-10-07T00:00:01.000Z', endedAt: '2026-10-07T00:02:00.000Z' },
    { nodeId: 'gate', ok: null, summary: '', startedAt: '2026-10-07T00:02:01.000Z' },
  ]);
  expect(runs.find((run) => run.runId === 'legacy')?.nodes).toEqual([{ nodeId: 'version-release', ok: false, summary: '' }]);
});

test('GATE-LIVE-OBS: a run sitting on gate carries the shard table of its own version; other runs and other versions do not', () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-gate-shards-'));
  try {
    const folder = join(root, 'runs');
    mkdirSync(folder, { recursive: true });
    const gate = (version: string) => JSON.stringify({ status: 'running', path: ['version-release', 'gate'], startedAt: '2026-10-07T00:00:00.000Z',
      input: { version }, nodes: [{ nodeId: 'version-release', ok: true, output: '' }], currentNode: { nodeId: 'gate', startedAt: '2026-10-07T00:02:00.000Z' } });
    writeFileSync(join(folder, 'on-gate.json'), gate('0.2.20'));
    writeFileSync(join(folder, 'no-file.json'), gate('0.2.21'));
    writeFileSync(join(folder, 'publishing.json'), JSON.stringify({ status: 'running', path: ['gate', 'publish'], startedAt: '2026-10-06T00:00:00.000Z',
      input: { version: '0.2.20' }, nodes: [{ nodeId: 'gate', ok: true, output: '' }], currentNode: { nodeId: 'publish', startedAt: '2026-10-06T01:00:00.000Z' } }));
    writeGateShards(gateShardsPath('0.2.20', root), { v: 1, version: '0.2.20', runId: 'on-gate', updatedAt: '2026-10-07T00:30:00.000Z', shards: [
      { id: 'pod-0', state: 'running', startedAt: '2026-10-07T00:20:00.000Z', plannedMin: 20 },
      { id: 'pod-1', state: 'pending', waitReason: 'CPU 부족 31.2/32', plannedMin: 10 },
    ] });
    const runs = readReleaseRuns(null, folder, { ledgerRoot: root, now: Date.parse('2026-10-07T00:30:00.000Z') });
    if (runs === 'unavailable') throw new Error('unavailable');
    const onGate = runs.find((run) => run.runId === 'on-gate');
    expect(onGate?.gateShards?.shards.map((shard) => shard.state)).toEqual(['running', 'pending']);
    expect(onGate?.gateShards?.summary).toMatchObject({ total: 2, etaMin: 20, waitReasons: [{ reason: 'CPU 부족 31.2/32', count: 1 }] });
    expect(runs.find((run) => run.runId === 'no-file')?.gateShards).toBeUndefined();
    expect(runs.find((run) => run.runId === 'publishing')?.gateShards).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release gate progress is bounded, ordered, redacted, run-owned, and streamed only to its matching run', async () => {
  const { dir, send } = fixture(true);
  const folder = join(dir, 'graph-runs', 'release-loop');
  const runId = 'run-a';
  const startedAt = '2026-10-07T00:02:00.000Z';
  mkdirSync(join(folder, `${runId}.json.contexts`), { recursive: true });
  writeFileSync(join(folder, `${runId}.json`), JSON.stringify({ graphId: 'release-loop', runId, status: 'running',
    path: ['gate'], startedAt, input: { version: '0.3.7' }, nodes: [], currentNode: { nodeId: 'gate', startedAt } }));
  writeFileSync(join(folder, 'other-run.json'), JSON.stringify({ graphId: 'release-loop', runId: 'other-run', status: 'running',
    path: ['gate'], startedAt, input: { version: '0.3.7' }, nodes: [], currentNode: { nodeId: 'gate', startedAt } }));
  writeFileSync(join(folder, `${runId}.json.contexts`, '10.json.gate-progress.jsonl'), `${JSON.stringify({
    phase: 'shard-decision', eventId: 'event-10', at: '2026-10-07T00:03:10.000Z', shard: 'pod-1', decision: 'rerun', reason: 'token=private-value',
  })}\n`);
  writeFileSync(join(folder, `${runId}.json.contexts`, '2.json.gate-progress.jsonl'), `${JSON.stringify({
    phase: 'shard-plan', eventId: 'event-2', at: '2026-10-07T00:03:02.000Z', rerunReasons: { 'api_key=private-key': 1 },
  })}\n`);
  writeGateShards(gateShardsPath('0.3.7', dir), { v: 1, version: '0.3.7', runId,
    updatedAt: '2026-10-07T00:03:10.000Z', shards: [{ id: 'pod-1', state: 'running', reuseReason: 'token=private-value' }] });
  const headers = { 'x-elanous-operator': SECRET };
  const list = await (await send('/v1/ops/release/runs', headers))?.json() as Array<Record<string, unknown>>;
  const run = list.find((item) => item.runId === runId)!;
  const serialized = JSON.stringify(run);
  expect(serialized).not.toContain('private-value');
  expect(serialized).not.toContain('private-key');
  expect((run.gateProgress as Array<{ eventId: string }>).map((event) => event.eventId)).toEqual(['event-2', 'event-10']);
  expect(list.find((item) => item.runId === 'other-run')?.gateShards).toBeUndefined();

  const controller = new AbortController();
  const response = await send(`/v1/ops/release/runs/${runId}/events`, headers, 'GET', controller.signal);
  expect(response?.status).toBe(200);
  const reader = response!.body!.getReader();
  await reader.read(); // connected frame
  publishInsideEvent({ kind: 'release.gate.progress', graphId: 'release-loop', runId: 'other-run', eventId: 'wrong-run', data: {} });
  publishInsideEvent({ kind: 'release.gate.progress', graphId: 'release-loop', runId, eventId: 'live-event', data: { phase: 'shard-plan' } });
  const frame = new TextDecoder().decode((await reader.read()).value);
  expect(frame).toContain('live-event');
  expect(frame).not.toContain('wrong-run');
  await reader.cancel();
  controller.abort();
});

test('resources: bearerless 401, stale cache answered immediately, and the injected collector/ssh path is never called', async () => {
  const { send } = fixture(true);
  // No credential offered at all → 401, before the cache is even built.
  expect((await send('/v1/ops/resources'))?.status).toBe(401);
  let clock = Date.now();
  let collects = 0;
  let podCalls = 0;
  let tick = () => {};
  const collect = async (): Promise<OverviewSnapshot> => {
    collects++;
    return {
      generatedAt: new Date(clock).toISOString(), instanceRoot: '/test', since: '최근 1h',
      release: { version: okCell('0.2.28', 'test ledger', new Date(clock).toISOString()), run: okCell('none' as const, 'test ledger', new Date(clock).toISOString()), schedule: okCell('none' as const, 'test ledger', new Date(clock).toISOString()), checklist: okCell({ green: 1, yellow: 0, red: 0, done: 0, p0Yellow: 0 }, 'test ledger', new Date(clock).toISOString()) },
      tasks: { byOwner: okCell({}, 'test ledger', new Date(clock).toISOString()), done: okCell(0, 'test ledger', new Date(clock).toISOString()),
        launchable: okCell({ count: 0, ids: [], skipped: { noTargetPath: 0, predecessorOpen: 0, alreadyHanded: 0 }, interim: true }, 'test ledger', new Date(clock).toISOString()),
        capacity: okCell({ podUsed: 1, podTarget: 2, localUsed: 0, localMax: 0, free: 1 }, 'test ledger', new Date(clock).toISOString()) },
      machines: {
        hosts: [{ name: 'grid-1', load: okCell({ load1: 1.5, load5: 2.5, load15: 3.5, cpuCount: 8, freeGb: 4.5, totalGb: 16, ageSeconds: 30 }, 'machine heartbeat', new Date(clock).toISOString()) }],
        pods: [{ context: 'pool-a', capacity: 2, occupied: unmeasured('pod pool', 'pending') }],
        parents: okCell({ count: 0, staleOver6h: 0, oldestHours: null }, 'test ledger', new Date(clock).toISOString()),
      },
      landings: okCell({ count: 0, recent: [] }, 'test ledger', new Date(clock).toISOString()), loops: [],
    };
  };
  const headers = { 'x-elanous-operator': SECRET };
  // A cache with nothing in it yet: answered at once with { stale: true }, no collection started.
  setOverviewCacheForTest(createOverviewCache({ now: () => clock, collect, measurePods: async () => {
    podCalls++;
    return [{ context: 'pool-a', occupied: 1, reason: null, observedAt: clock }];
  }, schedule: (fn) => ({ unref() { tick = fn; } }) as ReturnType<typeof setInterval> }));
  try {
    const start = performance.now();
    const empty = await send('/v1/ops/resources', headers);
    expect(performance.now() - start).toBeLessThan(2_000);
    expect(empty?.status).toBe(200);
    expect(await empty?.json()).toEqual({ stale: true });
    expect(collects).toBe(0);
    expect(podCalls).toBe(0);
    // The overview read fills the memo; the map endpoint then folds it — collector not called again.
    await send('/v1/ops/overview', headers);
    expect(collects).toBe(1);
    const map = await (await send('/v1/ops/resources', headers))?.json() as {
      generatedAt: string; readAt: string; missing: string[];
      hosts: Array<{ name: string; load5: { value: number | null; observedAt: string | null; missing: string | null } }>;
      pods: Array<{ context: string; capacity: number; occupied: { value: number | null; observedAt: string | null; missing: string | null } }>;
    };
    expect(collects).toBe(1);
    expect(podCalls).toBe(0);
    expect(map.hosts[0]?.name).toBe('grid-1');
    expect(map.hosts[0]?.load5.value).toBe(2.5);
    expect(map.pods[0]).toEqual({ context: 'pool-a', capacity: 2, occupied: { value: null, observedAt: null, missing: '측정 대기' } });
    // After the background Pod tick the overlay lands without any new collection.
    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const overlaid = await (await send('/v1/ops/resources', headers))?.json() as typeof map;
    expect(collects).toBe(1);
    expect(podCalls).toBe(1);
    expect(overlaid.pods[0]?.occupied.value).toBe(1);
    expect(overlaid.pods[0]?.occupied.missing).toBeNull();
  } finally {
    setOverviewCacheForTest(null);
  }
});

test('loops-map: operator gate, projects cached loops with observedAt, preserves unmeasured null·reason, no new source calls', async () => {
  const { send } = fixture(true);
  let clock = Date.now();
  let collects = 0;
  const cell = <T>(value: T) => okCell(value, 'test ledger', new Date(clock).toISOString());
  const observedAt = () => new Date(clock).toISOString();
  const collect = async (): Promise<OverviewSnapshot> => {
    collects++;
    return {
      generatedAt: observedAt(), instanceRoot: '/test', since: '최근 1h',
      release: { version: cell('0.2.28'), run: cell('none' as const), schedule: cell('none' as const), checklist: cell({ green: 1, yellow: 0, red: 0, done: 0, p0Yellow: 0 }) },
      tasks: { byOwner: cell({}), done: cell(0),
        launchable: cell({ count: 0, ids: [], skipped: { noTargetPath: 0, predecessorOpen: 0, alreadyHanded: 0 }, interim: true }),
        capacity: cell({ podUsed: 1, podTarget: 2, localUsed: 0, localMax: 0, free: 1 }) },
      machines: { hosts: [], pods: [], parents: cell({ count: 0, staleOver6h: 0, oldestHours: null }) },
      landings: cell({ count: 0, recent: [] }),
      loops: [
        { name: 'version-release', era: 'product', staleAfterSeconds: null, beat: cell({ lastAt: observedAt(), ageSeconds: 60, alive: true }) },
        { name: 'echo-loop', era: 'seat-era', staleAfterSeconds: 600, beat: unmeasured('loop agent', '측정 대기') },
      ],
    };
  };
  let podCalls = 0;
  setOverviewCacheForTest(createOverviewCache({
    now: () => clock, collect,
    measurePods: async () => { podCalls++; return []; },
    schedule: () => ({ unref() {} }) as ReturnType<typeof setInterval>,
  }));
  const headers = { 'x-elanous-operator': SECRET };
  try {
    // Operator gate: no credential and a forged proxy header are both refused before any collection.
    const unauthenticated = await send('/v1/ops/loops-map');
    expect(unauthenticated?.status).toBe(401);
    expect(await unauthenticated?.json()).toEqual({ error: 'unauthorized' });
    const forged = await send('/v1/ops/loops-map', { 'x-elanous-operator': 'forged-forged-forged-forged' });
    expect(forged?.status).toBe(403);
    expect(await forged?.json()).toEqual({ error: 'forbidden' });
    expect(collects).toBe(0);
    // The overview read fills the shared memo; loops-map then projects it — collector not called again.
    const expectedGeneratedAt = observedAt();
    await send('/v1/ops/overview', headers);
    expect(collects).toBe(1);
    clock += 5_000;
    const map = await send('/v1/ops/loops-map', { authorization: `Bearer ${OWNER}` });
    expect(map?.status).toBe(200);
    expect(map?.headers.get('cache-control')).toBe('no-store');
    const body = await map?.json() as {
      generatedAt: string; cacheAgeMs: number;
      loops: Array<{ name: string; era: string; staleAfterSeconds: number | null; beat: { value: unknown; source: string; observedAt: string | null; status: string; reason?: string } }>;
    };
    // Cache-response shape: the projected snapshot carries the memo's own generatedAt and age.
    expect(body.generatedAt).toBe(expectedGeneratedAt);
    expect(body.cacheAgeMs).toBe(5_000);
    expect(body.loops.length).toBe(2);
    // Measured loop: name·era·beat observedAt pass through the projection unchanged.
    expect(body.loops[0]).toMatchObject({ name: 'version-release', era: 'product', staleAfterSeconds: null });
    // Loop-edge joining is a later shard: the response names no edges it cannot fill.
    expect(body).not.toHaveProperty('edges');
    expect(body.loops[0]?.beat.status).toBe('ok');
    expect(body.loops[0]?.beat.observedAt).toBe(expectedGeneratedAt);
    expect(body.loops[0]?.beat.value).toEqual({ lastAt: expectedGeneratedAt, ageSeconds: 60, alive: true });
    // Unmeasured loop: null value, its reason and the null observedAt are preserved verbatim.
    expect(body.loops[1]?.name).toBe('echo-loop');
    expect(body.loops[1]?.era).toBe('seat-era');
    // 주기 미상(null)과 알려진 주기는 캐시 값 그대로 — 지도가 «죽었다»로 읽지 않도록.
    expect(body.loops[1]?.staleAfterSeconds).toBe(600);
    expect(body.loops[1]?.beat.value).toBeNull();
    expect(body.loops[1]?.beat.status).toBe('unmeasured');
    expect(body.loops[1]?.beat.reason).toBe('측정 대기');
    expect(body.loops[1]?.beat.observedAt).toBeNull();
    // No additional source call: the loops-map read reused the memo filled by /v1/ops/overview.
    expect(collects).toBe(1);
    expect(podCalls).toBe(0);
  } finally {
    setOverviewCacheForTest(null);
  }
});

test('loops-map: cold cache answers empty with null generatedAt·cacheAgeMs and starts no collection', async () => {
  const { send } = fixture(true);
  const clock = Date.now();
  let collects = 0;
  let podCalls = 0;
  setOverviewCacheForTest(createOverviewCache({
    now: () => clock,
    collect: async () => { collects++; throw new Error('loops-map must not collect'); },
    measurePods: async () => { podCalls++; return []; },
    schedule: () => ({ unref() {} }) as ReturnType<typeof setInterval>,
  }));
  try {
    const headers = { 'x-elanous-operator': SECRET };
    const first = await send('/v1/ops/loops-map', headers);
    expect(first?.status).toBe(200);
    expect(first?.headers.get('cache-control')).toBe('no-store');
    // 원천 호출 0: 캐시가 비면 빈 지도 + null 그대로이고, 수집을 시작하지 않는다.
    expect(await first?.json()).toEqual({ generatedAt: null, cacheAgeMs: null, loops: [] });
    // 반복 조회도 같다 — 읽기가 수집을 유발하지 않는다.
    const again = await send('/v1/ops/loops-map', headers);
    expect(await again?.json()).toEqual({ generatedAt: null, cacheAgeMs: null, loops: [] });
    expect(collects).toBe(0);
    expect(podCalls).toBe(0);
  } finally {
    setOverviewCacheForTest(null);
  }
});
