import { expect, test } from 'bun:test';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { stringify as stringifyYaml } from 'yaml';
import { registerSimCommands } from '../cli/sim-cli.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { withSimClock } from './fake-clock.js';
import { compareDeviceRecording } from './device-fidelity.js';
import { createSimWorld } from './world-store.js';
import { assembleWorld, createWorld, createWorldRegressionTargetRunner, destroyWorld, destroyWorldById, executeWorldScenario, loadWorld, parseSimLoadConfig, runInWorld, runSimLoad, runWorldScenario, verifyWorldNetworkIsolation, type SimMailbox, type SuiteCase } from './world.js';
import { loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';
import { activeResourceLeases, beginResourceLease, readResourceLedger } from '../resource-ledger/resource-ledger.js';
import { readSimWorldWatchEvents } from './world-watch.js';
import { runMultiActorSimulation } from './multi-actor-world.js';
import { receiptFromWorld, runWorldRegressionSuite } from './world-regression-suite.js';

const scenarioPath = join(import.meta.dir, '../../scenarios/ux-sim/night-train-dead-pid-lock.yaml');
const worldPath = join(import.meta.dir, '../../scenarios/ux-sim/night-train-world.yaml');
const hqMoveScenarioPath = join(import.meta.dir, '../../scenarios/ux-sim/sim-hq-move.yaml');
const hqMoveWorldPath = join(import.meta.dir, '../../scenarios/ux-sim/sim-hq-move-world.yaml');

function findUsableBwrap(): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, 'bwrap');
    try { accessSync(candidate, fsConstants.X_OK); } catch { continue; }
    const probe = spawnSync(candidate, ['--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
      '--chdir', process.cwd(), process.execPath, '-e', 'process.exit(0)'],
    // Source: .rules/30-harness/testing-gates.md R-TST1; bound the OS namespace capability probe.
    { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return undefined;
}

const usableBwrap = process.platform === 'linux' ? findUsableBwrap() : undefined;

async function withPath<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = path;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

async function withWorldRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'sim-world-test-'));
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try { return await run(root); }
  finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}

const suiteCase: SuiteCase = { id: 'night-train', worldFile: worldPath, scenarioFile: scenarioPath, baselineFile: '/unused/baseline.json' };
test('sim target runs the declared world and scenario through the existing OS-isolated runner', async () => {
  await withWorldRoot(async () => {
    const runner = createWorldRegressionTargetRunner();
    const receipt = await runner.run(suiteCase, 'sim');
    expect(receipt.pass).toBe(true);
    // Source: #36347 SuiteReceipt reports scenario observations as steps.
    expect(receipt.steps.length).toBeGreaterThan(0);
    expect(receipt.eventKinds).toContain('dead-pid-lock');
  });
});

test('world regression target callback follows the R-MKT signature and refuses real without an isolated worker', async () => {
  await withWorldRoot(async () => {
    const runner = createWorldRegressionTargetRunner();
    await expect(runner.run(suiteCase, 'real')).rejects.toThrow('real target is unmeasured: isolated worker is unavailable');
  });
});

test('world lifecycle is rooted in the explicit test universe and destroys only its world', async () => {
  await withWorldRoot(async (root) => {
    const world = await createWorld(worldPath);
    expect(world.root).toBe(join(realpathSync(root), 'sim', 'worlds', 'night-train'));
    expect(existsSync(world.root)).toBe(true);
    expect(statSync(world.root).mode & 0o777).toBe(0o700);
    await destroyWorld(world);
    expect(existsSync(world.root)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });
});

test('multi-actor world device runs the actor simulation and returns its ledger', async () => {
  const assembled = assembleWorld({ spec: {
    // Source: SimWorldSpec declares seed as a nonnegative integer; this registration test uses its zero seed.
    world: 'multi-actor-test', seed: 0, devices: ['multi-actor-world'], events: [],
  } });
  const device = assembled.devices.get('multi-actor-world') as { run: typeof runMultiActorSimulation };
  expect(device.run).toBe(runMultiActorSimulation);
  const result = await device.run();
  expect(result.pass).toBe(true);
  expect(result.ledger).toEqual(expect.arrayContaining([
    { actorId: 'editing-agent', event: 'document.edit', outcome: 'revision-conflict' },
    { actorId: 'seat-beta', event: 'land.submit', outcome: 'overlap' },
  ]));
});

test('YAML world and scenario route LLM nodes through the hybrid fake-llm device', async () => {
  await withWorldRoot(async (root) => {
    const previousSandbox = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
    const worldFile = join(root, 'hybrid-llm-world.yaml');
    const scenarioFile = join(root, 'hybrid-llm-scenario.yaml');
    writeFileSync(worldFile, `world: hybrid-llm-world
seed: 1
devices: [fake-llm]
llm:
  mode: fake
  nodes: { summary: fake }
events: []
`, { mode: 0o600 });
    writeFileSync(scenarioFile, `world: hybrid-llm-world
steps:
  - llm:
      node: summary
      messages: [{ role: user, content: "world YAML path" }]
expect:
  responseContains: test-fake-llm
`, { mode: 0o600 });
    try {
      const world = await createWorld(worldFile);
      const result = await executeWorldScenario(world, scenarioFile);
      expect(result.pass).toBe(true);
      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]?.event).toBe('llm-node-summary');
    } finally {
      if (previousSandbox === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
      else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previousSandbox;
    }
  });
});

