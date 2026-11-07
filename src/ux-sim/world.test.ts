import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { registerSimCommands } from '../cli/sim-cli.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { withSimClock } from './fake-clock.js';
import { compareDeviceRecording } from './device-fidelity.js';
import { createSimWorld } from './world-store.js';
import { assembleWorld, createWorld, destroyWorld, destroyWorldById, executeWorldScenario, loadWorld, runInWorld, runWorldScenario, verifyWorldNetworkIsolation, type SimMailbox } from './world.js';
import { loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';
import { activeResourceLeases, readResourceLedger } from '../resource-ledger/resource-ledger.js';
import { readSimWorldWatchEvents } from './world-watch.js';

const scenarioPath = join(import.meta.dir, '../../scenarios/ux-sim/night-train-dead-pid-lock.yaml');
const worldPath = join(import.meta.dir, '../../scenarios/ux-sim/night-train-world.yaml');
const hqMoveScenarioPath = join(import.meta.dir, '../../scenarios/ux-sim/sim-hq-move.yaml');
const hqMoveWorldPath = join(import.meta.dir, '../../scenarios/ux-sim/sim-hq-move-world.yaml');

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
    expect((assembled.devices.get('fake-llm') as { response(): string }).response()).toContain('test-fake-llm');
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
