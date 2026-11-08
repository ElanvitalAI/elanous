import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import childProcess from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseSimChaos, parseSimWorld as parseSimWorldSchema, parseSimWorldExpectation, parseSimWorldInjections, parseSimWorldProcesses, type SimChaosFault, type SimRecoveryExpectation, type SimWorldApp, type SimWorldInjection, type SimWorldProcess } from './world-schema.js';
import { createFakeGh } from './fake-gh.js';
import { createFakeKubectl } from './fake-kubectl.js';
import { createFakeSsh } from './fake-ssh.js';
import { createFakeFleetDevice } from './fake-fleet.js';
import { createFakeCloudVm } from './fake-cloud-vm.js';
import { createFakePsDevice, type FakePsDevice } from './fake-ps.js';
import { testFakeLlmEnabled, testFakeLlmResponse } from './fake-llm.js';
import { withSimClock, type SimClock } from './fake-clock.js';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';
import { getTestStateRoot } from '../nexus/paths.js';
import { injectAnyEvent, type EventMonkeyDebugRow } from './event-monkey.js';
import { loadRunLedger, runLedgerDir, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { releaseReadiness } from '../../scripts/release-loop/release-readiness.js';
import type { HqMoveFault } from './hq-move-sim.js';
import { isTrustedPromotionPythonBody } from '../hq/promote.js';

// Capture before runInWorld's process sandbox is installed; tests can execute worlds concurrently.
const spawnSyncForPromotion = childProcess.spawnSync;
import { createFakeAppHost } from './fake-app-host.js';
import { createFakeStt } from './fake-stt.js';
import { fakeElevenLabsAudioBytes } from './fake-elevenlabs.js';
import { createFakeHiggsfieldRunner } from './fake-higgsfield.js';
import { createFakeAppStorage } from './fake-app-storage.js';
import { createAppActions } from '../nexus/apps/app-actions.js';
import { loadNexusAppHost } from '../nexus/apps/app-host.js';
import { runWorldChaosSchedule, type WorldChaosAction, type WorldChaosRun, type WorldChaosScheduledEvent } from './world-chaos-runtime.js';
import { createWorldHostChaosController } from './world-host-chaos.js';
import { createSimWorld, destroySimWorld, listSimWorlds } from './world-store.js';
import { applyDeviceFidelity } from './device-fidelity.js';
import { recordSimWorldCoverage } from './sim-coverage.js';
import { createPodReuseResidueFaultFixture } from './fault-pod-reuse-residue.js';
import { appendSimWorldWatchEvents } from './world-watch.js';
import type { GateRosterScenario } from './gate-roster-second-pool.js';
import { runWarmSiReuseSimulation } from './warm-si-reuse-sim.js';
import { podSelfImplementSpawn, type SiWarmChildAttempt } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { siWarmSha256, type SiWarmCommand, type SiWarmReply, type SiWarmReturnedBytes } from '../task-orchestrator/surfaces/pod-si-warm-protocol.js';
import type { ChildPodReuseOperations } from '../task-orchestrator/surfaces/pod-child-reuse.js';

/** Catalog world-event IDs map to the concrete simulation input handled by this runner. */
const WORLD_EVENT_TO_SCENARIO_INPUT: Readonly<Record<string, string>> = {
  'EV-0042': 'dead-pid-lock',
} as const;

const GATE_ROSTER_WORLD_CASES: Readonly<Record<string, { scenario: GateRosterScenario; verdict: string }>> = {
  'gate-pools-pinned-sweep': { scenario: { poolSpec: 'pool-node-b@node-b:4,pool-mshq@mshq:2',
    imageDigests: { 'pool-node-b': `sha256:${'a'.repeat(64)}`, 'pool-mshq': `sha256:${'a'.repeat(64)}` } }, verdict: 'pass' },
  'gate-mshq-unavailable': { scenario: { poolSpec: 'pool-mshq@mshq:2,pool-node-b@node-b:4', fileCount: 1,
    imageDigests: { 'pool-node-b': `sha256:${'a'.repeat(64)}`, 'pool-mshq': `sha256:${'a'.repeat(64)}` }, unreachableHosts: ['pool-mshq'] }, verdict: 'pass' },
  'gate-both-unavailable': { scenario: { poolSpec: 'pool-node-b@node-b:4,pool-mshq@mshq:2',
    imageDigests: { 'pool-node-b': `sha256:${'a'.repeat(64)}`, 'pool-mshq': `sha256:${'a'.repeat(64)}` }, unreachableHosts: ['pool-node-b', 'pool-mshq'] }, verdict: 'measurement-unavailable' },
  'gate-digest-mismatch': { scenario: { poolSpec: 'pool-node-b@node-b:4,pool-mshq@mshq:2',
    imageDigests: { 'pool-node-b': `sha256:${'a'.repeat(64)}`, 'pool-mshq': `sha256:${'b'.repeat(64)}` } }, verdict: 'image-fingerprint-mismatch' },
  'gate-no-pinned-image': { scenario: { poolSpec: 'pool-node-b@node-b:4,pool-mshq@mshq:2',
    imageDigests: { 'pool-node-b': null, 'pool-mshq': null } }, verdict: 'measurement-unavailable' },
};

export interface SimWorldSpec {
  world: string;
  seed: number;
  devices: string[];
  clock?: { start: string; speed: number };
  hosts?: Array<{ name: string; arch: 'arm64' | 'amd64'; cpu: number; pools: string[]; egress: boolean }>;
  providers?: Record<string, Record<string, unknown>>;
  github?: { repo: string; openPRs: number };
  seats?: string[];
  apps?: SimWorldApp[];
  processes?: SimWorldProcess[];
  events: Array<{ at: string; id: string; appAction?: 'deploy' | 'rollback'; slug?: string; version?: string }>;
  injections?: SimWorldInjection[];
  chaos?: SimChaosFault[];
  expect?: { recovers: SimRecoveryExpectation };
}

export interface SimNetworkEvent { url: string; blocked: true }
export interface SimWorld {
  readonly id: string;
  readonly root: string;
  readonly spec: SimWorldSpec;
  readonly networkEvents: SimNetworkEvent[];
}

export interface AssembledWorld { devices: Map<string, unknown>; appHost?: ReturnType<typeof createFakeAppHost> }
export interface WorldExecutionRuntime {
  runPromotionPython(source: string, home: string, env: Record<string, string>): { status: number | null; stdout: string; stderr: string };
}
export interface SimMailMessage { readonly from: string; readonly to: string; readonly kind: string; readonly body: string; readonly acked: boolean }
export interface SimMailbox {
  post(message: Omit<SimMailMessage, 'acked'>): number;
  list(to: string): SimMailMessage[];
  ack(to: string, id: number): void;
}
export interface WorldScenarioResult {
  pass: boolean;
  observations: Array<{
    event: string; verdict: string; gateOutcome?: string; gateError?: string | null;
    placements?: readonly { context: string; files: readonly string[]; available: boolean }[];
    reassignments?: readonly { from: string; to: string; files: readonly string[] }[];
    completedFiles?: readonly string[];
  }>;
  devices: string[];
  recovery?: WorldChaosRun;
  verdict?: 'green' | 'yellow' | 'red';
  fidelity?: Array<{ deviceId: string; verdict: 'green' | 'yellow' | 'unmeasured'; failedRecordingIds: string[] }>;
  billing?: { provider: 'fake-higgsfield'; spendCents: number; externalNetworkAttempts: number };
  publicShare?: { status: number; version: string; body: string };
}

function worldWatchObservations(world: SimWorld, runId: string): Array<{ event: string; verdict: string }> {
  const rows: Array<{ event: string; verdict: string }> = [];
  const push = rows.push.bind(rows);
  rows.push = (...events) => {
    appendSimWorldWatchEvents(world, runId, events);
    return push(...events);
  };
  return rows;
}

const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function worldOffsetMs(value: string): number {
  const match = /^\+(0|[1-9]\d*)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`invalid relative world offset: ${value}`);
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
  const result = Number(match[1]) * scale[match[2] as keyof typeof scale];
  if (!Number.isSafeInteger(result)) throw new Error(`relative world offset is too large: ${value}`);
  return result;
}
let activeNetworkWorld: SimWorld | undefined;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function createSimMailbox(): SimMailbox {
  const messages: SimMailMessage[] = [];
  return {
    post(message) {
      for (const key of ['from', 'to', 'kind', 'body'] as const) {
        if (typeof message[key] !== 'string' || !message[key].trim()) throw new Error(`mail.${key} must be non-empty`);
      }
      messages.push({ ...message, acked: false });
      return messages.length;
    },
    list(to) { return messages.flatMap((message) => message.to === to ? [{ ...message }] : []); },
    ack(to, id) {
      const index = id - 1;
      const message = messages[index];
      if (!message || message.to !== to) throw new Error(`mail message not found: ${id}`);
      messages[index] = { ...message, acked: true };
    },
  };
}

