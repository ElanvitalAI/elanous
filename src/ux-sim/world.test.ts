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
import { assembleWorld, createWorld, destroyWorld, executeWorldScenario, loadWorld, runInWorld, runWorldScenario, verifyWorldNetworkIsolation, type SimMailbox } from './world.js';

const scenarioPath = join(import.meta.dir, '../../scenarios/ux-sim/night-train-dead-pid-lock.yaml');
const worldPath = join(import.meta.dir, '../../scenarios/ux-sim/night-train-world.yaml');

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
    expect(world.root).toBe(join(realpathSync(root), 'sim', 'night-train'));
    expect(existsSync(world.root)).toBe(true);
    expect(statSync(world.root).mode & 0o777).toBe(0o700);
    await destroyWorld(world);
    expect(existsSync(world.root)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });
});

test('create and load reject a sim symlink whose relative path is exactly the test-root parent', async () => {
  await withWorldRoot(async (root) => {
    symlinkSync(dirname(root), join(root, 'sim'), 'dir');
    await expect(createWorld(worldPath)).rejects.toThrow('sim directory escaped the test universe');
    expect(() => loadWorld('night-train')).toThrow('sim directory escaped the test universe');
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
      expect(result.devices).toEqual(['fake-kubectl:node-b', 'fake-kubectl:gcp2', 'fake-llm', 'fake-gh', 'fake-clock', 'mail']);
      expect(world.networkEvents).toEqual([]);
      expect((await runWorldScenario(world, scenarioPath)).pass).toBe(true);
      expect(readdirSync(world.root).filter((name) => name.startsWith('.run-'))).toHaveLength(2);
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
      expect(existsSync(join(root, 'sim', 'night-train', 'world.json'))).toBe(true);
      await invoke('run', 'night-train', scenarioPath);
      expect(JSON.parse(output.at(-1)!)).toMatchObject({ pass: true, observations: [
        { event: 'live-pid-lock', verdict: 'already-running' },
        { event: 'dead-pid-lock', verdict: 'ready' },
      ] });
      await invoke('destroy-yaml', 'night-train');
      expect(existsSync(join(root, 'sim', 'night-train'))).toBe(false);
    } finally {
      console.log = oldLog;
      console.error = oldError;
      rmSync(join(root, 'sim'), { recursive: true, force: true });
    }
  });
});
