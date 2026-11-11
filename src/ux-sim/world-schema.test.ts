import { describe, expect, test } from 'bun:test';
import { parseSimWorld } from './world-schema.js';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';

const validWorld = {
  world: 'night-train-1',
  seed: 42,
  hosts: [
    { name: 'node-b', arch: 'arm64', cpu: 32, pools: ['gate', 'train'] },
    { name: 'gcp2', arch: 'amd64', cpu: 8, egress: false },
  ],
  providers: { codex: { accounts: ['default:61%', 'team:1%'] }, claude: { quota: 'exhausted' } },
  github: { repo: 'fixture-small', openPRs: 40 },
  seats: ['OP', 'TC', 'OPT'],
  clock: { start: '2026-11-01T18:00:00+09:00', speed: 600 },
  events: [{ at: '+5m', id: 'EV-0042' }, { at: '+20m', id: 'EV-0107' }],
  injections: [{ at: '+1m', ledger: [{ event: 'sim-probe.started', data: { source: 'world-yaml' } }] }],
  processes: [{ id: 'train-auto-loop', host: 'gcp2', releaseVersion: '0.2.45' }],
  chaos: [{ at: '+10m', monkey: { kill: 'train-auto-loop host=gcp2', signal: 'KILL' as const } }],
  expect: { recovers: { within: '+15m', hitl: 0, lostLedger: 0 } },
};

const VALID_WORLD_YAML = `
world: night-train-1
seed: 42
hosts:
  - name: node-b
    arch: arm64
    cpu: 32
    pools: [gate, train]
  - name: gcp2
    arch: amd64
    cpu: 8
    egress: false
processes:
  - { id: train-auto-loop, host: gcp2, releaseVersion: '0.2.45' }
providers:
  codex:
    accounts: [default:61%, team:1%]
  claude:
    quota: exhausted
github: { repo: fixture-small, openPRs: 40 }
seats: [OP, TC, OPT]
clock: { start: '2026-11-01T18:00:00+09:00', speed: 600 }
events:
  - { at: '+5m', id: EV-0042 }
  - { at: '+20m', id: EV-0107 }
injections:
  - at: '+1m'
    ledger:
      - event: sim-probe.started
        data: { source: world-yaml }
    logs:
      - { category: sim-probe, event: started, data: { source: world-yaml } }
chaos:
  - { at: '+10m', monkey: { kill: "train-auto-loop host=gcp2", signal: KILL } }
expect:
  recovers: { within: '+15m', hitl: 0, lostLedger: 0 }
`;

function source(value: unknown): string {
  return JSON.stringify(value);
}