export function parseSimWorld(source: string): SimWorldSpec {
  const value = object(parseYaml(source), 'world');
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps) || value.steps.some((step, index) => !step || typeof step !== 'object' || Array.isArray(step))) {
      throw new Error('world.steps must be a list of scenario step objects');
    }
  }
  const hasAppEvents = Array.isArray(value.events) && value.events.some((event) => !!event && typeof event === 'object' && 'appAction' in event);
  // A scenario may be self-contained: its executable steps are not world configuration.
  const schemaSource = 'steps' in value || 'demo' in value
    ? JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'steps' && key !== 'demo'))) : source;
  const appWorld = value.apps !== undefined || hasAppEvents ? parseSimWorldSchema(schemaSource) : undefined;
  const apps = appWorld?.apps;
  const id = value.world;
  if (typeof id !== 'string' || !WORLD_ID.test(id)) throw new Error('world.world must be a lowercase world id');
  const seed = value.seed ?? 0;
  if (!Number.isSafeInteger(seed) || Number(seed) < 0) throw new Error('world.seed must be a nonnegative integer');
  const requestedDevices = value.devices ?? [];
  if (!Array.isArray(requestedDevices) || requestedDevices.some((device) => typeof device !== 'string' || !device.trim())) {
    throw new Error('world.devices must be a list of catalog device names');
  }
  if (new Set(requestedDevices as string[]).size !== requestedDevices.length) throw new Error('world.devices cannot contain duplicate names');
  const clockValue = value.clock === undefined ? undefined : object(value.clock, 'world.clock');
  let clock: SimWorldSpec['clock'];
  if (clockValue) {
    if (typeof clockValue.start !== 'string' || !Number.isFinite(Date.parse(clockValue.start))) throw new Error('world.clock.start must be a date-time string');
    if (!Number.isSafeInteger(clockValue.speed) || Number(clockValue.speed) <= 0) throw new Error('world.clock.speed must be a positive integer');
    clock = { start: clockValue.start, speed: Number(clockValue.speed) };
  }
  let hosts: SimWorldSpec['hosts'];
  if (value.hosts !== undefined) {
    if (!Array.isArray(value.hosts)) throw new Error('world.hosts must be a list');
    hosts = value.hosts.map((candidate, index) => {
      const host = object(candidate, `world.hosts[${index}]`);
      if (typeof host.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(host.name)) throw new Error(`world.hosts[${index}].name must be a lowercase host id`);
      if (host.arch !== 'arm64' && host.arch !== 'amd64') throw new Error(`world.hosts[${index}].arch must be arm64 or amd64`);
      if (!Number.isSafeInteger(host.cpu) || Number(host.cpu) <= 0) throw new Error(`world.hosts[${index}].cpu must be a positive integer`);
      if (!Array.isArray(host.pools) || host.pools.some((pool) => typeof pool !== 'string' || !pool.trim())) throw new Error(`world.hosts[${index}].pools must be a list of names`);
      if (host.egress !== undefined && typeof host.egress !== 'boolean') throw new Error(`world.hosts[${index}].egress must be boolean`);
      return { name: host.name, arch: host.arch, cpu: Number(host.cpu), pools: host.pools as string[], egress: host.egress === true };
    });
    if (new Set(hosts.map((host) => host.name)).size !== hosts.length) throw new Error('world.hosts cannot contain duplicate names');
  }
  let providers: SimWorldSpec['providers'];
  if (value.providers !== undefined) {
    const rows = object(value.providers, 'world.providers');
    providers = Object.fromEntries(Object.entries(rows).map(([name, config]) => [name, object(config, `world.providers.${name}`)]));
  }
  let github: SimWorldSpec['github'];
  if (value.github !== undefined) {
    const row = object(value.github, 'world.github');
    if (typeof row.repo !== 'string' || !row.repo.trim()) throw new Error('world.github.repo must be non-empty');
    if (!Number.isSafeInteger(row.openPRs) || Number(row.openPRs) < 0) throw new Error('world.github.openPRs must be a nonnegative integer');
    github = { repo: row.repo, openPRs: Number(row.openPRs) };
  }
  let seats: string[] | undefined;
  if (value.seats !== undefined) {
    if (!Array.isArray(value.seats) || value.seats.some((seat) => typeof seat !== 'string' || !seat.trim())) throw new Error('world.seats must be a list of names');
    seats = [...new Set(value.seats as string[])];
    if (seats.length !== value.seats.length) throw new Error('world.seats cannot contain duplicate names');
  }
  const events = appWorld?.events ?? value.events ?? [];
  if (!Array.isArray(events) || events.some((event) => {
    const row = event as Record<string, unknown> | null;
    return !row || typeof row.at !== 'string' || typeof row.id !== 'string';
  })) throw new Error('world.events must contain {at, id} entries');
  const devices = [...new Set([
    ...(requestedDevices as string[]),
    ...(hosts?.length ? ['fake-kubectl'] : []),
    ...((Array.isArray(value.processes) && value.processes.length > 0) || (Array.isArray(value.chaos) && value.chaos.length > 0) ? ['fake-ps'] : []),
    ...(providers && Object.keys(providers).length ? ['fake-llm'] : []),
    ...(github ? ['fake-gh'] : []),
    ...(clock ? ['fake-clock'] : []),
    ...(apps?.length ? ['fake-clock'] : []),
    ...(seats?.length ? ['mail'] : []),
  ])];
  if (!devices.length) throw new Error('world must declare at least one mock device or device-backed setting');
  const catalog = loadMockScenarioCatalog();
  for (const requestedName of devices) {
    const id = requestedName === 'fake-gh' ? 'fake-github' : requestedName === 'mail' ? 'sim-mailbox' : requestedName;
    if (!catalog.devices.some((candidate) => candidate.id === id)) throw new Error(`unknown mock device: ${requestedName}`);
  }
  const processes = parseSimWorldProcesses(value.processes, hosts);
  const chaos = parseSimChaos(value.chaos, processes, hosts);
  const injections = parseSimWorldInjections(value.injections);
  const expect = parseSimWorldExpectation(value.expect);
  if (expect && !chaos?.length) throw new Error('world.expect.recovers requires world.chaos');
  if (expect && !injections?.some((injection) => injection.ledger?.length)) {
    throw new Error('world.expect.recovers requires injected ledger rows to measure losses');
  }
  const spec: SimWorldSpec = { world: id, seed: Number(seed), devices, events: events as SimWorldSpec['events'],
    ...(injections ? { injections: [...injections] } : {}), ...(processes ? { processes: [...processes] } : {}),
    ...(chaos ? { chaos: [...chaos] } : {}), ...(expect ? { expect } : {}) };
  if (clock) spec.clock = clock;
  if (hosts) spec.hosts = hosts;
  if (providers) spec.providers = providers;
  if (github) spec.github = github;
  if (seats) spec.seats = seats;
  if (apps) spec.apps = [...apps];
  return spec;
}

