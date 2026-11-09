import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { createFakeAppHost } from './fake-app-host.js';
import { parseSimWorld } from './world-schema.js';
import { assembleWorld, createWorld, destroyWorld, executeWorldScenario, parseSimWorld as parseRuntimeWorld } from './world.js';

const apps = [{ slug: 'demo', versions: [
  { id: 'v1', files: { 'index.html': '<h1>v1</h1>' } },
  { id: 'v2', files: { 'index.html': '<h1>v2</h1>' } },
] }] as const;

test('SIM-APPHOST serves an explicitly deployed immutable version, rolls back by pointer, and enforces host and file boundaries', () => {
  const host = createFakeAppHost(apps);
  host.deploy('demo', 'v1');
  const v1 = host.fetch('demo.app.sim.invalid', '/index.html');
  expect(v1.status).toBe(200);
  expect(host.fetch('demo.app.sim.invalid', '/')).toMatchObject({ status: 200, body: '<h1>v1</h1>' });
  expect(v1.headers['x-app-host']).toBe('demo.app.sim.invalid');
  expect(v1.headers['x-app-host']).not.toBe('localhost');
  expect(v1.headers['x-app-origin']).toBe('https://demo.app.sim.invalid');
  expect(v1.headers['x-app-version']).toBe('v1');
  const v1Hash = createHash('sha256').update(v1.body).digest('hex');
  expect(v1.headers['x-app-sha256']).toBe(v1Hash);
  host.deploy('demo', 'v2');
  expect(host.fetch('demo.app.sim.invalid', '/index.html').headers['x-app-version']).toBe('v2');
  host.deploy('demo', 'v2');
  host.rollback('demo');
  expect(host.fetch('demo.app.sim.invalid', '/index.html').headers['x-app-sha256']).toBe(v1Hash);
  expect(host.fetch('missing.app.sim.invalid', '/index.html').status).toBe(404);
  expect(host.fetch('demo', '/index.html').status).toBe(404);
  expect(host.fetch('demo.app.sim.invalid', '/constructor').status).toBe(404);
  expect(() => createFakeAppHost([{ slug: 'collision', versions: [{ id: 'v1', files: { 'index.html': 'a', '/index.html': 'b' } }] }]))
    .toThrow('duplicate normalized app file path');
});

test('SIM-APPHOST publishes generated immutable artifacts and serves their captured files', () => {
  const host = createFakeAppHost(apps);
  host.deploy('demo', 'v1');
  host.deployArtifact('demo', { id: 'v2-generated', files: { 'index.html': '<h1>generated</h1>', 'share/demo': '<article>note</article>' } });
  expect(host.fetch('demo.app.sim.invalid', '/share/demo')).toMatchObject({ status: 200, body: '<article>note</article>' });
  expect(host.fetch('demo.app.sim.invalid', '/index.html').headers['x-app-version']).toBe('v2-generated');
  expect(() => host.deployArtifact('demo', { id: 'v2-generated', files: { 'index.html': 'mutated' } }))
    .toThrow('app artifact version already exists or is invalid');
  host.rollback('demo');
  expect(host.fetch('demo.app.sim.invalid', '/index.html').headers['x-app-version']).toBe('v1');
});

test('SIM-APPHOST resolves extensionless routes to their static-export index.html file', () => {
  const host = createFakeAppHost([{ slug: 'lecture-scrap', current: 'v1', versions: [
    { id: 'v1', files: { 'search/index.html': '<main>검색</main>' } },
  ] }]);
  expect(host.fetch('lecture-scrap.app.sim.invalid', '/search')).toMatchObject({ status: 200, body: '<main>검색</main>' });
});

test('SIM-APPHOST serves non-HTML assets with path-appropriate content types', () => {
  const host = createFakeAppHost([{ slug: 'assets', versions: [{ id: 'v1', files: {
    'app.js': 'console.log("ok")',
    'style.css': 'body { color: red }',
    'data.json': '{"ok":true}',
    'image.bin': 'bytes',
    'index.html': '<h1>ready</h1>',
  } }] }]);
  host.deploy('assets', 'v1');

  expect(host.fetch('assets.app.sim.invalid', '/app.js').headers['content-type']).toBe('text/javascript; charset=utf-8');
  expect(host.fetch('assets.app.sim.invalid', '/style.css').headers['content-type']).toBe('text/css; charset=utf-8');
  expect(host.fetch('assets.app.sim.invalid', '/data.json').headers['content-type']).toBe('application/json; charset=utf-8');
  expect(host.fetch('assets.app.sim.invalid', '/image.bin').headers['content-type']).toBe('application/octet-stream');
  expect(host.fetch('assets.app.sim.invalid', '/index.html').headers['content-type']).toBe('text/html; charset=utf-8');
});