describe('SIM world YAML schema', () => {
  test('parses RFC A2 declarations and resolves device-backed settings through the mock catalog', () => {
    const parsed = parseSimWorld(VALID_WORLD_YAML);
    expect(parsed.world).toBe(validWorld.world);
    expect(parsed.seed).toBe(validWorld.seed);
    expect(parsed.devices).toEqual(['fake-kubectl', 'fake-llm', 'fake-github', 'fake-clock', 'fake-herdr', 'fake-ps']);
    expect(parsed.hosts?.map(({ name, arch, cpu, pools, egress }) => ({ name, arch, cpu, pools, egress }))).toEqual([
      { name: 'node-b', arch: 'arm64', cpu: 32, pools: ['gate', 'train'], egress: false },
      { name: 'gcp2', arch: 'amd64', cpu: 8, pools: [], egress: false },
    ]);
    expect(parsed.providers).toEqual(validWorld.providers);
    expect(parsed.github).toEqual(validWorld.github);
    expect(parsed.seats).toEqual(validWorld.seats);
    expect(parsed.clock).toEqual(validWorld.clock);
    expect(parsed.events).toEqual(validWorld.events);
    expect(parsed.injections).toEqual([{ at: '+1m', ledger: [{ event: 'sim-probe.started', data: { source: 'world-yaml' } }], logs: [{ category: 'sim-probe', event: 'started', data: { source: 'world-yaml' } }] }]);
    expect(parsed.processes).toEqual([{ id: 'train-auto-loop', host: 'gcp2', releaseVersion: '0.2.45' }]);
    expect(parsed.chaos).toEqual([{ at: '+10m', monkey: { kill: 'train-auto-loop host=gcp2', signal: 'KILL' } }]);
    expect(parsed.expect).toEqual({ recovers: { within: '+15m', hitl: 0, lostLedger: 0 } });
    const catalog = loadMockScenarioCatalog();
    expect(parsed.devices.every((id) => catalog.devices.some((device) => device.id === id))).toBe(true);
    expect(catalog.worldEvents.map((event) => event.id)).toContain('EV-0042');
    expect(catalog.worldEvents.map((event) => event.id)).toContain('EV-0107');
  });

  test('accepts an explicitly declared catalog device without inferred settings', () => {
    const parsed = parseSimWorld(source({ world: 'only-fakes', devices: ['fake-github'] }));
    expect(parsed).toEqual({ world: 'only-fakes', seed: 0, devices: ['fake-github'], events: [] });
  });

  test('resolves seat declarations through the existing fake-herdr catalog entry', () => {
    const parsed = parseSimWorld(source({ world: 'seat-world', seats: ['OPT'] }));
    expect(parsed.devices).toEqual(['fake-herdr']);
    expect(loadMockScenarioCatalog().devices.some((device) => device.id === parsed.devices[0])).toBe(true);
  });

  test('rejects unsupported fields at their exact object path', () => {
    const badTop = { ...validWorld, debug: true };
    expect(() => parseSimWorld(source(badTop))).toThrow('world.debug');
    expect(() => parseSimWorld('world: blank-key\ndevices: [fake-clock]\n"": ignored\n'))
      .toThrow('world. is not a supported field');
    const badClock = { ...validWorld, clock: { ...validWorld.clock, timezone: 'KST' } };
    expect(() => parseSimWorld(source(badClock))).toThrow('world.clock.timezone');
    expect(() => parseSimWorld('world: nested-blank-key\ndevices: [fake-clock]\nclock:\n  start: "2026-11-02T00:00:00Z"\n  speed: 1\n  "": ignored\n'))
      .toThrow('world.clock. is not a supported field');
    const badHost = { ...validWorld, hosts: [{ ...validWorld.hosts[0], accelerator: 'gpu' }] };
    expect(() => parseSimWorld(source(badHost))).toThrow('world.hosts[0].accelerator');
  });

  test('rejects invalid IDs, numbers, duplicate names, and wrong field shapes with paths', () => {
    expect(() => parseSimWorld(source({ ...validWorld, world: '../escape' }))).toThrow('world.world');
    expect(() => parseSimWorld(source({ ...validWorld, seed: -1 }))).toThrow('world.seed');
    expect(() => parseSimWorld(source({ ...validWorld, clock: { ...validWorld.clock, speed: 0 } }))).toThrow('world.clock.speed');
    expect(() => parseSimWorld(source({ ...validWorld, hosts: [{ ...validWorld.hosts[0], cpu: 'many' }] }))).toThrow('world.hosts[0].cpu');
    expect(() => parseSimWorld(source({ ...validWorld, hosts: [validWorld.hosts[0], validWorld.hosts[0]] }))).toThrow('duplicate name');
    expect(() => parseSimWorld(source({ ...validWorld, providers: { codex: 'not-an-object' } }))).toThrow('world.providers.codex');
    expect(() => parseSimWorld(source({ ...validWorld, github: { ...validWorld.github, openPRs: -1 } }))).toThrow('world.github.openPRs');
    expect(() => parseSimWorld(source({ ...validWorld, seats: ['OP', 'OP'] }))).toThrow('world.seats cannot contain duplicates');
  });

  test('validates RFC provider fields and reports malformed values at their paths', () => {
    expect(() => parseSimWorld(source({ world: 'bad-codex', providers: { codex: { accounts: 3 } } })))
      .toThrow('world.providers.codex.accounts');
    expect(() => parseSimWorld(source({ world: 'bad-account', providers: { codex: { accounts: ['team:101%'] } } })))
      .toThrow('world.providers.codex.accounts[0]');
    expect(() => parseSimWorld(source({ world: 'bad-claude', providers: { claude: { quota: ['exhausted'] } } })))
      .toThrow('world.providers.claude.quota');
    expect(() => parseSimWorld(source({ world: 'bad-provider', providers: { unknown: { state: 'ready' } } })))
      .toThrow('world.providers.unknown');
  });

  test('requires a real ISO 8601 date-time for the simulated clock', () => {
    expect(() => parseSimWorld(source({ world: 'numeric-date', devices: ['fake-clock'], clock: { start: '12', speed: 1 } })))
      .toThrow('world.clock.start');
    expect(() => parseSimWorld(source({ world: 'impossible-date', devices: ['fake-clock'], clock: { start: '2026-02-30T18:00:00+09:00', speed: 1 } })))
      .toThrow('world.clock.start');
  });

  test('rejects device and event references that are not registered', () => {
    expect(() => parseSimWorld(source({ world: 'bad-device', devices: ['fake-cloud'] })))
      .toThrow('world.devices[0] references unregistered mock device: fake-cloud');
    expect(() => parseSimWorld(source({
      world: 'bad-event', devices: ['fake-clock'], events: [{ at: '+5m', id: 'EV-9999' }],
    }))).toThrow('world.events[0].id references unregistered world event: EV-9999');
  });

  test('rejects malformed event shape, time, and duplicate YAML keys', () => {
    expect(() => parseSimWorld(source({
      world: 'bad-time', devices: ['fake-clock'], events: [{ at: 'tomorrow', id: 'EV-0042' }],
    }))).toThrow('world.events[0].at');
    expect(() => parseSimWorld(source({
      world: 'bad-event-shape', devices: ['fake-clock'], events: [{ id: 'EV-0042' }],
    }))).toThrow('world.events[0].at');
    expect(() => parseSimWorld('world: first\nworld: second\ndevices: [fake-clock]\n')).toThrow('world YAML is invalid');
  });

  test('rejects declarations without a device or device-backed setting', () => {
    expect(() => parseSimWorld(source({ world: 'empty-world' }))).toThrow('at least one mock device');
  });

  test('monkey targets a declared process and recovery budgets are measured nonnegative values', () => {
    expect(() => parseSimWorld(source({ ...validWorld, processes: undefined })))
      .toThrow('world.chaos[0].monkey.kill must name a declared world process');
    expect(() => parseSimWorld(source({ ...validWorld, processes: [{ id: 'train-auto-loop', host: 'missing', releaseVersion: '0.2.45' }] })))
      .toThrow('world.processes[0].host');
    expect(() => parseSimWorld(source({ ...validWorld, chaos: [{ at: '+1m', monkey: { kill: 'other host=gcp2', signal: 'KILL' } }] })))
      .toThrow('world.chaos[0].monkey.kill');
    expect(() => parseSimWorld(source({ ...validWorld, chaos: [{ at: '+1m', monkey: { kill: 'worker', signal: 'SIGSTOP' } }] })))
      .toThrow('world.chaos[0].monkey.kill');
    expect(() => parseSimWorld(source({ ...validWorld, chaos: [{ at: '+1m', monkey: { kill: 'train-auto-loop host=gcp2', signal: 'SIGSTOP' } }] })))
      .toThrow('world.chaos[0].monkey.signal');
    expect(() => parseSimWorld(source({ ...validWorld, expect: { recovers: { within: '+5m', hitl: -1, lostLedger: 0 } } })))
      .toThrow('world.expect.recovers.hitl');
    expect(() => parseSimWorld(source({ ...validWorld, chaos: undefined })))
      .toThrow('world.expect.recovers requires world.chaos');
    expect(() => parseSimWorld(source({ ...validWorld, injections: undefined })))
      .toThrow('world.expect.recovers requires injected ledger rows to measure losses');
    expect(() => parseSimWorld(source({ ...validWorld, injections: [{ at: '+1m', ledger: [{ event: '' }] }] })))
      .toThrow('world.injections[0].ledger[0].event');
  });

  test('gorilla and disaster faults target declared hosts and carry measurable recovery inputs', () => {
    const gorilla = { ...validWorld, chaos: [{ at: '+5m', gorilla: { host: 'gcp2', egress: false, cpu: 2, for: '+20m' } }] };
    expect(parseSimWorld(source(gorilla)).chaos).toEqual([{ at: '+5m', gorilla: { host: 'gcp2', egress: false, cpu: 2, for: '+20m' } }]);
    const hqProcess = { id: 'headquarters', host: 'node-b', releaseVersion: '0.3.5', role: 'headquarters', fingerprint: 'fp_hq_headquarters', lane: 'hand', mission: 'hq-handoff' };
    const disaster = { ...validWorld, processes: [...validWorld.processes, hqProcess], chaos: [{ at: '+10m', disaster: { host: 'node-b', down: true } }], injections: undefined };
    expect(parseSimWorld(source(disaster)).chaos).toEqual([{ at: '+10m', disaster: { host: 'node-b', down: true } }]);
    expect(() => parseSimWorld(source({ ...validWorld, chaos: [{ at: '+1m', gorilla: { host: 'unknown', egress: false, cpu: 2, for: '+1m' } }] })))
      .toThrow('gorilla.host must name exactly one declared world host');
    expect(() => parseSimWorld(source({ ...validWorld, chaos: [{ at: '+1m', gorilla: { host: 'gcp2', egress: false, cpu: 8, for: '+1m' } }] })))
      .toThrow('gorilla.cpu must reduce');
    expect(() => parseSimWorld(source({ ...validWorld, chaos: [
      { at: '+1m', gorilla: { host: 'node-b', egress: false, cpu: 2, for: '+5m' } },
      { at: '+6m', gorilla: { host: 'node-b', egress: false, cpu: 2, for: '+1m' } },
    ] }))).toThrow('overlaps another host fault for node-b');
    expect(() => parseSimWorld(source({ ...validWorld, hosts: [validWorld.hosts[0]], processes: [hqProcess], chaos: [{ at: '+1m', disaster: { host: 'node-b', down: true } }] })))
      .toThrow('needs a surviving declared host');
    expect(() => parseSimWorld(source({ ...validWorld, chaos: [{ at: '+1m', disaster: { host: 'gcp2', down: true } }] })))
      .toThrow('must identify the world\'s exactly one headquarters process');
    const unmarkedHeadquarters = { ...hqProcess, role: undefined };
    expect(() => parseSimWorld(source({ ...validWorld, processes: [...validWorld.processes, unmarkedHeadquarters],
      chaos: [{ at: '+1m', disaster: { host: 'node-b', down: true } }] })))
      .toThrow('must identify the world\'s exactly one headquarters process');
    const secondHeadquarters = { ...hqProcess, id: 'second-headquarters', host: 'gcp2', fingerprint: 'fp_hq_second', mission: 'second-handoff' };
    expect(() => parseSimWorld(source({ ...validWorld, processes: [...validWorld.processes, hqProcess, secondHeadquarters],
      chaos: [{ at: '+1m', disaster: { host: 'node-b', down: true } }] })))
      .toThrow('must identify the world\'s exactly one headquarters process');
    expect(() => parseSimWorld(source({ ...validWorld, processes: [...validWorld.processes, hqProcess], chaos: [
      { at: '+1m', disaster: { host: 'node-b', down: true } },
      { at: '+2m', gorilla: { host: 'node-b', egress: false, cpu: 2, for: '+1m' } },
    ] }))).toThrow('overlaps another host fault for node-b');
  });
});