/** Create only below the active explicit --test state root; production roots are never accepted. */
export async function createWorld(worldFile: string): Promise<SimWorld> {
  const testRoot = getTestStateRoot();
  if (!testRoot) throw new Error('sim worlds require an explicit --test universe');
  const physicalTestRoot = realpathSync(resolve(testRoot));
  const spec = parseSimWorld(readFileSync(resolve(worldFile), 'utf8'));
  assembleWorld({ spec });
  const simRoot = join(physicalTestRoot, 'sim');
  try {
    const info = lstatSync(simRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('sim directory escaped the test universe');
    const physicalSimRoot = realpathSync(simRoot);
    const simRel = relative(physicalTestRoot, physicalSimRoot);
    if (!simRel || simRel === '..' || simRel.startsWith(`..${sep}`) || isAbsolute(simRel)) throw new Error('sim directory escaped the test universe');
    try {
      lstatSync(join(physicalSimRoot, spec.world));
      throw new Error(`sim world already exists: ${spec.world}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const stored = createSimWorld(spec.world);
  try {
    writeFileSync(join(stored.configDir, 'world.yaml'), `${JSON.stringify(spec, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const manifestPath = join(stored.rootDir, 'world.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, declarationFormat: 'yaml' }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(manifestPath, 0o600);
    return { id: stored.id, root: stored.rootDir, spec, networkEvents: [] };
  } catch (error) {
    try { destroySimWorld(stored.id); } catch { /* preserve the original creation failure */ }
    throw error;
  }
}

function worldAppActions(
  spec: SimWorldSpec,
  assembled: AssembledWorld,
  observations: Array<{ event: string; verdict: string }>,
): WorldChaosAction[] {
  const host = assembled.appHost;
  return spec.events.flatMap((event) => event.appAction ? [{
    atMs: worldOffsetMs(event.at),
    target: `${event.appAction}:${event.slug ?? event.id}`,
    run: () => {
      if (!host || !event.slug) throw new Error(`world app event requires apps and slug: ${event.id}`);
      if (event.appAction === 'deploy') {
        if (!event.version) throw new Error(`world deploy event requires version: ${event.id}`);
        host.deploy(event.slug, event.version);
      } else {
        host.rollback(event.slug);
      }
      const response = host.fetch(`${event.slug}.app.sim.invalid`, '/index.html');
      observations.push({ event: `app-${event.appAction}-${event.slug}`, verdict: response.status === 200 ? `${response.headers['x-app-version']} ${response.headers['x-app-sha256']}` : `HTTP ${response.status}` });
    },
  }] : []);
}

function worldInjectionEvents(world: SimWorld, runId: string, injectedRows: RunLedgerEntry[]): WorldChaosScheduledEvent[] {
  return (world.spec.injections ?? []).map((injection, index) => ({
    atMs: worldOffsetMs(injection.at),
    run: (now) => {
      const result = injectAnyEvent({
        runId,
        stateRoot: world.root,
        injectionId: `inj-sim-${runId.slice(4, 16)}-${index}`,
        ledger: injection.ledger,
        logs: injection.logs,
        now,
      });
      injectedRows.push(...result.ledgerRows);
      return result;
    },
  }));
}

/** Resolve aliases against the checked-in device catalog and construct existing in-process fakes. */
export function assembleWorld(world: Pick<SimWorld, 'spec'>, clock?: SimClock): AssembledWorld {
  const catalog = loadMockScenarioCatalog();
  const devices = new Map<string, unknown>();
  const appHost = world.spec.apps?.length ? createFakeAppHost(world.spec.apps) : undefined;
  for (const requestedName of world.spec.devices) {
    const id = requestedName === 'fake-gh' ? 'fake-github' : requestedName === 'mail' ? 'sim-mailbox' : requestedName;
    const row = catalog.devices.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`unknown mock device: ${requestedName}`);
    if (devices.has(requestedName)) throw new Error(`duplicate mock device: ${requestedName}`);
    switch (id) {
      case 'fake-kubectl':
        {
          const hosts = world.spec.hosts?.length ? world.spec.hosts : [{ name: '', arch: 'amd64' as const, cpu: 1, pools: [], egress: false }];
          for (const host of hosts) {
            const name = host.name ? `${requestedName}:${host.name}` : requestedName;
            const context = host.name ? `${world.spec.world}-${host.name}-context` : `${world.spec.world}-context`;
            const node = host.name ? `${world.spec.world}-${host.name}-node` : `${world.spec.world}-node`;
            const adapter = createFakeKubectl({ context, node, arch: host.arch, cpu: host.cpu, pools: host.pools });
            adapter.setHostState({ egress: host.egress });
            devices.set(hosts.length === 1 ? requestedName : name, adapter);
          }
        }
        break;
      case 'fake-ps':
        devices.set(requestedName, createFakePsDevice({ processes: world.spec.processes ?? [] }));
        break;
      case 'fake-github':
        {
          const count = world.spec.github?.openPRs ?? 0;
          const prs = Array.from({ length: count }, (_, index) => ({
            number: index + 1, title: `Fixture PR ${index + 1}`, branch: `fixture/pr-${index + 1}`,
            createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
          }));
          devices.set(requestedName, createFakeGh({ prs, repository: world.spec.github?.repo ?? `${world.spec.world}/fixture` }));
        }
        break;
      case 'fake-llm':
        devices.set(requestedName, { enabled: testFakeLlmEnabled, response: testFakeLlmResponse, config: world.spec.providers ?? {} });
        break;
      case 'fake-ssh':
        {
          const hosts = Object.fromEntries((world.spec.hosts ?? [{ name: world.spec.world, arch: 'amd64' as const, cpu: 1, pools: [], egress: false }])
            .map((host) => [host.name, { activeSessions: 0, maxStartups: 10 }]));
          devices.set(requestedName, createFakeSsh({ hosts, ...(clock ? { clock } : {}) }));
        }
        break;
      case 'fake-clock':
        devices.set(requestedName, { withClock: withSimClock, ...(world.spec.clock ?? {}) });
        break;
      case 'fake-fleet': {
        const hosts = world.spec.hosts ?? [];
        if (!hosts.length) throw new Error('fake-fleet world adapter requires declared hosts');
        devices.set(requestedName, createFakeFleetDevice({ clusters: hosts.map((host) => ({
          host: host.name, context: `${world.spec.world}-${host.name}-context`,
          nodes: [`${world.spec.world}-${host.name}-node`],
        })) }));
        break;
      }
      case 'fake-cloud-vm':
        devices.set(requestedName, createFakeCloudVm());
        break;
      case 'world-runtime':
        devices.set(requestedName, { inject: injectAnyEvent });
        break;
      case 'pod-reuse-residue-fault':
        devices.set(requestedName, { create: createPodReuseResidueFaultFixture });
        break;
      case 'warm-pool-reuse-sim':
        devices.set(requestedName, { run: runWarmSiReuseSimulation });
        break;
      case 'sim-mailbox':
        devices.set(requestedName, createSimMailbox());
        break;
      default:
        throw new Error(`mock device has no world adapter: ${requestedName}`);
    }
  }
  return { devices, ...(appHost ? { appHost } : {}) };
}

export interface WarmPoolReuseWorldEvidence {
  readonly pass: boolean;
  readonly cleanReuse: Awaited<ReturnType<typeof runWarmSiReuseSimulation>>;
  readonly residueReuse: Awaited<ReturnType<typeof runWarmSiReuseSimulation>>;
  readonly residueBeforeCleanup: ReturnType<ReturnType<typeof createPodReuseResidueFaultFixture>['residue']>;
  readonly residueAfterCleanup: ReturnType<ReturnType<typeof createPodReuseResidueFaultFixture>['residue']>;
  readonly uncertainExecutions: readonly WarmPoolUncertainExecutionEvidence[];
  readonly uncertainEventMonkeyRows: ReturnType<typeof injectAnyEvent>['debugRows'];
  readonly productionLedgerRows: readonly RunLedgerEntry[];
  readonly recovery: WorldChaosRun;
  readonly cloudEvents: ReturnType<ReturnType<typeof createFakeCloudVm>['events']>;
}

export type WarmPoolUncertainFault = 'timeout' | 'connection-lost' | 'result-missing' | 'cleanup-unknown';

export interface WarmPoolUncertainExecutionEvidence {
  readonly fault: WarmPoolUncertainFault;
  readonly resultCode: string | undefined;
  readonly resultMessage: string | undefined;
  readonly coldJobStarts: number;
  readonly transportQuarantines: number;
  readonly providerQuarantines: number;
  readonly cleanupQuarantines: number;
  readonly cleanupStops: number;
  readonly credentialRevocations: number;
  readonly adoptions: number;
  readonly leaseReturns: number;
  readonly disposition: { readonly stage?: string; readonly prNumber?: number } | undefined;
  readonly ledgerEvents: readonly string[];
}

export async function runWarmPoolUncertainExecution(
  injectedFault: EventMonkeyDebugRow,
  runId: string,
  stateRoot: string,
  now: () => number,
): Promise<WarmPoolUncertainExecutionEvidence> {
  const fault = injectedFault.data.fault;
  const allowedFaults: readonly WarmPoolUncertainFault[] = ['timeout', 'connection-lost', 'result-missing', 'cleanup-unknown'];
  if (injectedFault.category !== 'pod.reuse' || injectedFault.event !== 'uncertain-exec-injected'
    || injectedFault.data.injected !== true || injectedFault.data.level !== 'L0'
    || injectedFault.data.phase !== 'after-dispatch' || typeof fault !== 'string'
    || !allowedFaults.includes(fault as WarmPoolUncertainFault)) {
    throw new Error('warm SI uncertain execution requires a tagged after-dispatch event-monkey L0 fault row');
  }
  const selectedFault = fault as WarmPoolUncertainFault;
  const bytes = (value: string) => new TextEncoder().encode(value);
  const payload = bytes('{"feature":"warm-pod-uncertain-exec"}');
  const credentialBundle = bytes('isolated simulated credential');
  const returned: SiWarmReturnedBytes = { terminal: bytes('{"ok":true,"stage":"pr-opened","prNumber":123}'),
    ledger: bytes('{"event":"done"}\n'), log: bytes('child finished before receipt loss\n'), artifacts: [] };
  const key = { context: 'pod-reuse-core-pool-a-context', imageDigest: `sha256:${'d'.repeat(64)}`,
    lockHash: 'e'.repeat(64), architecture: 'arm64' };
  const command: SiWarmCommand = { protocol: 'si-v1', runId, attemptId: `attempt-${selectedFault}`,
    executionKey: 'a'.repeat(64), sourceSha: 'b'.repeat(40), leaseId: `lease-${selectedFault}`, generation: 1,
    workerId: 'pod-reuse-core-worker-1', podUid: 'pod-reuse-core-pod-1', key,
    envProfile: 'si-standard-v1', deadlineAt: now() + 60_000,
    payloadSha256: siWarmSha256(payload), credentialBundleSha256: siWarmSha256(credentialBundle) };
  const reply: SiWarmReply = { protocol: 'si-v1', runId, attemptId: command.attemptId,
    executionKey: command.executionKey, sourceSha: command.sourceSha, leaseId: command.leaseId,
    generation: command.generation, workerId: command.workerId, podUid: command.podUid, key,
    envProfile: command.envProfile, payloadSha256: command.payloadSha256,
    startedAt: now(), finishedAt: now() + 100, exitCode: 0,
    terminalSha256: siWarmSha256(returned.terminal), ledgerSha256: siWarmSha256(returned.ledger),
    logSha256: siWarmSha256(returned.log), artifacts: [] };
  const pod = { context: key.context, namespace: 'elanous-test', name: 'warm-pod-reuse-core',
    podUid: command.podUid, workerId: command.workerId, sourceSha: command.sourceSha,
    imageDigest: key.imageDigest, lockHash: key.lockHash, architecture: key.architecture };
  let transportQuarantines = 0;
  let providerQuarantines = 0;
  let cleanupQuarantines = 0;
  let cleanupStops = 0;
  let credentialRevocations = 0;
  let adoptions = 0;
  let leaseReturns = 0;
  let coldJobStarts = 0;
  const ledgerEvents: string[] = [];
  const receipt = selectedFault === 'cleanup-unknown'
    ? { reply, bytes: returned, cleanup: 'unknown' as const }
    : selectedFault === 'result-missing'
      ? { reply: null, bytes: null, cleanup: 'unknown' as const }
      : { reply, bytes: returned, cleanup: 'clean' as const };
  const cleanup: ChildPodReuseOperations = {
    stopChildProcesses: async () => { cleanupStops++; return { remaining: 1 }; },
    git: async () => { throw new Error('uncertain execution must not reach worktree cleanup'); },
    removeRunCredentials: async () => { credentialRevocations++; return { remaining: 0 }; },
    returnLease: async () => { leaseReturns++; },
    quarantine: async () => { cleanupQuarantines++; },
    observe: () => {},
  };
  const attempt: SiWarmChildAttempt = { leaseFenced: true, command, transport: { pod, now,
    runner: {
      inspect: async () => pod,
      execute: async () => {
        if (selectedFault === 'timeout') throw new Error('simulated SI exec timed out after dispatch');
        if (selectedFault === 'connection-lost') throw new Error('simulated SI exec connection lost after dispatch');
        return receipt;
      },
      quarantine: async () => { transportQuarantines++; return true; },
    } }, payload, credentialBundle, cleanup,
    quarantineUnknown: async () => { providerQuarantines++; },
    adopt: async () => { adoptions++; },
  };
  const result = await podSelfImplementSpawn({
    env: { NODE_ENV: 'test', ELANOUS_STATE_DIR: stateRoot, ELANOUS_STATE_DIR_SOURCE: 'derived', ELANOUS_RUN_ID: runId },
    kubectl: () => { coldJobStarts++; return { status: 1, stdout: '', stderr: 'cold Job must not be dispatched after uncertain exec' }; },
    siWarmAttempt: async () => attempt,
    siWarmHostPostprocess: async childResult => childResult,
    siWarmLedger: entry => { ledgerEvents.push(entry.event); },
  })({ feature: 'warm Pod uncertain execution simulation', spaceId: `${runId}-${selectedFault}` }).done;
  return { fault: selectedFault, resultCode: result.error?.code, resultMessage: result.error?.message,
    coldJobStarts, transportQuarantines, providerQuarantines,
    cleanupQuarantines, cleanupStops, credentialRevocations, adoptions, leaseReturns,
    disposition: result.disposition ? { stage: result.disposition.stage,
      ...(typeof result.disposition.prNumber === 'number' ? { prNumber: result.disposition.prNumber } : {}) } : undefined,
    ledgerEvents };
}

export interface DeclaredWorldLedgerRow {
  readonly expectedAt: number;
  readonly event: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Require a one-to-one match; order is irrelevant, duplicates and extra rows fail closed. */
export function assertWorldLedgerMatchesDeclarations(
  expected: readonly DeclaredWorldLedgerRow[], actual: readonly RunLedgerEntry[], label: string,
): void {
  const compatible = expected.map((declaration) => actual.flatMap((row, index) => {
    if (row.event !== declaration.event || Date.parse(row.timestamp ?? '') !== declaration.expectedAt) return [];
    if (Object.entries(declaration.data ?? {}).some(([key, value]) => JSON.stringify(row.data[key]) !== JSON.stringify(value))) return [];
    return [index];
  }));
  const actualToExpected = new Array<number>(actual.length).fill(-1);
  const assign = (expectedIndex: number, visited: boolean[]): boolean => {
    for (const actualIndex of compatible[expectedIndex] ?? []) {
      if (visited[actualIndex]) continue;
      visited[actualIndex] = true;
      if (actualToExpected[actualIndex] === -1 || assign(actualToExpected[actualIndex]!, visited)) {
        actualToExpected[actualIndex] = expectedIndex;
        return true;
      }
    }
    return false;
  };
  const order = expected.map((_, index) => index).sort((left, right) => compatible[left]!.length - compatible[right]!.length);
  for (const expectedIndex of order) {
    if (!assign(expectedIndex, new Array<boolean>(actual.length).fill(false))) {
      const declaration = expected[expectedIndex]!;
      throw new Error(`${label}: missing or ambiguous ${declaration.event} at ${new Date(declaration.expectedAt).toISOString()}`);
    }
  }
  const unmatched = actualToExpected.flatMap((expectedIndex, actualIndex) => expectedIndex === -1 ? [actual[actualIndex]!] : []);
  if (unmatched.length) {
    const details = unmatched.map((row) => `${row.event}@${row.timestamp ?? '<missing timestamp>'}`).join(', ');
    throw new Error(`${label}: ${unmatched.length} undeclared production ledger row(s): ${details}`);
  }
}

export function assertWarmPoolReuseSchedule(cleanAtMs: number, faultAtMs: number, faultEndsAtMs: number,
  recoveryAtMs: number, residueAtMs: number): void {
  if (!(cleanAtMs < faultAtMs && faultAtMs < recoveryAtMs && faultEndsAtMs <= recoveryAtMs && recoveryAtMs < residueAtMs)) {
    throw new Error('world schedule must acquire pool-a before its outage, observe recovery after it ends, and inject residue after recovery');
  }
}

/** Executes scheduled SI reuse and residue faults on one isolated world's fake clock. */
export async function runWarmPoolReuseWorldScenario(world: SimWorld): Promise<WarmPoolReuseWorldEvidence> {
  const testRoot = getTestStateRoot();
  if (!testRoot) throw new Error('sim worlds require an explicit --test universe');
  const owned = loadWorld(world.id);
  if (resolve(world.root) !== owned.root || JSON.stringify(world.spec) !== JSON.stringify(owned.spec)) {
    throw new Error('world root is not owned by the test universe');
  }
  const assembled = assembleWorld(owned);
  const required = ['fake-clock', 'fake-fleet', 'fake-cloud-vm', 'warm-pool-reuse-sim', 'world-runtime', 'pod-reuse-residue-fault'];
  for (const device of required) if (!owned.spec.devices.includes(device)) throw new Error(`warm pool reuse world requires device ${device}`);
  if (owned.spec.events.length !== 4 || !owned.spec.events.some((event) => event.id === 'reuse-clean')
    || !owned.spec.events.some((event) => event.id === 'reuse-recovery')
    || !owned.spec.events.some((event) => event.id === 'reuse-residue')
    || !owned.spec.events.some((event) => event.id === 'reuse-uncertain') || !owned.spec.hosts?.length) {
    throw new Error('warm pool reuse world must schedule clean, recovery, residue, and uncertain-exec events on declared hosts');
  }
  const cleanAtMs = worldOffsetMs(owned.spec.events.find((event) => event.id === 'reuse-clean')!.at);
  const recoveryAtMs = worldOffsetMs(owned.spec.events.find((event) => event.id === 'reuse-recovery')!.at);
  const hostFault = owned.spec.chaos?.find((fault) => 'gorilla' in fault && fault.gorilla.host === 'pool-a');
  if (!hostFault || !('gorilla' in hostFault)) throw new Error('warm pool reuse world requires a pool-a gorilla outage');
  const faultAtMs = worldOffsetMs(hostFault.at);
  const faultEndsAtMs = faultAtMs + worldOffsetMs(hostFault.gorilla.for);
  const residueAtMs = worldOffsetMs(owned.spec.events.find((event) => event.id === 'reuse-residue')!.at);
  assertWarmPoolReuseSchedule(cleanAtMs, faultAtMs, faultEndsAtMs, recoveryAtMs, residueAtMs);
  for (const name of ['pool-a', 'pool-b']) if (!owned.spec.hosts!.some((host) => host.name === name)) {
    throw new Error(`warm pool reuse world is missing host ${name}`);
  }
  const clockDevice = assembled.devices.get('fake-clock') as { withClock: typeof withSimClock };
  const fleet = assembled.devices.get('fake-fleet') as ReturnType<typeof createFakeFleetDevice>;
  const cloud = assembled.devices.get('fake-cloud-vm') as ReturnType<typeof createFakeCloudVm>;
  const runtime = assembled.devices.get('world-runtime') as { inject: typeof injectAnyEvent };
  const residueDevice = assembled.devices.get('pod-reuse-residue-fault') as { create: typeof createPodReuseResidueFaultFixture };
  const reuseDevice = assembled.devices.get('warm-pool-reuse-sim') as { run: typeof runWarmSiReuseSimulation };
  const baseTimeMs = Date.parse(owned.spec.clock?.start ?? '2100-01-01T00:00:00.000Z');
  if (!Number.isFinite(baseTimeMs)) throw new Error('world clock start must be a valid timestamp');
  const cloudVmIds: Record<string, string> = {};
  return clockDevice.withClock(new Date(baseTimeMs), async (clock) => {
    for (const host of owned.spec.hosts!) {
      const id = `${owned.spec.world}-${host.name}-vm`;
      cloudVmIds[host.name] = id;
      cloud.createFromImage({ id, imageDigest: `sha256:${'d'.repeat(64)}`, hourlyCost: 1 });
      cloud.openLease(id);
    }
    const runId = `run-${owned.spec.world}-reuse`;
    const expectedRows: RunLedgerEntry[] = [];
    let releaseActiveLease: () => void = () => {};
    let signalActiveLease: () => void = () => {};
    const activeLeaseReady = new Promise<void>((resolve) => { signalActiveLease = resolve; });
    const resumeAfterHostLoss = new Promise<void>((resolve) => { releaseActiveLease = resolve; });
    let cleanReuseTask: Promise<Awaited<ReturnType<typeof runWarmSiReuseSimulation>>> | undefined;
    let cleanReuse: Awaited<ReturnType<typeof runWarmSiReuseSimulation>> | undefined;
    let residueReuse: Awaited<ReturnType<typeof runWarmSiReuseSimulation>> | undefined;
    const uncertainExecutions: WarmPoolUncertainExecutionEvidence[] = [];
    let uncertainEventMonkeyRows: ReturnType<typeof injectAnyEvent>['debugRows'] = [];
    let residueBeforeCleanup: ReturnType<ReturnType<typeof createPodReuseResidueFaultFixture>['residue']> | undefined;
    let residueAfterCleanup: ReturnType<ReturnType<typeof createPodReuseResidueFaultFixture>['residue']> | undefined;
    const available = (host: string) => fleet.hostOnline(host === 'pool-host-b' ? 'pool-b' : 'pool-a');
    const verifyDeclaredOutput = (index: number, rows: readonly RunLedgerEntry[]) => {
      const declared = owned.spec.injections?.[index];
      if (!declared) throw new Error(`scheduled world event ${owned.spec.events[index]?.id} lacks output declaration`);
      const expectedAt = baseTimeMs + worldOffsetMs(declared.at);
      const actualRows = rows.filter((row) => Date.parse(row.timestamp ?? '') === expectedAt);
      assertWorldLedgerMatchesDeclarations((declared.ledger ?? []).map((row) => ({ expectedAt, event: row.event, data: row.data })),
        actualRows, `scheduled event ${owned.spec.events[index]?.id}`);
    };
    const scheduledEvents: WorldChaosScheduledEvent[] = owned.spec.events.map((event, index) => ({
      atMs: worldOffsetMs(event.at),
      run: async (now) => {
        const injectionId = `inj-${owned.spec.world}-${index + 1}`;
        const declared = owned.spec.injections?.[index];
        if (!declared || worldOffsetMs(declared.at) !== worldOffsetMs(event.at)) {
          throw new Error(`scheduled world event ${event.id} must have a same-time output declaration`);
        }
        if (event.id === 'reuse-uncertain') {
          const faultLogs = declared.logs ?? [];
          const allowedFaults: readonly WarmPoolUncertainFault[] = ['timeout', 'connection-lost', 'result-missing', 'cleanup-unknown'];
          if (faultLogs.length !== allowedFaults.length) {
            throw new Error('reuse-uncertain must inject exactly one timeout, connection-lost, result-missing, and cleanup-unknown event');
          }
          const injection = runtime.inject({ runId, stateRoot: owned.root, injectionId, logs: faultLogs, now });
          uncertainEventMonkeyRows = injection.debugRows;
          const injectedFaults = injection.debugRows.map((row) => {
            const fault = row.data.fault;
            if (row.category !== 'pod.reuse' || row.event !== 'uncertain-exec-injected'
              || row.data.injected !== true || row.data.level !== 'L0' || row.data.phase !== 'after-dispatch'
              || typeof fault !== 'string' || !allowedFaults.includes(fault as WarmPoolUncertainFault)) {
              throw new Error('reuse-uncertain event-monkey row must be a tagged after-dispatch fault');
            }
            return fault as WarmPoolUncertainFault;
          });
          if (allowedFaults.some((fault) => injectedFaults.filter((candidate) => candidate === fault).length !== 1)) {
            throw new Error('reuse-uncertain must inject exactly one timeout, connection-lost, result-missing, and cleanup-unknown event');
          }
          for (const fault of injectedFaults) {
            const row = injection.debugRows.find((candidate) => candidate.data.fault === fault)!;
            uncertainExecutions.push(await runWarmPoolUncertainExecution(row,
              `${runId}-uncertain-${fault}`, owned.root, () => clock.now()));
          }
          verifyDeclaredOutput(index, []);
          return injection;
        } else if (event.id === 'reuse-clean') {
          cleanReuseTask = reuseDevice.run({ runId: `${runId}-clean`, now: () => clock.now(), stateRoot: owned.root,
            ledgerRunId: runId, ledgerRowPrefix: injectionId, includeAlternateHost: true, recoverOnAlternateHost: true,
            hostAvailable: available,
            hostArchitectures: {
              'pool-host-a': owned.spec.hosts!.find((host) => host.name === 'pool-a')!.arch,
              'pool-host-b': owned.spec.hosts!.find((host) => host.name === 'pool-b')!.arch,
            },
            afterAcquireAtLease: 2,
            afterAcquire: async (host) => {
              signalActiveLease();
              if (host !== 'pool-host-a') throw new Error(`active SI lease unexpectedly started on ${host}`);
              await resumeAfterHostLoss;
            },
          }).catch((error) => { signalActiveLease(); throw error; });
          await activeLeaseReady;
          verifyDeclaredOutput(index, loadRunLedger(runId, runLedgerDir(owned.root)) ?? []);
        } else if (event.id === 'reuse-recovery') {
          if (!cleanReuseTask) throw new Error('reuse-recovery scheduled before reuse-clean started');
          cleanReuse = await cleanReuseTask;
          expectedRows.push(...cleanReuse.ledgerRows);
          verifyDeclaredOutput(index, cleanReuse.ledgerRows);
        } else if (event.id === 'reuse-residue') {
          const fixture = residueDevice.create();
          try {
            fixture.inject(`${owned.spec.world}-residue`);
            residueBeforeCleanup = fixture.residue();
            residueReuse = await reuseDevice.run({ runId: `${runId}-residue`, now: () => clock.now(), stateRoot: owned.root,
              ledgerRunId: runId, ledgerRowPrefix: injectionId, residueFixture: fixture, hostAvailable: available });
            expectedRows.push(...residueReuse.ledgerRows);
            residueAfterCleanup = fixture.residue();
          } finally { fixture.cleanup(); }
        } else throw new Error(`unsupported warm pool reuse world event: ${event.id}`);
        if (event.id === 'reuse-residue') verifyDeclaredOutput(index, residueReuse!.ledgerRows);
        const result = runtime.inject({ runId, stateRoot: owned.root, injectionId,
          logs: [{ category: 'pod.reuse', event: event.id, data: { scheduledAt: now().toISOString() } }], now });
        return result;
      },
    }));
    const processTable = assembled.devices.get('fake-ps') as FakePsDevice;
    const hostChaos = createWorldHostChaosController({ world: owned.spec.world, hosts: owned.spec.hosts!,
      devices: assembled.devices, baseTimeMs, clock, processTable, fleet, cloudVm: cloud, cloudVmIds,
      onFaultStart: (host) => { if (host === 'pool-a') releaseActiveLease(); },
      awaitActiveRecovery: async (host) => {
        if (host !== 'pool-a' || !cleanReuseTask) return;
        if (!cleanReuse) {
          cleanReuse = await cleanReuseTask;
          expectedRows.push(...cleanReuse.ledgerRows);
        }
      },
    });
    let recovery: WorldChaosRun;
    try {
      recovery = await runWorldChaosSchedule(owned.spec.chaos ?? [], owned.spec.processes ?? [],
        owned.spec.expect?.recovers, { runId, stateRoot: owned.root, expectedRows },
        scheduledEvents, clock, baseTimeMs, hostChaos, processTable);
    } finally {
      // A malformed/failed schedule must not strand the leased child behind its outage barrier.
      releaseActiveLease();
      await cleanReuseTask?.catch(() => undefined);
    }
    const productionLedgerRows = loadRunLedger(runId, runLedgerDir(owned.root)) ?? [];
    const allDeclarations = (owned.spec.injections ?? []).flatMap((declaration) =>
      (declaration.ledger ?? []).map((row) => ({ expectedAt: baseTimeMs + worldOffsetMs(declaration.at), event: row.event, data: row.data })));
    assertWorldLedgerMatchesDeclarations(allDeclarations, productionLedgerRows, 'world production ledger');
    const pass = Boolean(cleanReuse && cleanReuse.cleanupOutcomes.join(',') === 'returned,quarantined,returned'
      && cleanReuse.leaseGenerations[0] === 1 && cleanReuse.leaseGenerations[1] === 2
      && cleanReuse.podUids[0] === cleanReuse.podUids[1]
      && cleanReuse.leaseHosts.join(',') === 'pool-host-a,pool-host-a,pool-host-b' && cleanReuse.recoveryHost === 'pool-host-b'
      && residueReuse?.cleanupOutcomes.at(-1) === 'quarantined'
      && residueReuse.retryAcquire === 'no-entry:busy'
      && residueBeforeCleanup?.credentials.length === 1 && residueBeforeCleanup.processes.length === 1
      && uncertainExecutions.length === 4
      && uncertainExecutions.every((item) => item.resultCode === 'si-warm-reconcile-only'
        && item.coldJobStarts === 0 && item.adoptions === 0 && item.leaseReturns === 0
        && item.ledgerEvents.includes('pod-reuse-quarantined'))
      && uncertainExecutions.find((item) => item.fault === 'timeout')?.providerQuarantines === 1
      && uncertainExecutions.find((item) => item.fault === 'connection-lost')?.providerQuarantines === 1
      && uncertainExecutions.find((item) => item.fault === 'result-missing')?.cleanupQuarantines === 1
      && uncertainExecutions.find((item) => item.fault === 'cleanup-unknown')?.disposition?.stage === 'pr-opened'
      && uncertainExecutions.find((item) => item.fault === 'cleanup-unknown')?.disposition?.prNumber === 123
      && uncertainEventMonkeyRows.length === 4
      && uncertainEventMonkeyRows.every((row) => row.data.injected === true && row.data.level === 'L0')
      && recovery.evaluation?.pass);
    return { pass, cleanReuse: cleanReuse!, residueReuse: residueReuse!, residueBeforeCleanup: residueBeforeCleanup!,
      residueAfterCleanup: residueAfterCleanup!, uncertainExecutions, uncertainEventMonkeyRows,
      productionLedgerRows, recovery, cloudEvents: cloud.events() };
  });
}

/** Defense-in-depth API guards inside the sandboxed scenario executor. */
export async function runInWorld<T>(world: SimWorld, run: (runtime: WorldExecutionRuntime) => Promise<T>): Promise<T> {
  if (activeNetworkWorld) throw new Error('sim worlds run serially while the network guard is installed');
  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpGet = http.get;
  const originalHttpsRequest = https.request;
  const originalHttpsGet = https.get;
  const originalNetConnect = net.connect;
  const originalNetCreateConnection = net.createConnection;
  const originalNetCreateServer = net.createServer;
  const originalSocketConnect = net.Socket.prototype.connect;
  const originalHttpCreateServer = http.createServer;
  const originalHttpsCreateServer = https.createServer;
  const originalTlsConnect = tls.connect;
  const originalDgramCreateSocket = dgram.createSocket;
  const originalDnsLookup = dns.lookup;
  const originalDnsResolve = dns.resolve;
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  const originalExec = childProcess.exec;
  const originalExecSync = childProcess.execSync;
  const originalExecFile = childProcess.execFile;
  const originalExecFileSync = childProcess.execFileSync;
  const originalFork = childProcess.fork;
  const originalDnsPromiseLookup = dnsPromises.lookup;
  const originalDnsPromiseResolve = dnsPromises.resolve;
  const bunRuntime = (globalThis as { Bun?: typeof Bun }).Bun;
  const originalBunSpawn = bunRuntime?.spawn;
  const originalBunSpawnSync = bunRuntime?.spawnSync;
  const blocked = (url: string): never => {
    world.networkEvents.push({ url, blocked: true });
    throw new Error(`sim network blocked: ${url}`);
  };
  const allowHost = (_host: string): boolean => false;
  const requestUrl = (input: unknown, protocol: 'http:' | 'https:'): URL => {
    if (input instanceof URL) return input;
    if (typeof input === 'string') return new URL(input, `${protocol}//localhost`);
    const options = input && typeof input === 'object' ? input as { hostname?: string; host?: string; port?: number; protocol?: string; path?: string } : {};
    const hostname = options.hostname ?? options.host ?? 'localhost';
    const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
    return new URL(`${options.protocol ?? protocol}//${host}${options.port ? `:${options.port}` : ''}${options.path ?? '/'}`);
  };
  activeNetworkWorld = world;
  const guardedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!allowHost(url.hostname)) return blocked(url.toString());
    return originalFetch(input, init);
  }) as typeof fetch;
  const guardRequest = (protocol: 'http:' | 'https:', original: typeof http.request): typeof http.request => ((...args: Parameters<typeof http.request>) => {
    const url = requestUrl(args[0], protocol);
    const override = args[1] && typeof args[1] === 'object' ? args[1] as { hostname?: string; host?: string } : undefined;
    const target = override?.hostname ?? override?.host;
    if (target && !allowHost(target)) return blocked(`${protocol}//${target}`);
    if (!allowHost(url.hostname)) return blocked(url.toString());
    return original(...args);
  }) as typeof http.request;
  const guardSocketArgs = (args: unknown[]): void => {
    const first = args[0];
    if (typeof first === 'string' && first.startsWith('/')) blocked(`unix://${first}`);
    const options = first && typeof first === 'object' ? first as { host?: string; hostname?: string; path?: string } : undefined;
    if (options?.path) blocked(`unix://${options.path}`);
    const host = options?.host ?? options?.hostname ?? (typeof first === 'number' ? (typeof args[1] === 'string' ? args[1] : 'localhost') : 'localhost');
    if (!allowHost(host)) blocked(`tcp://${host}`);
  };
  const guardedConnect = ((...args: Parameters<typeof net.connect>) => {
    guardSocketArgs(args as unknown[]);
    return originalNetConnect(...args);
  }) as typeof net.connect;
  const guardedCreateConnection = ((...args: Parameters<typeof net.createConnection>) => {
    guardSocketArgs(args as unknown[]);
    return originalNetCreateConnection(...args);
  }) as typeof net.createConnection;
  const guardedSocketConnect = (function (this: net.Socket, ...args: Parameters<typeof net.Socket.prototype.connect>) {
    const first = args[0];
    if (typeof first === 'string' && first.startsWith('/')) return blocked(`unix://${first}`);
    const options = first && typeof first === 'object' ? first as { host?: string; hostname?: string; path?: string } : undefined;
    if (options?.path) return blocked(`unix://${options.path}`);
    const host = options?.host ?? options?.hostname ?? (typeof first === 'number' ? (typeof args[1] === 'string' ? args[1] : 'localhost') : 'localhost');
    if (!allowHost(host)) return blocked(`tcp://${host}`);
    return originalSocketConnect.apply(this, args);
  }) as typeof net.Socket.prototype.connect;
  const guardedTlsConnect = ((...args: Parameters<typeof tls.connect>) => {
    const first = args[0];
    const options = first && typeof first === 'object' ? first as { host?: string; hostname?: string; socket?: unknown } : undefined;
    const host = options?.host ?? options?.hostname ?? 'localhost';
    if (!allowHost(host) || options?.socket) return blocked(`tls://${host}`);
    return originalTlsConnect(...args);
  }) as typeof tls.connect;
  const guardedHttpGet = ((...args: Parameters<typeof http.get>) => {
    const url = requestUrl(args[0], 'http:');
    if (!allowHost(url.hostname)) return blocked(url.toString());
    return originalHttpGet(...args);
  }) as typeof http.get;
  const guardedHttpsGet = ((...args: Parameters<typeof https.get>) => {
    const url = requestUrl(args[0], 'https:');
    if (!allowHost(url.hostname)) return blocked(url.toString());
    return originalHttpsGet(...args);
  }) as typeof https.get;
  const guardedNetServer = ((..._args: Parameters<typeof net.createServer>) => blocked('listen://tcp')) as typeof net.createServer;
  const guardedHttpServer = ((..._args: Parameters<typeof http.createServer>) => blocked('listen://http')) as typeof http.createServer;
  const guardedHttpsServer = ((..._args: Parameters<typeof https.createServer>) => blocked('listen://https')) as typeof https.createServer;
  try {
    globalThis.fetch = guardedFetch;
    http.request = guardRequest('http:', originalHttpRequest);
    http.get = guardedHttpGet;
    https.request = guardRequest('https:', originalHttpsRequest as typeof http.request) as typeof https.request;
    https.get = guardedHttpsGet;
    net.connect = guardedConnect;
    net.createConnection = guardedCreateConnection;
    net.createServer = guardedNetServer;
    net.Socket.prototype.connect = guardedSocketConnect;
    http.createServer = guardedHttpServer;
    https.createServer = guardedHttpsServer;
    tls.connect = guardedTlsConnect;
    dgram.createSocket = ((..._args: Parameters<typeof dgram.createSocket>) => blocked('udp://socket')) as unknown as typeof dgram.createSocket;
    dns.lookup = ((hostname: string, ..._args: unknown[]) => blocked(`dns://${hostname}`)) as unknown as typeof dns.lookup;
    dns.resolve = ((hostname: string, ..._args: unknown[]) => blocked(`dns://${hostname}`)) as unknown as typeof dns.resolve;
    childProcess.spawn = ((command: string, ..._args: unknown[]) => blocked(`process://${command}`)) as typeof childProcess.spawn;
    childProcess.spawnSync = ((command: string, ..._args: unknown[]) => blocked(`process://${command}`)) as typeof childProcess.spawnSync;
    childProcess.exec = ((command: string, ..._args: unknown[]) => blocked(`process://${command}`)) as unknown as typeof childProcess.exec;
    childProcess.execSync = ((command: string, ..._args: unknown[]) => blocked(`process://${command}`)) as typeof childProcess.execSync;
    childProcess.execFile = ((file: string, ..._args: unknown[]) => blocked(`process://${file}`)) as unknown as typeof childProcess.execFile;
    childProcess.execFileSync = ((file: string, ..._args: unknown[]) => blocked(`process://${file}`)) as typeof childProcess.execFileSync;
    childProcess.fork = ((modulePath: string, ..._args: unknown[]) => blocked(`process://${modulePath}`)) as typeof childProcess.fork;
    dnsPromises.lookup = ((hostname: string, ..._args: unknown[]) => blocked(`dns://${hostname}`)) as unknown as typeof dnsPromises.lookup;
    dnsPromises.resolve = ((hostname: string, ..._args: unknown[]) => blocked(`dns://${hostname}`)) as unknown as typeof dnsPromises.resolve;
    if (bunRuntime) {
      bunRuntime.spawn = ((command: string | string[]) => blocked(`process://${Array.isArray(command) ? command[0] : command}`)) as unknown as typeof bunRuntime.spawn;
      bunRuntime.spawnSync = ((command: string | string[]) => blocked(`process://${Array.isArray(command) ? command[0] : command}`)) as unknown as typeof bunRuntime.spawnSync;
    }
    const runPromotionPython: WorldExecutionRuntime['runPromotionPython'] = (source, home, env) => {
      const physicalRoot = realpathSync(world.root);
      const requestedHome = resolve(home);
      const rel = relative(physicalRoot, requestedHome);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('promotion script home escaped its simulated world');
      if (!isTrustedPromotionPythonBody(source)) throw new Error('world runner refused untrusted promotion Python body');
      const guardedBunSpawnSync = bunRuntime?.spawnSync;
      if (bunRuntime && originalBunSpawnSync) bunRuntime.spawnSync = originalBunSpawnSync;
      let child: ReturnType<typeof childProcess.spawnSync>;
      try {
        child = spawnSyncForPromotion('/usr/bin/python3', ['-'], { cwd: physicalRoot, input: source, encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin', HOME: requestedHome, NODE_ENV: 'test', ...env } });
      } finally {
        if (bunRuntime && guardedBunSpawnSync) bunRuntime.spawnSync = guardedBunSpawnSync;
      }
      return { status: child.status, stdout: String(child.stdout ?? ''), stderr: String(child.stderr ?? child.error ?? '') };
    };
    return await run({ runPromotionPython });
  }
  finally {
    globalThis.fetch = originalFetch;
    http.request = originalHttpRequest;
    http.get = originalHttpGet;
    https.request = originalHttpsRequest;
    https.get = originalHttpsGet;
    net.connect = originalNetConnect;
    net.createConnection = originalNetCreateConnection;
    net.createServer = originalNetCreateServer;
    net.Socket.prototype.connect = originalSocketConnect;
    http.createServer = originalHttpCreateServer;
    https.createServer = originalHttpsCreateServer;
    tls.connect = originalTlsConnect;
    dgram.createSocket = originalDgramCreateSocket;
    dns.lookup = originalDnsLookup;
    dns.resolve = originalDnsResolve;
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
    childProcess.exec = originalExec;
    childProcess.execSync = originalExecSync;
    childProcess.execFile = originalExecFile;
    childProcess.execFileSync = originalExecFileSync;
    childProcess.fork = originalFork;
    dnsPromises.lookup = originalDnsPromiseLookup;
    dnsPromises.resolve = originalDnsPromiseResolve;
    if (bunRuntime && originalBunSpawn) bunRuntime.spawn = originalBunSpawn;
    if (bunRuntime && originalBunSpawnSync) bunRuntime.spawnSync = originalBunSpawnSync;
    activeNetworkWorld = undefined;
  }
}

/** First registered A2b event: stale release lock is fixture input to the real readiness path. */
export async function executeWorldScenario(world: SimWorld, scenarioFile: string): Promise<WorldScenarioResult> {
  if (process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED !== '1') throw new Error('scenario execution requires the OS network sandbox');
  const ownedWorld = loadWorld(world.id);
  let physicalSuppliedRoot: string;
  try { physicalSuppliedRoot = realpathSync(resolve(world.root)); }
  catch { throw new Error('world root is not owned by the test universe'); }
  if (physicalSuppliedRoot !== ownedWorld.root || JSON.stringify(world.spec) !== JSON.stringify(ownedWorld.spec)) {
    throw new Error('world root is not owned by the test universe');
  }
  world = ownedWorld;
  return runInWorld(world, async (runtime) => {
    const assembled = assembleWorld(world);
    const scenario = object(parseYaml(readFileSync(resolve(scenarioFile), 'utf8')), 'scenario');
    if (scenario.world !== world.id || !Array.isArray(scenario.steps)) throw new Error('scenario must target its declared world and list steps');
    const steps = scenario.steps.map((step) => object(step, 'scenario step'));
    const stepKeys = steps.map((step) => Object.keys(step).sort().join(','));
    if (steps.length === 2 && stepKeys[0] === 'inject' && stepKeys[1] === 'observe'
      && object(steps[0]!.inject, 'scenario inject').id === 'gate-roster-second-pool') {
      if (steps[1]?.observe !== 'gate-roster-second-pool') throw new Error('gate roster scenario must observe gate-roster-second-pool');
      const event = object(steps[0]!.inject, 'scenario inject');
      if (Object.keys(event).sort().join(',') !== 'id') throw new Error('gate roster scenario accepts only its registered world events');
      const declarations = world.spec.events.filter((entry) => Object.hasOwn(GATE_ROSTER_WORLD_CASES, entry.id));
      const expectedIds = Object.keys(GATE_ROSTER_WORLD_CASES);
      if (declarations.length !== expectedIds.length || expectedIds.some((id) => !declarations.some((entry) => entry.id === id))) {
        throw new Error('gate roster world must declare all five registered gate-roster events');
      }
      const expected = object(scenario.expect, 'scenario.expect');
      if (Object.keys(expected).join(',') !== 'observations' || !Array.isArray(expected.observations)) {
        throw new Error('gate roster expectation must contain the exact observations stream');
      }
      const expectedObservations = expected.observations.map((row) => {
        const item = object(row, 'scenario.expect.observations[]');
        const allowed = ['completedFiles', 'event', 'gateError', 'gateOutcome', 'placements', 'reassignments', 'verdict'];
        if (Object.keys(item).some((key) => !allowed.includes(key)) || typeof item.event !== 'string'
          || typeof item.verdict !== 'string' || typeof item.gateOutcome !== 'string'
          || ('gateError' in item && item.gateError !== null && typeof item.gateError !== 'string')) {
          throw new Error('gate roster expected observation requires event, verdict, gateOutcome, and only known evidence fields');
        }
        return item;
      });
      const runId = `run-gate-roster-${randomUUID()}`;
      const observations: WorldScenarioResult['observations'] = [];
      const { simGateRosterSecondPool } = await import('./gate-roster-second-pool.js');
      const runtimeDevice = assembled.devices.get('world-runtime') as { inject?: typeof injectAnyEvent } | undefined;
      if (!runtimeDevice?.inject) throw new Error('gate roster world requires the world-runtime device');
      const baseTimeMs = Date.parse(world.spec.clock?.start ?? '2100-01-01T00:00:00.000Z');
      if (!Number.isFinite(baseTimeMs)) throw new Error('world clock start must be a valid timestamp');
      const actions: WorldChaosAction[] = declarations.map((declaration, index) => {
        const gateCase = GATE_ROSTER_WORLD_CASES[declaration.id]!;
        return {
          atMs: worldOffsetMs(declaration.at), target: `gate-roster:${declaration.id}`,
          run: async (now) => {
            const injectionId = `inj-${runId.slice(4, 16)}-${index}`;
            runtimeDevice.inject!({ runId, stateRoot: world.root, injectionId, now,
              ledger: [{ event: 'gate-roster-world-event-injected', data: { worldEvent: declaration.id, scenario: gateCase.scenario } }],
              logs: [{ category: 'release.gate-roster', event: 'scenario-injected', data: { worldEvent: declaration.id, scenario: gateCase.scenario } }] });
            observations.push({ event: `${declaration.id}:injected`, verdict: 'injected', gateOutcome: 'not-run' });
            const result = await simGateRosterSecondPool(gateCase.scenario, world.root);
            const verdict = result.verdict === gateCase.verdict ? result.verdict : `unexpected:${result.verdict}`;
            observations.push({ event: declaration.id, verdict, gateOutcome: result.gateOutcome, gateError: result.gateError,
              ...(result.reassignments.length ? { placements: result.placements, reassignments: result.reassignments,
                completedFiles: result.completedFiles } : {}) });
          },
        };
      });
      const recovery = await runWorldChaosSchedule([], [], undefined, undefined, [], undefined, baseTimeMs, undefined, undefined, actions);
      const pass = JSON.stringify(observations) === JSON.stringify(expectedObservations);
      return { pass, observations, devices: [...assembled.devices.keys()], recovery };
    }
    if (steps.length === 1 && stepKeys[0] === 'observe' && steps[0]?.observe === 'app-host') {
      if (!world.spec.apps?.length) throw new Error('app-host observation requires world.apps');
      const clockDevice = assembled.devices.get('fake-clock') as { withClock?: typeof withSimClock } | undefined;
      if (!clockDevice?.withClock) throw new Error('app-host scenario requires the fake-clock device');
      const baseTimeMs = Date.parse(world.spec.clock?.start ?? '2100-01-01T00:00:00.000Z');
      const runId = `run-${randomUUID()}`;
      const observations = worldWatchObservations(world, runId);
      const injectedRows: RunLedgerEntry[] = [];
      const scheduledInjections = worldInjectionEvents(world, runId, injectedRows);
      const hasLedgerInjections = world.spec.injections?.some((injection) => injection.ledger?.length) ?? false;
      const processTable = assembled.devices.get('fake-ps') as FakePsDevice | undefined;
      const appActions = worldAppActions(world.spec, assembled, observations);
      const scheduled = (world.spec.chaos?.length ?? 0) > 0 || scheduledInjections.length > 0 || appActions.length > 0;
      const recovery = await clockDevice.withClock(new Date(baseTimeMs), (clock) => {
        const hostChaos = world.spec.chaos?.some((fault) => 'gorilla' in fault)
          ? createWorldHostChaosController({ world: world.spec.world, hosts: world.spec.hosts ?? [], devices: assembled.devices,
            baseTimeMs, clock, processTable: processTable! })
          : undefined;
        return runWorldChaosSchedule(world.spec.chaos ?? [], world.spec.processes ?? [], world.spec.expect?.recovers,
          hasLedgerInjections ? { runId, stateRoot: world.root, expectedRows: injectedRows } : undefined,
          scheduledInjections, clock, baseTimeMs, hostChaos, processTable, appActions);
      });
      return { pass: recovery.evaluation?.pass ?? true, observations, devices: [...assembled.devices.keys()], ...(scheduled ? { recovery } : {}) };
    }
    if (steps.length === 1 && stepKeys[0] === 'observe' && steps[0]?.observe === 'app-demo-1114') {
      const demo = object(scenario.demo, 'scenario.demo');
      if (typeof demo.transcript !== 'string' || !demo.transcript.trim() || typeof demo.recording !== 'string' || !demo.recording.trim()) {
        throw new Error('app-demo-1114 requires demo.transcript and demo.recording fixtures');
      }
      const appHost = assembled.appHost;
      if (!appHost || !world.spec.apps?.some((app) => app.slug === 'voice-notes') || !world.spec.apps.some((app) => app.slug === 'shop-studio')) {
        throw new Error('app-demo-1114 requires voice-notes and shop-studio app declarations');
      }
      const observations: WorldScenarioResult['observations'] = [];
      const noteApp = world.spec.apps.find((app) => app.slug === 'voice-notes')!;
      const shopApp = world.spec.apps.find((app) => app.slug === 'shop-studio')!;
      const record = (event: string, verdict: string) => observations.push({ event, verdict });
      const storage = createFakeAppStorage({ rootDir: join(world.root, 'app-demo-storage'), signingKey: 'sim-only-demo-signing-key' });

      try {
        appHost.deploy('voice-notes', noteApp.versions[0]!);
        appHost.deploy('shop-studio', shopApp.versions[0]!);
        record('demo-build-and-deploy', 'pass');
        const productPage = appHost.fetch('shop-studio.app.sim.invalid', '/index.html');
        if (productPage.status !== 200) throw new Error('shop-studio product page is unavailable');
        const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw6kAAAAASUVORK5CYII=', 'base64');
        if (photo[0] !== 0x89 || photo.toString('ascii', 1, 4) !== 'PNG') throw new Error('demo product fixture is not a PNG image');
        const upload = storage.upload({ appSlug: 'shop-studio', key: 'products/demo.png', body: photo, contentType: 'image/png' });
        const storedPhoto = storage.read({ appSlug: 'shop-studio', key: 'products/demo.png' }).body;
        if (upload.status !== 201 || !storedPhoto || !Buffer.from(storedPhoto).equals(photo)) {
          throw new Error('shop-studio product photo upload did not persist within the app scope');
        }
        record('product-photo-upload', 'apps/shop-studio/products/demo.png · persisted');

        // App actions use the production dispatcher with only hermetic fake provider ports.
        const fakeSecrets = new Map([
          ['cred:openai.api_key', 'SIM-SECRET-OPENAI-DO-NOT-LEAK'],
          ['cred:elevenlabs.api_key', 'SIM-SECRET-TTS-DO-NOT-LEAK'],
          ['cred:higgsfield.key_id', 'SIM-SECRET-HIGGSFIELD-ID-DO-NOT-LEAK'],
          ['cred:higgsfield.secret', 'SIM-SECRET-HIGGSFIELD-KEY-DO-NOT-LEAK'],
        ]);
        const recording = Buffer.from(demo.recording);
        const recordingHash = createHash('sha256').update(recording).digest('hex');
        const stt = createFakeStt({ transcripts: { [recordingHash]: { text: demo.transcript, language: 'ko' } } });
        let higgsfield: ReturnType<typeof createFakeHiggsfieldRunner> | undefined;
        const actions = createAppActions({
          secrets: { async resolve({ appSlug, reference }) { return appSlug === 'voice-notes' || appSlug === 'shop-studio' ? fakeSecrets.get(reference) : undefined; } },
          async readImageObject({ appSlug, reference }) {
            const result = storage.read({ appSlug, key: reference });
            return result.status === 200 && result.body ? { bytes: result.body, mimeType: 'image/png' } : undefined;
          },
          async transcribe(input) { return stt.transcribe({ audio: input.audio, language: 'ko' }); },
          async summarize({ text }) {
            const actionItems = text.split(/[.!?。！？]/u).map((part) => part.trim()).filter((part) => /(?:해|해주|확인해)\s*주세요$/u.test(part));
            return `요약: ${text} · 할 일: ${actionItems.join(', ') || '없음'} · 태그: 회의`;
          },
          async synthesize({ text }) { return { audio: fakeElevenLabsAudioBytes(text), mimeType: 'audio/mpeg' }; },
          async generate(input) {
            if (!Buffer.from(input.image).equals(photo)) throw new Error('generation action did not receive the uploaded product photo');
            higgsfield = createFakeHiggsfieldRunner({ seed: String(world.spec.seed), deviceOptIn: true, maxSubmissions: 1,
              imageBytes: input.image, requireImageBytes: true });
            const created = await higgsfield.run(['fake-higgsfield', 'generate', 'create', '--image', 'apps/shop-studio/products/demo.png', '--prompt', input.prompt]);
            if (created.exitCode !== 0 || !created.stdout.trim()) throw new Error('fake Higgsfield job was not queued');
            return { jobId: created.stdout.trim(), eventsUrl: 'https://shop-studio.app.sim.invalid/jobs/demo/events' };
          },
        });
        const job = await actions.run({ appSlug: 'shop-studio', declaration: {
          builtin: 'generate', uses: ['cred:higgsfield.key_id', 'cred:higgsfield.secret'], async: true, spend: 'owner-confirm',
        }, payload: { text: '상품 사진으로 짧은 광고 영상을 만든다', image: 'products/demo.png', confirmSpend: true } });
        if (!('jobId' in job) || job.status !== 'queued') throw new Error('app action did not return a queued generation job');
        if (!higgsfield) throw new Error('fake Higgsfield runner was not created by the app action');
        const jobStates: string[] = [];
        for (let poll = 0; poll < 3; poll += 1) {
          const response = await higgsfield.run(['fake-higgsfield', 'generate', 'get', job.jobId, '--json']);
          if (response.exitCode !== 0) throw new Error('fake Higgsfield job polling failed');
          const result = JSON.parse(response.stdout) as { status?: unknown; result_url?: unknown };
          if (typeof result.status !== 'string') throw new Error('fake Higgsfield returned an invalid job status');
          jobStates.push(result.status);
          if (poll === 2 && typeof result.result_url !== 'string') throw new Error('completed fake Higgsfield job has no result URL');
        }
        const uploadedPhotoHash = createHash('sha256').update(photo).digest('hex');
        if (jobStates.join(',') !== 'queued,in_progress,completed' || higgsfield.ledger.submissions !== 1
          || !higgsfield.ledger.imageSha256.includes(uploadedPhotoHash)) {
          throw new Error('fake Higgsfield job did not traverse the expected bounded lifecycle');
        }
        record('higgsfield-job', `${jobStates.join(' → ')} · fake-provider submissions=${higgsfield.ledger.submissions} · external-provider-calls=${world.networkEvents.length}`);

        const transcript = await actions.run({ appSlug: 'voice-notes', declaration: { builtin: 'stt', uses: ['cred:openai.api_key'] },
          payload: { audio: recording, mimeType: 'audio/wav', filename: 'kaist-demo.wav', language: 'ko' } });
        if (!('text' in transcript) || transcript.text !== demo.transcript) throw new Error('app STT action did not consume the recording fixture');
        record('recording-and-transcription', `${transcript.language}:${transcript.text}`);
        const summary = await actions.run({ appSlug: 'voice-notes', declaration: { builtin: 'summarize', uses: ['cred:openai.api_key'] },
          payload: { text: transcript.text } });
        if (!('text' in summary) || !summary.text.includes(transcript.text) || !summary.text.includes('할 일')) {
          throw new Error('app summary action did not derive notes from the transcript');
        }
        const speech = await actions.run({ appSlug: 'voice-notes', declaration: { builtin: 'tts', uses: ['cred:elevenlabs.api_key'] },
          payload: { text: summary.text, voiceId: 'demo-voice' } });
        if (!('audioBase64' in speech) || Buffer.from(speech.audioBase64, 'base64').byteLength === 0) throw new Error('app TTS action returned no audio');
        record('summary-todos-and-tts', `transcript-derived · audio-bytes=${Buffer.from(speech.audioBase64, 'base64').byteLength}`);

        const baseVersion = noteApp.versions.at(-1)!;
        const publishedVersionId = `v3-generated-${world.spec.seed}`;
        const noteJson = JSON.stringify({ text: summary.text });
        const storedNote = storage.upload({ appSlug: 'voice-notes', key: 'notes/demo.json', body: Buffer.from(noteJson), contentType: 'application/json' });
        const noteRead = storage.read({ appSlug: 'voice-notes', key: 'notes/demo.json' });
        const persistedNote = noteRead.body ? (JSON.parse(Buffer.from(noteRead.body).toString('utf8')) as { text?: unknown }).text : undefined;
        if (storedNote.status !== 201 || persistedNote !== summary.text) throw new Error('generated note did not persist in voice-notes storage');
        const htmlEscape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
        const publishedAppsDir = join(world.root, 'published-apps', publishedVersionId);
        const publishedAppDir = join(publishedAppsDir, 'voice-notes');
        const publishedOutDir = join(publishedAppDir, 'out');
        mkdirSync(join(publishedOutDir, 'share'), { recursive: true });
        writeFileSync(join(publishedAppDir, 'app.yaml'), [
          'apiVersion: elanous.app/v0', 'slug: voice-notes', 'title: Voice notes',
          'frontend:', '  kind: static-export', '  out: out', '',
        ].join('\n'));
        writeFileSync(join(publishedOutDir, 'index.html'), `${baseVersion.files['index.html'] ?? ''}\n<!-- app-version:${publishedVersionId} -->`);
        writeFileSync(join(publishedOutDir, 'share', 'demo'),
          `<article data-app-version="${publishedVersionId}">${htmlEscape(persistedNote as string)}</article>`);
        const productionAppHost = loadNexusAppHost(publishedAppsDir, undefined, {
          dir: join(world.root, 'published-app-auth'), key: 'sim-only-demo-app-host-signing-key-at-least-256-bits-long',
        });
        if (productionAppHost.issues.length > 0 || !productionAppHost.appHost.slugs.includes('voice-notes')) {
          productionAppHost.appHost.close();
          throw new Error('Nexus app host rejected the published voice-notes artifact');
        }
        const invitation = productionAppHost.appHost.issueInvitation('voice-notes', 'sim-demo-owner');
        const accepted = await productionAppHost.appHost.handle(new Request(
          `http://voice-notes.app.localhost/__auth/accept?token=${encodeURIComponent(invitation.token)}`,
          { headers: { host: 'voice-notes.app.localhost' } },
        ));
        const sessionCookie = accepted?.headers.get('set-cookie')?.split(';', 1)[0];
        if (!accepted || accepted.status !== 303 || !sessionCookie) {
          productionAppHost.appHost.close();
          throw new Error('Nexus app host rejected the simulated share-link invitation');
        }
        const productionRequest = (path: string) => productionAppHost.appHost.handle(new Request(`http://voice-notes.app.localhost${path}`, {
          headers: { host: 'voice-notes.app.localhost', cookie: sessionCookie },
        }));
        try {
          const updated = await productionRequest('/index.html');
          const updatedBody = updated ? await updated.text() : '';
          if (!updated || updated.status !== 200 || !updatedBody.includes(`app-version:${publishedVersionId}`)) {
            throw new Error(`Nexus app host did not serve the published app version (status=${updated?.status ?? 'missing'}, marker=${updatedBody.includes(`app-version:${publishedVersionId}`)})`);
          }
          record('one-line-change-and-redeploy', `${publishedVersionId} ${createHash('sha256').update(await readFileSync(join(publishedOutDir, 'index.html'))).digest('hex')}`);
          const shared = await productionRequest('/share/demo');
          const sharedBody = shared ? await shared.text() : '';
          const sharedVersion = /data-app-version="([^"]+)"/.exec(sharedBody)?.[1];
          if (!shared || shared.status !== 200 || sharedVersion !== publishedVersionId || !sharedBody.includes(htmlEscape(persistedNote as string))) {
            throw new Error('Nexus app host did not safely serve the published transcript share page');
          }
          record('public-share-link', `http://voice-notes.app.localhost/share/demo · simulated host response=${shared.status}`);

          const output = JSON.stringify(observations);
          if ([...fakeSecrets.values()].some((secret) => output.includes(secret))) throw new Error('app demo observations leaked a credential value');
          const billing = { provider: 'fake-higgsfield' as const, spendCents: higgsfield.ledger.spendCents,
            externalNetworkAttempts: world.networkEvents.length };
          const pass = higgsfield.ledger.submissions === 1 && higgsfield.ledger.polls === 3 && billing.spendCents === 0
            && billing.externalNetworkAttempts === 0 && observations.length === 7;
          return { pass, observations, devices: [...assembled.devices.keys()], billing,
            publicShare: { status: shared.status, version: sharedVersion, body: sharedBody } };
        } finally { productionAppHost.appHost.close(); }
      } finally { storage.close(); }
    }
    if (steps.length !== 2 || stepKeys[0] !== 'inject' || stepKeys[1] !== 'observe'
      || !['release-readiness', 'hq-move', 'gate-roster-second-pool'].includes(String(steps[1]?.observe))) {
      throw new Error('scenario steps must be inject followed by observe: release-readiness, hq-move, or gate-roster-second-pool');
    }
    const injection = steps[0]!;
    const event = object(injection.inject, 'scenario inject');
    if (event.id === 'hq-move') {
      if (Object.keys(event).some((key) => key !== 'id' && key !== 'fault')) throw new Error('unsupported HQ move inject field');
      if (!world.spec.events.some((entry) => entry.id === event.id)) throw new Error('scenario event is not declared by world: hq-move');
      if (steps[1]?.observe !== 'hq-move') throw new Error('HQ move scenario must observe hq-move');
      const expected = object(scenario.expect, 'scenario.expect');
      const fault = event.fault === undefined ? 'none' : event.fault;
      if (typeof fault !== 'string' || !['none', 'target-unavailable', 'partial-copy', 'old-host-loss', 'stale-pool'].includes(fault)) {
        throw new Error(`unsupported HQ move fault: ${String(fault)}`);
      }
      if (Object.keys(expected).sort().join(',') !== 'fault' || expected.fault !== fault) throw new Error('HQ move expectation must match the injected fault');
      const runRoot = join(realpathSync(world.root), `.hq-move-${randomUUID()}`);
      const { runHqMoveSimulation } = await import('./hq-move-sim.js');
      const clockDevice = assembled.devices.get('fake-clock') as { withClock?: typeof withSimClock } | undefined;
      if (!clockDevice?.withClock) throw new Error('HQ move scenario requires the declared fake-clock device');
      const result = await clockDevice.withClock(new Date(world.spec.clock?.start ?? '2100-01-01T00:00:00.000Z'), async (clock) => {
        const runtimeAssembly = assembleWorld(world, clock);
        const ssh = runtimeAssembly.devices.get('fake-ssh') as ReturnType<typeof createFakeSsh> | undefined;
        if (!ssh) throw new Error('HQ move scenario requires the declared fake-ssh device');
        const declaration = world.spec.events.find((entry) => entry.id === event.id);
        const offset = declaration?.at.match(/^\+(\d+)(ms|s|m|h)$/);
        if (!offset) throw new Error(`unsupported HQ move event time: ${declaration?.at ?? 'missing'}`);
        clock.tick(Number(offset[1]) * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const)[offset[2] as 'ms' | 's' | 'm' | 'h']);
        const result = await runHqMoveSimulation(runRoot, fault as HqMoveFault, { ssh, clock, runPython: runtime.runPromotionPython });
        return { ...result, observations: [...result.observations,
          { event: 'world-clock', verdict: new Date(clock.now()).toISOString() }] };
      });
      return { ...result, pass: result.pass && result.fault === expected.fault };
    }
    if (steps[1]?.observe !== 'release-readiness') throw new Error('scenario observe must name a supported world event');
    if (Object.keys(event).some((key) => key !== 'id' && key !== 'version')) throw new Error('unsupported scenario inject field');
    const scenarioInput = typeof event.id === 'string' ? WORLD_EVENT_TO_SCENARIO_INPUT[event.id] : undefined;
    if (scenarioInput !== 'dead-pid-lock') throw new Error(`unsupported world event: ${String(event.id)}`);
    if (!world.spec.events.some((entry) => entry.id === event.id)) throw new Error(`scenario event is not declared by world: ${String(event.id)}`);
    const version = typeof event.version === 'string' ? event.version : '0.2.45';
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) throw new Error(`invalid release version: ${version}`);
    const physicalWorld = realpathSync(world.root);
    // Use one private root per invocation and retain it until world destroy; never unlink a lock another process may replace.
    const runRoot = join(physicalWorld, `.run-${randomUUID()}`);
    mkdirSync(runRoot, { mode: 0o700 });
    const releaseRoot = join(runRoot, 'release');
    mkdirSync(releaseRoot);
    const releaseDir = join(releaseRoot, version);
    mkdirSync(releaseDir);
    const physicalRunRoot = realpathSync(runRoot);
    const physicalReleaseDir = realpathSync(releaseDir);
    const releaseRel = relative(physicalRunRoot, physicalReleaseDir);
    if (!releaseRel || releaseRel === '..' || releaseRel.startsWith(`..${sep}`) || isAbsolute(releaseRel)) throw new Error('release path escaped its private run root');
    const lockPath = join(physicalReleaseDir, 'run.lock');
    const pid = 2_000_000_000 - (world.spec.seed % 100_000);
    const clockDevice = assembled.devices.get('fake-clock') as { withClock?: typeof withSimClock } | undefined;
    if (!clockDevice?.withClock) throw new Error('scenario requires the fake-clock device');
    const declaration = world.spec.events.find((entry) => entry.id === event.id && !entry.appAction);
    const offset = declaration?.at.match(/^\+(\d+)(ms|s|m|h)$/);
    if (!offset) throw new Error(`unsupported event time: ${declaration?.at ?? 'missing'}`);
    const eventDelay = Number(offset[1]) * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const)[offset[2] as 'ms' | 's' | 'm' | 'h'];
    return clockDevice.withClock(new Date(world.spec.clock?.start ?? '2100-01-01T00:00:00.000Z'), async (clock) => {
      const expected = object(scenario.expect, 'scenario.expect');
      const expectAlive = object(expected.livePidLock, 'scenario.expect.livePidLock');
      const expectDead = object(expected.deadPidLock, 'scenario.expect.deadPidLock');
      if (Object.keys(expected).sort().join(',') !== 'deadPidLock,livePidLock'
        || Object.keys(expectAlive).sort().join(',') !== 'ready,reason'
        || Object.keys(expectDead).sort().join(',') !== 'ready,reason') throw new Error('unsupported scenario expectation field');
      const runId = `run-${randomUUID()}`;
      const observations = worldWatchObservations(world, runId);
      const injectedRows: RunLedgerEntry[] = [];
      const scheduledInjections = worldInjectionEvents(world, runId, injectedRows);
      const baseTimeMs = Date.parse(world.spec.clock?.start ?? '2100-01-01T00:00:00.000Z');
      clock.setTime(baseTimeMs);
      const processTable = assembled.devices.get('fake-ps') as FakePsDevice | undefined;
      const hostChaos = world.spec.chaos?.some((fault) => 'gorilla' in fault)
        ? createWorldHostChaosController({ world: world.spec.world, hosts: world.spec.hosts ?? [], devices: assembled.devices, baseTimeMs, clock, processTable: processTable! })
        : undefined;
      let pass = true;
      const actions = worldAppActions(world.spec, assembled, observations);
      const includeRecovery = actions.length > 0 || scheduledInjections.length > 0 || (world.spec.chaos?.length ?? 0) > 0;
      const readiness = (isAlivePid: number | undefined) => releaseReadiness(version, {
        ledgerRoot: runRoot,
        isPidAlive: (candidate) => candidate === isAlivePid,
        now: () => new Date(clock.now()),
        checklist: () => ({ ok: true, red: [], undecided: [], blocked: [] }),
      });
      actions.push({ atMs: eventDelay, target: `release:${event.id}`, run: () => {
        writeFileSync(lockPath, `${JSON.stringify({ pid })}\n`, { mode: 0o600, flag: 'wx' });
        const alive = readiness(pid);
        const dead = readiness(undefined);
        pass = expectAlive.ready === alive.ready && expectAlive.reason === alive.reason &&
          expectDead.ready === dead.ready && expectDead.reason === dead.reason;
        observations.push({ event: 'live-pid-lock', verdict: alive.reason }, { event: 'dead-pid-lock', verdict: dead.reason });
      } });
      const recovery = await runWorldChaosSchedule(world.spec.chaos ?? [], world.spec.processes ?? [], world.spec.expect?.recovers,
        world.spec.injections?.some((injection) => injection.ledger?.length)
          ? { runId, stateRoot: world.root, expectedRows: injectedRows } : undefined,
        scheduledInjections, clock, baseTimeMs, hostChaos, processTable, actions);
      if (recovery?.evaluation && !recovery.evaluation.pass) pass = false;
      if (recovery) observations.push(...recovery.observations.map((row) => ({
        event: `chaos-${row.kind}`,
        verdict: `${row.faultVerdict} → ${row.recoveryVerdict} (${row.recoveryMs === null ? 'unrecovered' : `${row.recoveryMs}ms`})`,
      })));
      return { pass, observations, devices: [...assembled.devices.keys()], ...(includeRecovery ? { recovery } : {}) };
    });
  });
}