test('SIM-APPHOST parses app declarations and assembles the in-memory host', () => {
  const source = `world: app-world\napps:\n  - slug: demo\n    current: v1\n    versions:\n      - id: v1\n        files: { index.html: '<h1>one</h1>' }\n`;
  expect(parseSimWorld(source).apps).toEqual([{ slug: 'demo', current: 'v1', versions: [{ id: 'v1', files: { 'index.html': '<h1>one</h1>' } }] }]);
  expect(parseRuntimeWorld(source).apps).toBeDefined();
  const assembled = assembleWorld({ spec: parseRuntimeWorld(source) });
  const appHost = assembled.appHost!;
  expect(appHost.fetch('demo.app.sim.invalid', '/index.html').status).toBe(200);
  expect(() => parseSimWorld('world: bad-app\napps: [{ slug: "Bad", versions: [] }]')).toThrow();
});

test('SIM-APPHOST remains an app-specific runtime and unknown generic devices still fail catalog validation', () => {
  expect(() => parseRuntimeWorld('world: invalid-app-device\ndevices: [fake-app-host]')).toThrow('unknown mock device: fake-app-host');
});

test('SIM-APPHOST rejects malformed app versions, files, current pointers, and duplicate slugs with world paths', () => {
  const parse = (appsValue: unknown) => parseSimWorld(JSON.stringify({ world: 'invalid-apps', apps: appsValue }));
  expect(() => parse([{ slug: 'demo', versions: [] }])).toThrow('world.apps[0].versions must be a non-empty list');
  expect(() => parse([{ slug: 'demo', versions: [{ id: 'v1', files: { index: 1 } }] }])).toThrow('world.apps[0].versions[0].files.index');
  expect(() => parse([{ slug: 'demo', current: 'v2', versions: [{ id: 'v1', files: {} }] }])).toThrow('world.apps[0].current');
  expect(() => parse([{ slug: 'demo', versions: [{ id: 'v1', files: {} }, { id: 'v1', files: {} }] }])).toThrow('world.apps[0].versions');
  expect(() => parse([{ slug: 'demo', versions: [{ id: 'v1', files: {} }] }, { slug: 'demo', versions: [{ id: 'v1', files: {} }] }]))
    .toThrow('world.apps cannot contain duplicate slugs');
});

test('SIM-APPHOST preserves special file keys as ordinary own properties', () => {
  const parsed = parseSimWorld('{"world":"proto-app","apps":[{"slug":"demo","versions":[{"id":"v1","files":{"__proto__":"safe"}}]}]}');
  expect(Object.hasOwn(parsed.apps![0]!.versions[0]!.files, '__proto__')).toBe(true);
  expect(parsed.apps![0]!.versions[0]!.files['__proto__']).toBe('safe');
});

