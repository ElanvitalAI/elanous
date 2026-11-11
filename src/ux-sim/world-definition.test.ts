import { expect, test } from 'bun:test';
import { withSimClock } from './fake-clock.js';
import { parseSimWorld, assembleWorld } from './world.js';

test('world YAML assembles declared host, provider, GitHub, clock, and seat fakes by catalog name', async () => {
  const spec = parseSimWorld(`
world: fixture-world
seed: 17
clock: { start: "2026-11-01T18:00:00+09:00", speed: 600 }
hosts:
  - { name: gcp2, arch: amd64, cpu: 8, pools: [gate], egress: false }
providers:
  codex: { accounts: [default:61%, team:1%] }
  claude: { quota: exhausted }
github: { repo: fixture-small, openPRs: 2 }
seats: [OP, OPT]
processes:
  - { id: run-release, host: gcp2, releaseVersion: '0.2.45' }
chaos:
  - { at: '+1m', monkey: { kill: 'run-release host=gcp2', signal: TERM } }
injections:
  - at: '+30s'
    ledger:
      - { event: sim-world.ready, data: { sample: fixture } }
expect:
  recovers: { within: '+6m', hitl: 0, lostLedger: 0 }
events:
  - { at: "+5m", id: dead-pid-lock }
`);

  expect(spec.devices).toEqual(['fake-kubectl', 'fake-ps', 'fake-llm', 'fake-gh', 'fake-clock', 'mail']);
  expect(spec.processes).toEqual([{ id: 'run-release', host: 'gcp2', releaseVersion: '0.2.45' }]);
  expect(spec.chaos).toHaveLength(1);
  expect(spec.expect?.recovers).toEqual({ within: '+6m', hitl: 0, lostLedger: 0 });
  const { devices } = assembleWorld({ spec });
  const kubectl = devices.get('fake-kubectl') as { kubectl(args: string[]): { status: number; stdout: string } };
  expect(kubectl.kubectl(['config', 'get-contexts', 'fixture-world-gcp2-context']).status).toBe(0);
  const host = JSON.parse(kubectl.kubectl(['--context', 'fixture-world-gcp2-context', 'get', 'nodes', '-o', 'json']).stdout) as {
    items: Array<{ metadata: { name: string }; status: { allocatable: Record<string, string> } }>;
  };
  expect(host.items[0]?.status.allocatable.cpu).toBe('8');
  const node = JSON.parse(kubectl.kubectl(['--context', 'fixture-world-gcp2-context', 'get', 'node', host.items[0]!.metadata.name, '-o', 'json']).stdout) as {
    metadata: { labels: Record<string, string> };
  };
  expect(node.metadata.labels).toMatchObject({ 'kubernetes.io/arch': 'amd64', 'elanous.dev/pools': 'gate' });
  const github = devices.get('fake-gh') as { prs: unknown[] };
  expect(github.prs).toHaveLength(2);
  const llm = devices.get('fake-llm') as { config: unknown; response(): Promise<string> };
  expect(llm.config).toEqual(spec.providers);
  expect(await llm.response()).toContain('test-fake-llm');
  const clock = devices.get('fake-clock') as { start: string; speed: number; withClock: typeof withSimClock };
  expect(clock).toMatchObject({ start: '2026-11-01T18:00:00+09:00', speed: 600 });
  expect(await clock.withClock(new Date(clock.start), (simClock) => simClock.now())).toBe(Date.parse(clock.start));
  const mail = devices.get('mail') as { list(to: string): unknown[] };
  expect(mail.list('OP')).toEqual([]);
});

test('world YAML rejects malformed host and unsupported device declarations', () => {
  expect(() => parseSimWorld('world: x\nhosts: [{ name: gcp2, arch: arm64, cpu: -1 }]'))
    .toThrow('world.hosts[0].cpu');
  expect(() => parseSimWorld('world: x\ndevices: [invented-fake]'))
    .toThrow('unknown mock device');
});