/** Every supported invocation crosses the OS network sandbox before scenario code runs. */
function invokeSandboxedWorldRunner(world: SimWorld, scenarioFile: string, networkProbe = false): string {
  const testRoot = getTestStateRoot();
  if (!testRoot) throw new Error('sim worlds require an explicit --test universe');
  if (process.platform !== 'darwin') throw new Error('network-zero simulation requires macOS sandbox-exec');
  const runner = resolve(import.meta.dir, '../../scripts/sim-world-runner.ts');
  const child = childProcess.spawnSync('/usr/bin/sandbox-exec', [
    '-p', '(version 1)(allow default)(deny network*)', process.execPath, runner,
  ], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, ELANOUS_SIM_WORLD_STATE_ROOT: testRoot, ELANOUS_SIM_WORLD_ID: world.id,
      ELANOUS_SIM_WORLD_SCENARIO: resolve(scenarioFile), ELANOUS_SIM_WORLD_OS_SANDBOXED: '1',
      ELANOUS_SIM_WORLD_NETWORK_PROBE: networkProbe ? '1' : '0' },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error((child.stderr || child.stdout || `sandbox runner exited ${child.status}`).trim());
  return child.stdout.trim();
}

export async function runWorldScenario(world: SimWorld, scenarioFile: string): Promise<WorldScenarioResult> {
  const output = invokeSandboxedWorldRunner(world, scenarioFile);
  let result: WorldScenarioResult;
  try { result = JSON.parse(output) as WorldScenarioResult; }
  catch { throw new Error(`sim world runner returned invalid JSON: ${output}`); }
  const completed = applyDeviceFidelity(result) as WorldScenarioResult;
  recordSimWorldCoverage({ world, deviceIds: result.devices, pass: completed.pass, scenarioFile, observations: completed.observations });
  return completed;
}