test('SIM-APPHOST schedules app actions before and after release injection on the shared world clock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-app-world-'));
  const previousRoot = getTestStateRoot();
  const previousSandbox = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
  setTestStateRoot(root);
  process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
  const worldFile = join(root, 'world.yaml');
  const scenarioFile = join(root, 'scenario.yaml');
  writeFileSync(worldFile, `world: app-execution\nhosts:\n  - { name: worker-host, arch: amd64, cpu: 8, pools: [], egress: true }\nprocesses:\n  - { id: worker, host: worker-host, releaseVersion: '0.2.45' }\napps:\n  - slug: demo\n    versions:\n      - id: v1\n        files: { index.html: one }\n      - id: v2\n        files: { index.html: two }\nevents:\n  - { at: '+1m', id: EV-0042, appAction: deploy, slug: demo, version: v1 }\n  - { at: '+2m', id: EV-0042 }\n  - { at: '+4m', id: EV-0042, appAction: deploy, slug: demo, version: v2 }\n  - { at: '+5m', id: EV-0042, appAction: rollback, slug: demo }\nchaos:\n  - { at: '+3m', monkey: { kill: 'worker host=worker-host', signal: TERM } }\ninjections:\n  - at: '+210s'\n    ledger:\n      - { event: sim-app.after-release, data: { sample: 1 } }\n`);
  writeFileSync(scenarioFile, `world: app-execution\nsteps:\n  - inject: { id: EV-0042, version: '0.2.45' }\n  - observe: release-readiness\nexpect:\n  livePidLock: { ready: false, reason: already-running }\n  deadPidLock: { ready: true, reason: ready }\n`);
  mkdirSync(join(root, 'sim'), { recursive: true });
  let world: Awaited<ReturnType<typeof createWorld>> | undefined;
  try {
    world = await createWorld(worldFile);
    const result = await executeWorldScenario(world, scenarioFile);
    expect(result.pass).toBe(true);
    expect(result.observations.filter((row) => row.event.startsWith('app-')).map((row) => row.verdict.split(' ')[0]))
      .toEqual(['v1', 'v2', 'v1']);
    expect(result.observations.map((row) => row.event)).toEqual([
      'app-deploy-demo', 'live-pid-lock', 'dead-pid-lock', 'app-deploy-demo', 'app-rollback-demo', 'chaos-monkey',
    ]);
    expect(result.recovery?.timeline.map((row) => `${row.atMs}|${row.kind}|${row.target}`)).toEqual([
      '60000|world-event|deploy:demo', '120000|world-event|release:EV-0042',
      '180000|fault-start|worker host=worker-host',
      '180250|fault-recovery|worker host=worker-host', `210000|injection|${result.recovery?.injections[0]?.injectionId}`,
      '240000|world-event|deploy:demo', '300000|world-event|rollback:demo',
    ]);
  } finally {
    if (world) await destroyWorld(world);
    setTestStateRoot(previousRoot ?? null);
    if (previousSandbox === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previousSandbox;
    rmSync(root, { recursive: true, force: true });
  }
});

test('SIM-APPHOST app-only scenario shares injection and gorilla events on the scheduler clock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-app-schedule-'));
  const previousRoot = getTestStateRoot();
  const previousSandbox = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
  setTestStateRoot(root);
  process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
  const worldFile = join(root, 'world.yaml');
  const scenarioFile = join(root, 'scenario.yaml');
  writeFileSync(worldFile, `world: app-schedule\nclock: { start: '2100-01-01T00:00:00Z', speed: 1 }\nhosts:\n  - { name: survivor, arch: arm64, cpu: 32, pools: [gate], egress: true }\n  - { name: target, arch: amd64, cpu: 8, pools: [gate], egress: true }\nprocesses:\n  - { id: worker, host: target, releaseVersion: '0.3.5' }\napps:\n  - slug: demo\n    versions:\n      - id: v1\n        files: { index.html: one }\nevents:\n  - { at: '+2m', id: EV-0042, appAction: deploy, slug: demo, version: v1 }\nchaos:\n  - { at: '+1m', gorilla: { host: target, egress: false, cpu: 0, for: '+2m' } }\ninjections:\n  - at: '+30s'\n    ledger:\n      - { event: sim-app.probe, data: { sample: 1 } }\nexpect:\n  recovers: { within: '+2m', hitl: 0, lostLedger: 0 }\n`);
  writeFileSync(scenarioFile, `world: app-schedule\nsteps:\n  - observe: app-host\n`);
  mkdirSync(join(root, 'sim'), { recursive: true });
  let world: Awaited<ReturnType<typeof createWorld>> | undefined;
  try {
    world = await createWorld(worldFile);
    const result = await executeWorldScenario(world, scenarioFile);
    expect(result.pass).toBe(true);
    expect(result.recovery?.timeline.map((row) => `${row.atMs}|${row.kind}|${row.target}`)).toEqual([
      `30000|injection|${result.recovery?.injections[0]?.injectionId}`,
      '60000|fault-start|target', '120000|world-event|deploy:demo',
      '180000|fault-recovery|target',
    ]);
    expect(result.recovery?.evaluation).toMatchObject({ pass: true, failures: [], unmeasured: [] });
  } finally {
    if (world) await destroyWorld(world);
    setTestStateRoot(previousRoot ?? null);
    if (previousSandbox === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previousSandbox;
    rmSync(root, { recursive: true, force: true });
  }
});