test('YAML world executes declared app RPC steps through the existing isolated scenario runner', async () => {
  await withWorldRoot(async (root) => {
    const previousSandbox = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
    const worldFile = join(root, 'declared-app-world.yaml');
    const scenarioFile = join(root, 'declared-app-scenario.yaml');
    writeFileSync(worldFile, 'world: declared-app-world\ndevices: [fake-clock]\nevents: []\n', { mode: 0o600 });
    writeFileSync(scenarioFile, `world: declared-app-world
steps:
  - rpc: addNote
    as: owner
appSimulation:
  manifest:
    apiVersion: elanous.app/v0
    slug: demo-app
    title: Demo
    roles:
      owner: { via: nexus-session }
    tables:
      notes:
        columns:
          id: { type: text, primary: true }
    rpc:
      addNote:
        sql: "INSERT INTO notes (id) VALUES ('created-by-real-rpc')"
        params: {}
        allow: [owner]
  scenario:
    name: add-note
    steps:
      - rpc: addNote
        as: owner
    expect:
      - table: notes
        rows: 1
`);
    try {
      const world = await createWorld(worldFile);
      const result = await executeWorldScenario(world, scenarioFile);
      expect(result).toMatchObject({ pass: true, appSimulationEvidence: {
        events: ['rpc.addNote.completed'], tableRows: { notes: 1 }, screenText: '',
      }, appSimulation: { receipts: [{ outcome: 'passed' }] }, externalNetworkEvents: [] });
      writeFileSync(scenarioFile, `world: declared-app-world
steps:
  - rpc: missingRpc
    as: owner
appSimulation:
  manifest:
    apiVersion: elanous.app/v0
    slug: demo-app
    title: Demo
    roles:
      owner: { via: nexus-session }
    tables:
      notes:
        columns:
          id: { type: text, primary: true }
    rpc:
      addNote:
        sql: "INSERT INTO notes (id) VALUES ('created-by-real-rpc')"
        params: {}
        allow: [owner]
  scenario:
    name: missing-rpc-fails
    steps:
      - rpc: missingRpc
        as: owner
    expect: []
`);
      const failed = await executeWorldScenario(world, scenarioFile);
      expect(failed).toMatchObject({ pass: false, appSimulation: { receipts: [{ outcome: 'failed' }] },
        appSimulationEvidence: { events: [], tableRows: { notes: 0 } } });
      await destroyWorld(world);
    } finally {
      if (previousSandbox === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
      else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previousSandbox;
    }
  });
});

test('YAML app action authorization follows its declared role allow list', async () => {
  await withWorldRoot(async (root) => {
    const previousSandbox = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
    const worldFile = join(root, 'declared-action-world.yaml');
    const scenarioFile = join(root, 'declared-action-scenario.yaml');
    writeFileSync(worldFile, 'world: declared-action-world\ndevices: [fake-clock]\nevents: []\n', { mode: 0o600 });
    const world = await createWorld(worldFile);
    const manifest = {
      apiVersion: 'elanous.app/v0', slug: 'action-demo', title: 'Action demo',
      roles: { owner: { via: 'nexus-session' }, viewer: { via: 'share-link' }, editor: { via: 'share-link' } },
      actions: { summarize: { builtin: 'summarize', uses: ['cred:openai.api_key'], allow: ['viewer'] } },
    };
    const execute = async (as: string) => {
      const step = { action: 'summarize', as, input: { text: 'hello from simulation' } };
      writeFileSync(scenarioFile, stringifyYaml({ world: world.id, steps: [step], appSimulation: {
        manifest, scenario: { name: `summarize-as-${as}`, steps: [step], expect: [] },
      } }), { mode: 0o600 });
      return executeWorldScenario(world, scenarioFile);
    };
    try {
      const allowed = await execute('viewer');
      expect(allowed).toMatchObject({ pass: true, appSimulation: { receipts: [{ outcome: 'passed' }] },
        appSimulationEvidence: { events: ['action.summarize.completed'] } });
      const denied = await execute('editor');
      expect(denied).toMatchObject({ pass: false, appSimulation: { receipts: [{ outcome: 'failed', summary: expect.stringContaining('unauthorized') }] },
        appSimulationEvidence: { events: [] } });
      await destroyWorld(world);
    } finally {
      if (previousSandbox === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
      else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previousSandbox;
    }
  });
});

test('YAML world lifecycle refuses an unmarked format-1 world even when it has a world.yaml config', async () => {
  await withWorldRoot(async (root) => {
    const stored = createSimWorld('ordinary-world');
    const unrelatedConfig = '{"world":"ordinary-world","seed":0,"devices":[],"events":[]}\n';
    writeFileSync(join(stored.configDir, 'world.yaml'), unrelatedConfig, { mode: 0o600 });

    expect(() => loadWorld(stored.id)).toThrow('not a YAML declaration');
    await expect(destroyWorldById(stored.id)).rejects.toThrow('not a YAML declaration');
    expect(readFileSync(join(stored.configDir, 'world.yaml'), 'utf8')).toBe(unrelatedConfig);
    expect(existsSync(stored.rootDir)).toBe(true);
    expect(existsSync(root)).toBe(true);
  });
});

test('create and load reject a sim symlink whose relative path is exactly the test-root parent', async () => {
  await withWorldRoot(async (root) => {
    symlinkSync(dirname(root), join(root, 'sim'), 'dir');
    await expect(createWorld(worldPath)).rejects.toThrow('sim directory escaped the test universe');
    expect(() => loadWorld('night-train')).toThrow('sim world storage escaped the test universe');
  });
});

test('world assembly resolves devices by catalog id and rejects unknown device names', async () => {
  await withWorldRoot(async () => {
    const world = await createWorld(worldPath);
    const assembled = assembleWorld({ ...world, spec: { ...world.spec,
      devices: ['fake-kubectl', 'fake-gh', 'fake-llm', 'fake-clock', 'mail'] } });
    expect([...assembled.devices.keys()]).toEqual(['fake-kubectl:node-b', 'fake-kubectl:gcp2', 'fake-gh', 'fake-llm', 'fake-clock', 'mail']);
    const kubectl = assembled.devices.get('fake-kubectl:node-b') as { kubectl(args: string[]): { status: number } };
    expect(kubectl.kubectl(['config', 'get-contexts', 'night-train-node-b-context']).status).toBe(0);
    expect((assembled.devices.get('fake-gh') as { prs: unknown[] }).prs).toHaveLength(2);
    expect(await (assembled.devices.get('fake-llm') as { response(): Promise<string> }).response()).toContain('test-fake-llm');
    const clock = assembled.devices.get('fake-clock') as { withClock: typeof withSimClock };
    expect(await clock.withClock(new Date('2100-01-01T00:00:00.000Z'), (simClock) => simClock.now())).toBe(Date.parse('2100-01-01T00:00:00.000Z'));
    const mail = assembled.devices.get('mail') as SimMailbox;
    const messageId = mail.post({ from: 'TC', to: 'OP', kind: 'report', body: 'gate stopped' });
    expect(mail.list('OP')).toEqual([{ from: 'TC', to: 'OP', kind: 'report', body: 'gate stopped', acked: false }]);
    mail.ack('OP', messageId);
    expect(mail.list('OP')[0]?.acked).toBe(true);
    expect(() => assembleWorld({ ...world, spec: { ...world.spec, devices: ['made-up-device'] } })).toThrow('unknown mock device');
    await destroyWorld(world);
  });
});

test('SIM-LOAD-RUNNER open model plans arrivals in advance and reports dropped work at maxInFlight', async () => {
  const parsed = parseSimLoadConfig({
    model: 'open', maxInFlight: 2, // Source: #35316
    stages: [{ target: 10, per: '1ms', for: '10ms' }],
  }, [
    { metric: 'arrivals.delivered_ratio', gte: 0.99 },
    { metric: 'step.duration.p50', gte: '5ms' },
  ]);
  const run = () => runSimLoad(parsed.config, parsed.thresholds, 42, () => ({ status: 200, durationMs: 5 }));
  const result = await run();
  expect(result).toEqual(await run());
  expect(result.planned).toBe(50);
  expect(result.started).toBeLessThan(result.planned);
  expect(result.dropped).toBe(result.planned - result.started);
  expect(result.deliveredRatio).toBeLessThan(1); // Source: #35316
  expect(result.latencyMs.p95).toBe(5);
  expect(result.metrics['step.duration.p50']).toBe(5);
  expect(result.thresholds).toEqual([
    { metric: 'arrivals.delivered_ratio', operator: 'gte', value: 0.99, actual: result.deliveredRatio, passed: false },
    { metric: 'step.duration.p50', operator: 'gte', value: 5, actual: 5, passed: true },
  ]);
  expect(result.pass).toBe(false);
});

test('SIM-LOAD-RUNNER expires high-volume open arrivals with a completion heap', async () => {
  // Source: #35316
  const parsed = parseSimLoadConfig({ model: 'open', maxInFlight: 100_000, stages: [
    { target: 200_000, per: '1ms', for: '1ms' },
  ] }, [{ metric: 'arrivals.delivered_ratio', gte: 1 }]);
  const result = await runSimLoad(parsed.config, parsed.thresholds, 9, () => ({ status: 200, durationMs: 10 }));
  expect(result.planned).toBe(100_000);
  expect(result.started).toBe(100_000);
  expect(result.deliveredRatio).toBe(1);
});

test('SIM-LOAD-RUNNER carries fractional arrival budgets across equivalent stage splits', async () => {
  const thresholds = [{ metric: 'arrivals.delivered_ratio' as const, gte: 0 }];
  const oneStage = parseSimLoadConfig({ model: 'open', stages: [
    { target: 2, per: '2ms', for: '2ms' },
    { target: 2, per: '2ms', for: '2ms' },
  ] }, thresholds);
  const splitStages = parseSimLoadConfig({ model: 'open', stages: [
    { target: 2, per: '2ms', for: '2ms' },
    { target: 2, per: '2ms', for: '1ms' },
    { target: 2, per: '2ms', for: '1ms' },
  ] }, thresholds);
  const run = (parsed: ReturnType<typeof parseSimLoadConfig>) => runSimLoad(parsed.config, parsed.thresholds, 3, () => ({ status: 200, durationMs: 1 }));
  expect((await run(oneStage)).planned).toBe(3);
  expect((await run(splitStages)).planned).toBe(3);
});

test('SIM-LOAD-RUNNER places fractional arrivals on the cumulative rate timeline', async () => {
  const parsed = parseSimLoadConfig({ model: 'open', stages: [
    { target: 1, per: '1ms', for: '1ms' },
    { target: 1, per: '1ms', for: '1ms' },
  ] }, [{ metric: 'arrivals.delivered_ratio', gte: 0 }]);
  const arrivals: number[] = [];
  const result = await runSimLoad(parsed.config, parsed.thresholds, 42, (atMs) => {
    arrivals.push(atMs);
    return { status: 200, durationMs: 1 };
  });
  expect(result.planned).toBe(1);
  expect(arrivals).toHaveLength(1);
  expect(arrivals[0]).toBeLessThan(1); // Source: #35316; seed 42 puts the fractional arrival in the first segment.
});

test('SIM-LOAD-RUNNER inverts a very slow open arrival ramp instead of treating it as constant', async () => {
  const parsed = parseSimLoadConfig({ model: 'open', stages: [
    { target: 4, per: '1000000000ms', for: '1000000000ms' },
  ] }, [{ metric: 'arrivals.delivered_ratio', gte: 0 }]);
  const arrivals: number[] = [];
  const result = await runSimLoad(parsed.config, parsed.thresholds, 1, (atMs) => {
    arrivals.push(atMs);
    return { status: 200, durationMs: 1 };
  });
  expect(result.planned).toBe(2);
  expect(arrivals).toHaveLength(2);
  expect(arrivals[0]).toBeGreaterThan(200_000_000); // Source: #35316
  expect(arrivals[1]).toBeGreaterThan(750_000_000); // Source: #35316
});

test('SIM-LOAD-RUNNER rejects closed plans whose first request per VU exceeds the iteration bound', () => {
  expect(() => parseSimLoadConfig({
    model: 'closed', serviceTime: '1000000ms',
    stages: [{ target: 100_001, for: '1ms' }],
  }, [{ metric: 'iterations.completed', gte: 0 }])).toThrow('plan exceeds 100000 iterations');
});

test('SIM-LOAD-RUNNER allows a long closed stage when actual requests stay under the iteration bound', async () => {
  const parsed = parseSimLoadConfig({ model: 'closed', serviceTime: '1ms', stages: [{ target: 1, for: '100001ms' }] }, [
    { metric: 'iterations.completed', gte: 2 },
  ]);
  let calls = 0;
  const result = await runSimLoad(parsed.config, parsed.thresholds, 1, () => {
    calls += 1;
    return { status: 200, durationMs: 100000 };
  });
  expect(calls).toBe(2);
  expect(result.completed).toBe(2);
});

test('SIM-LOAD-RUNNER bounds the closed VU set by its peak across stages', () => {
  const parsed = parseSimLoadConfig({ model: 'closed', stages: [
    { target: 100_000, for: '1ms' },
    { target: 100_000, for: '1ms' },
  ] }, [{ metric: 'iterations.completed', gte: 0 }]);
  expect(parsed.config.stages).toHaveLength(2);
});

test('SIM-LOAD-RUNNER reuses closed VUs across stages after the actual completion time', async () => {
  const parsed = parseSimLoadConfig({ model: 'closed', stages: [
    { target: 1, for: '10ms' },
    { target: 1, for: '10ms' },
  ] }, [{ metric: 'iterations.completed', gte: 2 }]);
  const at: number[] = [];
  const result = await runSimLoad(parsed.config, parsed.thresholds, 1, (plannedAtMs) => {
    at.push(plannedAtMs);
    return { status: 200, durationMs: 15 };
  });
  expect(at).toEqual([0, 15]);
  expect(result.completed).toBe(2);
});

test('SIM-LOAD-RUNNER completes exactly 100,000 closed first requests', async () => {
  const parsed = parseSimLoadConfig({ model: 'closed', stages: [{ target: 100_000, for: '1ms' }] }, [
    { metric: 'iterations.completed', gte: 100_000 },
  ]);
  let calls = 0;
  const result = await runSimLoad(parsed.config, parsed.thresholds, 1, () => {
    calls += 1;
    return { status: 200, durationMs: 1 };
  });
  expect(calls).toBe(100_000);
  expect(result.completed).toBe(100_000);
});

test('SIM-LOAD-RUNNER schedules 100,000 VUs across many long-request stages without expanding stage by VU', async () => {
  const parsed = parseSimLoadConfig({ model: 'closed', stages: Array.from({ length: 100_000 }, () => ({ target: 100_000, for: '1ms' })) }, [
    { metric: 'iterations.completed', gte: 100_000 },
  ]);
  let calls = 0;
  const result = await runSimLoad(parsed.config, parsed.thresholds, 1, () => {
    calls += 1;
    return { status: 200, durationMs: 200_000 };
  });
  expect(calls).toBe(100_000);
  expect(result.completed).toBe(100_000);
});

test('SIM-LOAD-RUNNER enforces the actual closed iteration bound during execution', async () => {
  const parsed = parseSimLoadConfig({ model: 'closed', stages: [{ target: 1, for: '100001ms' }] }, [
    { metric: 'iterations.completed', gte: 0 },
  ]);
  let calls = 0;
  await expect(runSimLoad(parsed.config, parsed.thresholds, 1, () => {
    calls += 1;
    return { status: 200, durationMs: 1 };
  })).rejects.toThrow('plan exceeds 100000 iterations');
  expect(calls).toBe(100_000);
});

test('SIM-LOAD-RUNNER closed model repeats virtual users and applies error-rate thresholds', async () => {
  const parsed = parseSimLoadConfig({
    model: 'closed', thinkTime: '1ms',
    stages: [{ target: 2, for: '10ms' }],
  }, [
    { metric: 'iterations.completed', gte: 8 },
    { metric: 'vus.active', lte: 2 },
    { metric: 'errors.rate', lt: 0.5 },
  ]);
  let calls = 0;
  const result = await runSimLoad(parsed.config, parsed.thresholds, 7, () => ({
    status: ++calls % 3 === 0 ? 503 : 200,
    durationMs: 2,
  }));
  expect(result.model).toBe('closed');
  expect(result.planned).toBe(result.completed);
  expect(result.completed).toBe(8);
  expect(result.activePeak).toBe(2);
  expect(result.errors).toBeGreaterThan(0); // Source: #35316
  expect(result.metrics['arrivals.delivered_ratio']).toBeNull();
  expect(result.pass).toBe(true);
});

test('SIM-LOAD-RUNNER closed model waits for actual request completion before reusing a VU', async () => {
  const parsed = parseSimLoadConfig({ model: 'closed', serviceTime: '1ms', stages: [{ target: 2, for: '10ms' }] }, [
    { metric: 'iterations.completed', gte: 2 },
  ]);
  let calls = 0;
  const result = await runSimLoad(parsed.config, parsed.thresholds, 1, () => {
    calls += 1;
    return { status: 200, durationMs: 100 };
  });
  expect(calls).toBe(2);
  expect(result.planned).toBe(2);
  expect(result.completed).toBe(2);
});

test('SIM-LOAD-RUNNER closed model can pause at zero VUs and reuse users after resuming', async () => {
  // Source: #35316; a zero-target stage is a pause between load periods.
  const parsed = parseSimLoadConfig({ model: 'closed', stages: [
    { target: 2, for: '2ms' },
    { target: 0, for: '2ms' },
    { target: 2, for: '2ms' },
  ] }, [{ metric: 'iterations.completed', gte: 8 }]);
  const requests: Array<{ atMs: number; vu: number | undefined }> = [];
  const result = await runSimLoad(parsed.config, parsed.thresholds, 11, (atMs, vu) => {
    requests.push({ atMs, vu });
    return { status: 200, durationMs: 1 };
  });
  expect(result.completed).toBe(8);
  expect(result.activePeak).toBe(2);
  expect(result.pass).toBe(true);
  expect(requests.filter((request) => request.atMs < 2).map((request) => request.vu)).toEqual([0, 1, 0, 1]);
  expect(requests.filter((request) => request.atMs >= 4).map((request) => request.vu)).toEqual([0, 1, 0, 1]);
  expect(requests.some((request) => request.atMs >= 2 && request.atMs < 4)).toBe(false);
});

test('SIM-LOAD-RUNNER executes arrivals with app changes on the shared fake-clock timeline', async () => {
  await withWorldRoot(async (root) => {
    const worldFile = join(root, 'load-world.yaml');
    const scenarioFile = join(root, 'load-scenario.yaml');
    writeFileSync(worldFile, [
      'world: load-world',
      'seed: 42',
      'clock: { start: "2026-11-01T00:00:00Z", speed: 1 }',
      'apps:',
      '  - slug: demo',
      '    versions:',
      '      - id: v1',
      '        files: { "/legacy.html": "legacy", "/index.html": "hello" }',
      '      - id: v2',
      '        files: { "/alternate.html": "alternate", "/index.html": "updated" }',
      '    current: v1',
      'events:',
      '  - { at: "+5ms", id: EV-0042, appAction: deploy, slug: demo, version: v2 }',
      '  - { at: "+15ms", id: EV-0042, appAction: rollback, slug: demo }',
      '',
    ].join('\n'));
    writeFileSync(scenarioFile, [
      'world: load-world',
      'load:',
      '  model: open',
      '  maxInFlight: 50',
      '  stages:',
      '    - { target: 10, per: 1ms, for: 10ms }',
      '  serviceTime: 100ms',
      'thresholds:',
      '  - { metric: arrivals.delivered_ratio, gte: 0 }',
      '  - { metric: step.duration.p50, lte: 100ms }',
      'steps:',
      '  - observe: app-host',
      '',
    ].join('\n'));
    const world = await createWorld(worldFile);
    try {
      const result = await runWorldScenario(world, scenarioFile);
      expect(result.pass).toBe(true);
      expect(result.load).toMatchObject({ model: 'open', planned: 50 });
      expect(result.load?.started).toBe(50);
      expect(result.load?.dropped).toBe(0);
      expect(result.load?.errors).toBe(0);
      expect(result.load?.completed).toBe(result.load?.started);
      expect(result.load?.latencyMs.p50).toBe(100);
      expect(result.load?.pass).toBe(true);
      expect(result.load?.metrics['arrivals.delivered_ratio']).toBe(1);
      expect(result.observations.some((row) => row.event === 'app-deploy-demo')).toBe(true);
      expect(result.observations.find((row) => row.event === 'app-deploy-demo')?.verdict).toStartWith('v2 ');
      expect(result.observations.find((row) => row.event === 'sim-load-app-versions')?.verdict).toBe('v1,v2');
      expect(result.recovery?.timeline).toContainEqual({ atMs: 5, kind: 'world-event', target: 'deploy:demo' });
      expect(result.recovery?.timeline).toContainEqual({ atMs: 15, kind: 'world-event', target: 'rollback:demo' });
      const clockAtEndMs = Number(result.observations.find((row) => row.event === 'sim-load')?.verdict.match(/clockAtEndMs=(\d+)/)?.[1]);
      expect(clockAtEndMs).toBeGreaterThan(100); // Source: #35316; requests launched during a 10ms stage complete after 100ms.
      const failingScenarioFile = join(root, 'load-scenario-p50-fail.yaml');
      writeFileSync(failingScenarioFile, [
        'world: load-world',
        'load: { model: open, maxInFlight: 50, serviceTime: 100ms, stages: [{ target: 10, per: 1ms, for: 10ms }] }',
        'thresholds: [{ metric: step.duration.p50, lt: 99ms }]',
        'steps: [{ observe: app-host }]',
        '',
      ].join('\n'));
      const failingResult = await runWorldScenario(world, failingScenarioFile);
      expect(failingResult.load?.latencyMs.p50).toBe(100);
      expect(failingResult.load?.pass).toBe(false);
    } finally {
      await destroyWorld(world);
    }
  });
});

test('SIM-LOAD-RUNNER observes APP-TRAFFIC-CAP through a real world load scenario', async () => {
  // Source: PR #36300 APP-TRAFFIC-CAP; scaled fixture limits and per-request bytes make the boundary deterministic.
  await withWorldRoot(async (root) => {
    const worldPath = join(root, 'traffic-cap-world.yaml');
    const scenarioPath = join(root, 'traffic-cap-scenario.yaml');
    writeFileSync(worldPath, [
      'world: traffic-cap-world',
      'seed: 42',
      'clock: { start: "2026-11-10T00:00:00Z", speed: 1 }',
      'apps:',
      '  - slug: demo',
      '    current: v1',
      '    versions: [{ id: v1, files: { "/index.html": "hello" } }]',
      '',
    ].join('\n'));
    writeFileSync(scenarioPath, [
      'world: traffic-cap-world',
      'load:',
      '  model: open',
      '  maxInFlight: 3', // Source: #36300
      '  serviceTime: 1ms',
      '  trafficCap:',
      '    memberId: member-a',
      '    connectionId: connection-a',
      '    bytesPerRequest: 3',
      '    caps: { free: { memberBytesPerMinute: 10, connectionBytesPerMinute: 6 } }',
      '  stages: [{ target: 1, per: 1ms, for: 6ms }]',
      'thresholds: [{ metric: errors.rate, gt: 0 }, { metric: arrivals.delivered_ratio, gte: 1 }]',
      'steps: [{ observe: app-host }]',
      '',
    ].join('\n'));
    const world = await createWorld(worldPath);
    try {
      const result = await runWorldScenario(world, scenarioPath);
      expect(result).toMatchObject({ pass: true, load: { planned: 3, started: 3, errors: 1, deliveredRatio: 1 } });
      expect(result.observations.find((row) => row.event === 'sim-load-traffic-cap')?.verdict).toBe('200,200,429');
    } finally {
      await destroyWorld(world);
    }
  });
});

test('world rejects outbound fetch before the original network function is called', async () => {
  await withWorldRoot(async () => {
    const world = await createWorld(worldPath);
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response('unexpected'); }) as unknown as typeof fetch;
    try {
      await expect(runInWorld(world, () => fetch('https://example.invalid'))).rejects.toThrow('sim network blocked');
      await expect(runInWorld(world, async () => { net.connect({ host: 'example.invalid', port: 443 }); })).rejects.toThrow('sim network blocked');
      await expect(runInWorld(world, async () => { http.request('http://example.invalid'); })).rejects.toThrow('sim network blocked');
      await expect(runInWorld(world, async () => { https.get('https://example.invalid'); })).rejects.toThrow('sim network blocked');
      await expect(runInWorld(world, async () => { tls.connect({ host: 'example.invalid', port: 443 }); })).rejects.toThrow('sim network blocked');
      await expect(runInWorld(world, async () => { dgram.createSocket('udp4', () => {}); })).rejects.toThrow('sim network blocked');
      await expect(runInWorld(world, async () => { dns.lookup('example.invalid', {}, () => {}); })).rejects.toThrow('sim network blocked');
      await expect(runInWorld(world, async () => { childProcess.spawn('curl', ['https://example.invalid']); })).rejects.toThrow('sim network blocked');
      await expect(runInWorld(world, async () => { childProcess.spawnSync('curl', ['https://example.invalid']); })).rejects.toThrow('sim network blocked');
      await expect(runInWorld(world, async () => { Bun.spawnSync(['curl', 'https://example.invalid']); })).rejects.toThrow('sim network blocked');
      await expect(runInWorld(world, async () => { http.createServer(); })).rejects.toThrow('sim network blocked');
      await expect(runInWorld(world, async () => { http.request('http://localhost', { hostname: 'example.invalid' }); })).rejects.toThrow('sim network blocked');
      expect(calls).toBe(0);
      expect(world.networkEvents).toEqual([
        { url: 'https://example.invalid/', blocked: true },
        { url: 'tcp://example.invalid', blocked: true },
        { url: 'http://example.invalid/', blocked: true },
        { url: 'https://example.invalid/', blocked: true },
        { url: 'tls://example.invalid', blocked: true },
        { url: 'udp://socket', blocked: true },
        { url: 'dns://example.invalid', blocked: true },
        { url: 'process://curl', blocked: true },
        { url: 'process://curl', blocked: true },
        { url: 'process://curl', blocked: true },
        { url: 'listen://http', blocked: true },
        { url: 'http://example.invalid', blocked: true },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      await destroyWorld(world);
    }
  });
});

test('world promotion runner rejects marker-only Python before executing it', async () => {
  await withWorldRoot(async () => {
    const world = await createWorld(worldPath);
    const marker = join(world.root, 'escaped-marker');
    await expect(runInWorld(world, async (runtime) => {
      mkdirSync(join(world.root, 'promotion-home'), { recursive: true });
      runtime.runPromotionPython(`# shutil.copy2\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")`,
        join(world.root, 'promotion-home'), {});
    })).rejects.toThrow('world runner refused untrusted promotion Python body');
    expect(existsSync(marker)).toBe(false);
    await destroyWorld(world);
  });
});

test('scenario executor refuses a supplied world root outside the explicit test universe', async () => {
  await withWorldRoot(async () => {
    const world = await createWorld(worldPath);
    const outside = mkdtempSync(join(tmpdir(), 'sim-world-outside-root-'));
    const previous = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
    try {
      await expect(executeWorldScenario({ ...world, root: outside }, scenarioPath))
        .rejects.toThrow('world root is not owned by the test universe');
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
      else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previous;
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('night-train executes the real readiness path twice under the declared fake clock', async () => {
  await withWorldRoot(async () => {
    const world = await createWorld(worldPath);
    const previous = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
    try {
      const first = await executeWorldScenario(world, scenarioPath);
      const second = await executeWorldScenario(world, scenarioPath);
      expect(first.pass).toBe(true);
      expect(first.recovery).toBeUndefined();
      expect(first.observations).toEqual([
        { event: 'live-pid-lock', verdict: 'already-running' },
        { event: 'dead-pid-lock', verdict: 'ready' },
      ]);
      expect(second).toEqual(first);
      expect(first.devices).toEqual(['fake-kubectl:node-b', 'fake-kubectl:gcp2', 'fake-llm', 'fake-gh', 'fake-clock', 'mail']);
      expect(readdirSync(world.root).filter((name) => name.startsWith('.run-'))).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
      else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previous;
      await destroyWorld(world);
    }
  });
});

test('HQ move world executes the production host-transfer path with simulated remote boundaries', async () => {
  await withWorldRoot(async () => {
    const world = await createWorld(hqMoveWorldPath);
    const previous = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
    try {
      const result = await executeWorldScenario(world, hqMoveScenarioPath);
      expect(result.pass, JSON.stringify(result)).toBe(true);
      expect(result.observations).toEqual(expect.arrayContaining([
        { event: 'transfer', verdict: 'complete' },
        { event: 'state-copy', verdict: 'verified:ledger=2,worktree=1,mail=1' },
        { event: 'lease', verdict: 'MacStudioB1@8' },
        { event: 'source-fence', verdict: 'retired' },
        { event: 'target-fence', verdict: 'allowed' },
        { event: 'pool-reallocation', verdict: 'node-b' },
        { event: 'fake-ssh-configured-hosts', verdict: 'mbp,node-b' },
        { event: 'world-clock', verdict: '2026-11-08T21:01:00.000Z' },
      ]));
      expect(result.devices).toEqual(expect.arrayContaining(['fake-ssh:mbp', 'fake-ssh:node-b', 'fake-clock']));
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
      else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previous;
      await destroyWorld(world);
    }
  });
});

test('world.yaml disaster hands off its explicitly designated headquarters process through the runtime', async () => {
  await withWorldRoot(async (root) => {
    const disasterWorldPath = join(root, 'disaster-handoff-world.yaml');
    writeFileSync(disasterWorldPath, `world: disaster-handoff
seed: 19
clock: { start: "2026-11-05T00:00:00Z", speed: 60 }
hosts:
  - { name: node-b, arch: arm64, cpu: 32, pools: [gate], egress: true }
  - { name: gcp2, arch: amd64, cpu: 8, pools: [gate], egress: true }
processes:
  - { id: background, host: node-b, releaseVersion: '0.3.5', fingerprint: fp_hq_background, lane: hand, mission: background-work }
  - { id: headquarters, host: node-b, releaseVersion: '0.3.5', role: headquarters, fingerprint: fp_hq_headquarters, lane: hand, mission: hq-handoff }
devices: [fake-clock]
events:
  - { at: '+10m', id: EV-0042 }
chaos:
  - { at: '+1m', disaster: { host: node-b, down: true } }
expect:
  recovers: { within: '+1s', hitl: 0, lostLedger: 0 }
`);
    const world = await createWorld(disasterWorldPath);
    const priorLease = beginResourceLease({ fp: 'fp_hq_headquarters', host: 'node-b', lane: 'hand',
      resources: { cpu: 2, memoryBytes: 8_192 }, mission: { goalId: 'hq-handoff' }, ttlMs: 300_000,
      now: new Date('2026-11-05T00:00:00.000Z') }, join(world.root, 'resource-ledger', 'events.jsonl'));
    const scenario = join(root, 'disaster-handoff-scenario.yaml');
    writeFileSync(scenario, `world: disaster-handoff
steps:
  - inject: { id: EV-0042, version: '0.3.5' }
  - observe: release-readiness
expect:
  livePidLock: { ready: false, reason: already-running }
  deadPidLock: { ready: true, reason: ready }
`);
    const previous = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
    try {
      const result = await executeWorldScenario(world, scenario);
      expect(receiptFromWorld(result).steps.find((step) => step.id === 'chaos-disaster')).toMatchObject({
        invariant: 'pass', durationMs: 1_000,
      });
      const suiteRoot = join(root, 'regression-suite');
      const caseRoot = join(suiteRoot, 'handoff');
      mkdirSync(caseRoot, { recursive: true });
      writeFileSync(join(suiteRoot, 'suite.json'), JSON.stringify({ durationTolerancePercent: 10 }));
      writeFileSync(join(caseRoot, 'world.yaml'), readFileSync(disasterWorldPath));
      writeFileSync(join(caseRoot, 'scenario.yaml'), readFileSync(scenario));
      const initialReceipt = receiptFromWorld(result);
      await runWorldRegressionSuite({ folder: suiteRoot, target: 'sim', updateBaseline: true, run: async () => initialReceipt });
      const changedTime = (durationMs: number) => receiptFromWorld({ ...result,
        observations: result.observations.map((observation) => observation.event === 'chaos-disaster'
          ? { ...observation, durationMs, verdict: observation.verdict.replace(/\(\d+ms\)$/, `(${durationMs}ms)`) }
          : observation),
        recovery: { ...result.recovery!, observations: result.recovery!.observations.map((observation) => ({ ...observation,
          recoveryMs: durationMs })) },
      });
      // Source: the suite declares 10% tolerance around the observed one-second disaster recovery.
      const within = await runWorldRegressionSuite({ folder: suiteRoot, target: 'sim', run: async () => changedTime(1_050) });
      const outside = await runWorldRegressionSuite({ folder: suiteRoot, target: 'sim', run: async () => changedTime(1_200) });
      expect(within).toMatchObject({ pass: true, differences: [] });
      expect(outside.differences.map((difference) => difference.field)).toEqual(['chaos-disaster.durationMs']);
      expect(result.recovery?.observations).toMatchObject([{ kind: 'disaster', faultAtMs: 60_000,
        recoveredAtMs: 61_000, recoveryMs: 1_000,
        recoveryVerdict: 'headquarters handoff to gcp2; handoff leases=1 findings=0',
        metrics: { hitlCount: 0, lostLedgerRows: 0 } }]);
      expect(result.recovery?.timeline).toContainEqual({ atMs: 61_000, kind: 'fault-recovery', target: 'node-b' });
      expect(result.recovery?.evaluation).toMatchObject({ pass: true, failures: [], unmeasured: [] });
      expect(activeResourceLeases(readResourceLedger(join(world.root, 'resource-ledger', 'events.jsonl'))))
        .toMatchObject([{ id: priorLease.id, fp: 'fp_hq_headquarters', host: 'gcp2', lane: 'hand',
          resources: { cpu: 2, memoryBytes: 8_192 }, mission: { goalId: 'hq-handoff' }, ttlMs: 300_000 }]);
      const ledgerAfterHandoff = readResourceLedger(join(world.root, 'resource-ledger', 'events.jsonl'));
      await expect(executeWorldScenario(world, scenario)).rejects.toThrow('matching active lease');
      expect(readResourceLedger(join(world.root, 'resource-ledger', 'events.jsonl'))).toEqual(ledgerAfterHandoff);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
      else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previous;
      await destroyWorld(world);
    }
  });
});

test('HQ move world fails visibly when its declared fake SSH target is changed', async () => {
  await withWorldRoot(async (root) => {
    const changedWorldPath = join(root, 'sim-hq-move-world-changed.yaml');
    writeFileSync(changedWorldPath, readFileSync(hqMoveWorldPath, 'utf8').replace('name: node-b', 'name: studio'));
    const world = await createWorld(changedWorldPath);
    const previous = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
    try {
      const result = await executeWorldScenario(world, hqMoveScenarioPath);
      expect(result.pass).toBe(false);
      expect(result.observations.find(row => row.event === 'transfer')?.verdict).not.toBe('complete');
      expect(result.observations.find(row => row.event === 'fake-ssh-configured-hosts')?.verdict).toBe('mbp');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
      else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previous;
      await destroyWorld(world);
    }
  });
});

test('scenario executor rejects traversal versions and missing or misordered observations before creating run files', async () => {
  await withWorldRoot(async (root) => {
    const world = await createWorld(worldPath);
    const source = readFileSync(scenarioPath, 'utf8');
    const badVersion = join(root, 'bad-version.yaml');
    const badSteps = join(root, 'bad-steps.yaml');
    writeFileSync(badVersion, source.replace('version: 0.2.45', 'version: ../../escape'));
    writeFileSync(badSteps, source.replace('  - observe: release-readiness\n', ''));
    const previous = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
    try {
      await expect(executeWorldScenario(world, badVersion)).rejects.toThrow('invalid release version');
      await expect(executeWorldScenario(world, badSteps)).rejects.toThrow('scenario steps must be inject followed');
      expect(readdirSync(world.root).filter((name) => name.startsWith('.run-'))).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
      else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previous;
      await destroyWorld(world);
    }
  });
});

test.skipIf(process.platform !== 'darwin')('world CLI sandbox denies network access at the operating-system boundary', () => {
  const result = spawnSync('/usr/bin/sandbox-exec', [
    '-p', '(version 1)(allow default)(deny network*)', process.execPath, '-e',
    "fetch('https://example.com').then(() => { console.log('OPEN'); process.exit(3); }).catch(() => console.log('BLOCKED'))",
  ], { encoding: 'utf8', timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('BLOCKED');
});

test.skipIf(process.platform !== 'linux')('Linux network-zero worlds block external requests and record zero world network events', async () => {
  await withWorldRoot(async () => {
    const world = await createWorld(worldPath);
    try {
      expect(await verifyWorldNetworkIsolation(world, scenarioPath)).toBe(true);
      expect((await runWorldScenario(world, scenarioPath)).pass).toBe(true);
      expect(world.networkEvents).toEqual([]);
    } finally { await destroyWorld(world); }
  });
});


test.skipIf(process.platform !== 'linux' || !usableBwrap)('Linux bwrap fallback executes the world runner with zero external calls', async () => {
  await withWorldRoot(async () => {
    const world = await createWorld(worldPath);
    try {
      const sandboxBin = join(world.root, 'sandbox-bin');
      mkdirSync(sandboxBin);
      symlinkSync(usableBwrap!, join(sandboxBin, 'bwrap'));
      await withPath(sandboxBin, async () => {
        expect(await verifyWorldNetworkIsolation(world, scenarioPath)).toBe(true);
        expect((await runWorldScenario(world, scenarioPath)).pass).toBe(true);
      });
      expect(world.networkEvents).toEqual([]);
    } finally { await destroyWorld(world); }
  });
});

test.skipIf(process.platform !== 'linux')('Linux refuses to run a world when neither network sandbox command is on PATH', async () => {
  await withWorldRoot(async (root) => {
    const world = await createWorld(worldPath);
    try {
      await withPath(root, async () => {
        await expect(runWorldScenario(world, scenarioPath)).rejects.toThrow('requires a usable Linux unshare -rn or bwrap --unshare-net');
      });
    } finally { await destroyWorld(world); }
  });
});

test.skipIf(process.platform !== 'darwin')('night-train injects a dead-pid run lock through releaseReadiness and records the observed verdict', async () => {
  await withWorldRoot(async () => {
    const world = await createWorld(worldPath);
    try {
      expect(await verifyWorldNetworkIsolation(world, scenarioPath)).toBe(true);
      const result = await runWorldScenario(world, scenarioPath);
      expect(result.pass).toBe(true);
      expect(result.observations).toEqual([
        { event: 'live-pid-lock', verdict: 'already-running' },
        { event: 'dead-pid-lock', verdict: 'ready' },
      ]);
      const observed = readSimWorldWatchEvents(world);
      expect(observed.events.map(({ event, verdict }) => ({ event, verdict }))).toEqual(result.observations);
      expect(observed.events.every((row) => row.runId.startsWith('run-'))).toBe(true);
      expect(observed.events.map((row) => row.sequence)).toEqual([1, 2]);
      expect(result.devices).toEqual(['fake-kubectl:node-b', 'fake-kubectl:gcp2', 'fake-llm', 'fake-gh', 'fake-clock', 'mail']);
      expect(world.networkEvents).toEqual([]);
      expect((await runWorldScenario(world, scenarioPath)).pass).toBe(true);
      expect(readdirSync(world.root).filter((name) => name.startsWith('.run-'))).toHaveLength(2);
    } finally { await destroyWorld(world); }
  });
});

test.skipIf(process.platform !== 'darwin')('a failed device recording turns its declaring sim world yellow', async () => {
  await withWorldRoot(async () => {
    const world = await createWorld(worldPath);
    try {
      const comparison = compareDeviceRecording({
        version: 1,
        id: 'night-train-github-open-prs',
        deviceId: 'fake-github',
        repository: 'fixture-small',
        recordedAt: '2026-11-04T10:00:00.000Z',
        prs: [],
        calls: [{ args: ['api', '/repos/fixture-small/pulls?state=open'], realResponse: '[{"recorded":true}]' }],
      });
      expect(comparison.passed).toBe(false);
      const result = await runWorldScenario(world, scenarioPath);
      expect(result).toMatchObject({ pass: false, verdict: 'yellow' });
      expect(result.fidelity).toContainEqual({ deviceId: 'fake-gh', verdict: 'yellow', failedRecordingIds: ['night-train-github-open-prs'] });
    } finally { await destroyWorld(world); }
  });
});

test.skipIf(process.platform !== 'darwin')('scenario rejects traversal versions and missing or misordered observations', async () => {
  await withWorldRoot(async (root) => {
    const world = await createWorld(worldPath);
    const fs = await import('node:fs/promises');
    const temp = await import('node:os').then((os) => os.tmpdir());
    const badVersion = join(temp, `night-train-bad-version-${process.pid}.yaml`);
    const badSteps = join(temp, `night-train-bad-steps-${process.pid}.yaml`);
    const wrongExpectation = join(temp, `night-train-wrong-expectation-${process.pid}.yaml`);
    const source = await fs.readFile(scenarioPath, 'utf8');
    try {
      await fs.writeFile(badVersion, source.replace('version: 0.2.45', 'version: ../../escape'));
      await expect(runWorldScenario(world, badVersion)).rejects.toThrow('invalid release version');
      await fs.writeFile(badSteps, source.replace('  - observe: release-readiness\n', ''));
      await expect(runWorldScenario(world, badSteps)).rejects.toThrow('scenario steps must be inject followed');
      await fs.writeFile(wrongExpectation, source.replace('reason: ready', 'reason: not-ready'));
      expect((await runWorldScenario(world, wrongExpectation)).pass).toBe(false);
      expect(existsSync(join(realpathSync(root), 'escape', 'run.lock'))).toBe(false);
    } finally {
      await fs.rm(badVersion, { force: true });
      await fs.rm(badSteps, { force: true });
      await fs.rm(wrongExpectation, { force: true });
      await destroyWorld(world);
    }
  });
});

test.skipIf(process.platform !== 'darwin')('scenario run uses a private release root instead of following a world release symlink', async () => {
  await withWorldRoot(async () => {
    const world = await createWorld(worldPath);
    const outside = mkdtempSync(join(tmpdir(), 'sim-world-outside-'));
    try {
      mkdirSync(join(world.root, 'release'), { recursive: true });
      symlinkSync(outside, join(world.root, 'release', '0.2.45'), 'dir');
      expect((await runWorldScenario(world, scenarioPath)).pass).toBe(true);
      expect(existsSync(join(outside, 'run.lock'))).toBe(false);
    } finally {
      await destroyWorld(world);
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test.skipIf(process.platform !== 'darwin')('scenario run does not create release files through a preexisting parent symlink', async () => {
  await withWorldRoot(async () => {
    const world = await createWorld(worldPath);
    const outside = mkdtempSync(join(tmpdir(), 'sim-world-parent-outside-'));
    try {
      symlinkSync(outside, join(world.root, 'release'), 'dir');
      expect((await runWorldScenario(world, scenarioPath)).pass).toBe(true);
      expect(existsSync(join(outside, '0.2.45'))).toBe(false);
    } finally {
      await destroyWorld(world);
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test.skipIf(process.platform !== 'darwin')('sim world CLI creates, runs, and destroys a world in test state only', async () => {
  await withWorldRoot(async (root) => {
    const output: string[] = [];
    const oldLog = console.log;
    const oldError = console.error;
    console.log = (...args: unknown[]) => output.push(args.join(' '));
    console.error = (...args: unknown[]) => output.push(args.join(' '));
    const invoke = async (...args: string[]) => {
      const program = new Command();
      program.exitOverride();
      registerSimCommands(program);
      await program.parseAsync(['sim', 'world', ...args], { from: 'user' });
    };
    try {
      await invoke('create-yaml', worldPath);
      expect(existsSync(join(root, 'sim', 'worlds', 'night-train', 'world.json'))).toBe(true);
      await invoke('run', 'night-train', scenarioPath);
      expect(JSON.parse(output.at(-1)!)).toMatchObject({ pass: true, observations: [
        { event: 'live-pid-lock', verdict: 'already-running' },
        { event: 'dead-pid-lock', verdict: 'ready' },
      ] });
      await invoke('destroy-yaml', 'night-train');
      expect(existsSync(join(root, 'sim', 'worlds', 'night-train'))).toBe(false);
    } finally {
      console.log = oldLog;
      console.error = oldError;
      rmSync(join(root, 'sim'), { recursive: true, force: true });
    }
  });
});

test('world.yaml orders fault and injection rows on one timeline through the production writer', async () => {
  await withWorldRoot(async (root) => {
    const chaosWorldPath = join(root, 'chaos-world.yaml');
    writeFileSync(chaosWorldPath, `world: night-train
seed: 42
clock: { start: "2026-11-01T18:00:00+09:00", speed: 600 }
hosts:
  - { name: node-b, arch: arm64, cpu: 32, pools: [gate], egress: false }
  - { name: gcp2, arch: amd64, cpu: 8, pools: [gate], egress: false }
processes:
  - { id: train-auto-loop, host: gcp2, releaseVersion: '0.2.45' }
providers:
  codex: { accounts: [default:61%] }
devices: [fake-clock]
events:
  - { at: '+5m', id: EV-0042 }
chaos:
  - { at: '+1m', monkey: { kill: 'train-auto-loop host=gcp2', signal: KILL } }
injections:
  - at: '+30s'
    ledger:
      - event: sim-chaos.probe.started
        data: { sample: 1 }
      - event: sim-chaos.probe.finished
        data: { sample: 1 }
    logs:
      - { category: sim-chaos, event: probe-started, data: { sample: 1 } }
  - at: '+60100ms'
    ledger:
      - event: sim-chaos.probe.during-recovery
        data: { sample: 1 }
  - at: '+2m'
    ledger:
      - event: sim-chaos.probe.finished
        data: { sample: 1 }
expect:
  recovers: { within: '+15m', hitl: 0, lostLedger: 0 }
`);
    const world = await createWorld(chaosWorldPath);
    const previous = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
    try {
      const result = await executeWorldScenario(world, scenarioPath);
      const recovery = result.recovery;
      expect(recovery).toBeDefined();
      expect(result.recovery?.observations.map((row) => row.kind)).toEqual(['monkey']);
      expect(result.recovery?.observations.map((row) => row.recoveryMs)).toEqual([250]);
      expect(result.recovery?.observations.map((row) => row.recoveredAtMs)).toEqual([60_250]);
      expect(result.recovery?.aggregate?.metrics.lostLedgerRows).toBe(0);
      const persistedChaosRows = loadRunLedger(recovery!.injections[0]!.runId, runLedgerDir(world.root)) ?? [];
      expect(new Set(persistedChaosRows.map((row) => row.data.injectionRowId)).size).toBe(4);
      expect(persistedChaosRows.map((row) => row.timestamp)).toEqual([
        '2026-11-01T09:00:30.000Z', '2026-11-01T09:00:30.000Z',
        '2026-11-01T09:01:00.100Z', '2026-11-01T09:02:00.000Z',
      ]);
      expect(recovery!.timeline).toEqual([
        { atMs: 30_000, kind: 'injection', target: recovery!.injections[0]?.injectionId },
        { atMs: 60_000, kind: 'fault-start', target: 'train-auto-loop host=gcp2' },
        { atMs: 60_100, kind: 'injection', target: recovery!.injections[1]?.injectionId },
        { atMs: 60_250, kind: 'fault-recovery', target: 'train-auto-loop host=gcp2' },
        { atMs: 120_000, kind: 'injection', target: recovery!.injections[2]?.injectionId },
        { atMs: 300_000, kind: 'world-event', target: 'release:EV-0042' },
      ]);
      expect(result.recovery?.evaluation).toMatchObject({ pass: true, unmeasured: [] });
      expect(result.pass).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
      else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previous;
      await destroyWorld(world);
    }
  });
});

test('world.yaml gorilla recovery uses the declared shared-clock duration and selects another host', async () => {
  await withWorldRoot(async (root) => {
    const chaosWorldPath = join(root, 'gorilla-clock-world.yaml');
    writeFileSync(chaosWorldPath, `world: gorilla-clock
seed: 9
clock: { start: "2026-11-05T00:00:00Z", speed: 60 }
hosts:
  - { name: node-b, arch: arm64, cpu: 32, pools: [gate], egress: true }
  - { name: gcp2, arch: amd64, cpu: 8, pools: [gate], egress: true }
processes:
  - { id: worker-a, host: gcp2, releaseVersion: '0.3.5', fingerprint: declared-a }
  - { id: worker-b, host: gcp2, releaseVersion: '0.3.5', fingerprint: declared-b }
devices: [fake-clock]
events:
  - { at: '+10m', id: EV-0042 }
chaos:
  - { at: '+1m', gorilla: { host: gcp2, egress: false, cpu: 0, for: '+5m' } }
injections:
  - at: '+30s'
    ledger:
      - event: sim-gorilla.probe
        data: { sample: 1 }
expect:
  recovers: { within: '+5m', hitl: 0, lostLedger: 0 }
`);
    const world = await createWorld(chaosWorldPath);
    const chaosScenarioPath = join(root, 'gorilla-clock-scenario.yaml');
    writeFileSync(chaosScenarioPath, `world: gorilla-clock
steps:
  - inject: { id: EV-0042, version: '0.3.5' }
  - observe: release-readiness
expect:
  livePidLock: { ready: false, reason: already-running }
  deadPidLock: { ready: true, reason: ready }
`);
    const previous = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
    try {
      const result = await executeWorldScenario(world, chaosScenarioPath);
      expect(result.recovery?.observations).toMatchObject([{ kind: 'gorilla', faultAtMs: 60_000,
        recoveredAtMs: 360_000, recoveryMs: 300_000, recoveryVerdict: expect.stringContaining('surviving host node-b'),
        metrics: { hitlCount: 0 } }]);
      expect(result.recovery?.timeline).toContainEqual({ atMs: 360_000, kind: 'fault-recovery', target: 'gcp2' });
      expect(result.recovery?.evaluation).toMatchObject({ pass: true, failures: [], unmeasured: [] });
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
      else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previous;
      await destroyWorld(world);
    }
  });
});

test('world.yaml runs declared injections when there is no chaos block', async () => {
  await withWorldRoot(async (root) => {
    const injectionWorldPath = join(root, 'injection-only-world.yaml');
    writeFileSync(injectionWorldPath, `world: night-train
seed: 7
devices: [fake-clock]
events:
  - { at: '+5m', id: EV-0042 }
injections:
  - at: '+1m'
    ledger:
      - event: sim-injection-only.completed
        data: { source: world-yaml }
`);
    const world = await createWorld(injectionWorldPath);
    const previous = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
    try {
      const result = await executeWorldScenario(world, scenarioPath);
      const receipt = result.recovery?.injections[0];
      const injectionId = receipt?.injectionId ?? 'missing-injection-id';
      expect(result.recovery?.timeline ?? []).toEqual([
        { atMs: 60_000, kind: 'injection', target: injectionId },
        { atMs: 300_000, kind: 'world-event', target: 'release:EV-0042' },
      ]);
      expect(receipt?.ledgerRows).toBe(1);
      expect(loadRunLedger(receipt!.runId, runLedgerDir(world.root))?.map((row) => row.event)).toEqual(['sim-injection-only.completed']);
      expect(loadRunLedger(receipt!.runId, runLedgerDir(world.root))?.[0]?.data.injectionRowId).toBe(`${receipt!.injectionId}:0`);
      expect(result.pass).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
      else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previous;
      await destroyWorld(world);
    }
  });
});

test.skipIf(process.platform !== 'darwin')('coverage receipt failure fails the completed world run instead of returning success', async () => {
  await withWorldRoot(async (root) => {
    const world = await createWorld(worldPath);
    const outside = mkdtempSync(join(tmpdir(), 'sim-world-coverage-outside-'));
    symlinkSync(outside, join(root, 'sim', 'coverage'));
    try {
      await expect(runWorldScenario(world, scenarioPath)).rejects.toThrow('sim coverage storage escaped the explicit test universe');
    } finally {
      await destroyWorld(world);
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