/** Integration probe through the same runner and OS policy used by runWorldScenario. */
export async function verifyWorldNetworkIsolation(world: SimWorld, scenarioFile: string): Promise<boolean> {
  const output = invokeSandboxedWorldRunner(world, scenarioFile, true);
  try { return (JSON.parse(output) as { networkBlocked?: unknown }).networkBlocked === true; }
  catch { throw new Error(`sim world network probe returned invalid JSON: ${output}`); }
}

export async function destroyWorld(world: SimWorld): Promise<void> {
  const owned = loadWorld(world.id);
  if (resolve(world.root) !== owned.root) throw new Error('refusing to destroy a world whose path does not match its id');
  if (listSimWorlds().some((candidate) => candidate.id === world.id && candidate.rootDir === owned.root)) {
    destroySimWorld(world.id);
    return;
  }
  rmSync(owned.root, { recursive: true, force: false });
}

export function loadWorld(id: string): SimWorld {
  const testRoot = getTestStateRoot();
  if (!testRoot) throw new Error('sim worlds require an explicit --test universe');
  if (!WORLD_ID.test(id)) throw new Error('world id must be lowercase letters, digits, and hyphens');
  const stored = listSimWorlds().find((candidate) => candidate.id === id);
  if (stored) {
    const manifest = JSON.parse(readFileSync(join(stored.rootDir, 'world.json'), 'utf8')) as Record<string, unknown>;
    if (manifest.declarationFormat !== 'yaml') {
      throw new Error(`sim world is not a YAML declaration: ${id}`);
    }
    const yamlPath = join(stored.configDir, 'world.yaml');
    const yamlInfo = lstatSync(yamlPath);
    if (yamlInfo.isSymbolicLink() || !yamlInfo.isFile() || (yamlInfo.mode & 0o777) !== 0o600) {
      throw new Error(`YAML world spec must be an owned 0600 file: ${yamlPath}`);
    }
    const spec = parseSimWorld(readFileSync(yamlPath, 'utf8'));
    if (spec.world !== id) throw new Error('world metadata id does not match its directory');
    return { id, root: stored.rootDir, spec, networkEvents: [] };
  }
  const physicalTestRoot = realpathSync(resolve(testRoot));
  const physicalSimRoot = realpathSync(join(physicalTestRoot, 'sim'));
  const simRel = relative(physicalTestRoot, physicalSimRoot);
  if (!simRel || simRel === '..' || simRel.startsWith(`..${sep}`) || isAbsolute(simRel)) throw new Error('sim directory escaped the test universe');
  const root = realpathSync(join(physicalSimRoot, id));
  const rel = relative(physicalSimRoot, root);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('world path escaped the test universe');
  const spec = JSON.parse(readFileSync(join(root, 'world.json'), 'utf8')) as SimWorldSpec;
  if (spec.world !== id) throw new Error('world metadata id does not match its directory');
  return { id, root, spec, networkEvents: [] };
}

export async function destroyWorldById(id: string): Promise<void> {
  await destroyWorld(loadWorld(id));
}
