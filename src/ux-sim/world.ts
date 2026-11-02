import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
import { createFakeGh } from './fake-gh.js';
import { createFakeKubectl } from './fake-kubectl.js';
import { testFakeLlmEnabled, testFakeLlmResponse } from './fake-llm.js';
import { withSimClock } from './fake-clock.js';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';
import { getTestStateRoot } from '../nexus/paths.js';
import { releaseReadiness } from '../../scripts/release-loop/release-readiness.js';

export interface SimWorldSpec {
  world: string;
  seed: number;
  devices: string[];
  clock?: { start: string; speed: number };
  hosts?: Array<{ name: string; arch: 'arm64' | 'amd64'; cpu: number; pools: string[]; egress: boolean }>;
  providers?: Record<string, Record<string, unknown>>;
  github?: { repo: string; openPRs: number };
  seats?: string[];
  events: Array<{ at: string; id: string }>;
}

export interface SimNetworkEvent { url: string; blocked: true }
export interface SimWorld {
  readonly id: string;
  readonly root: string;
  readonly spec: SimWorldSpec;
  readonly networkEvents: SimNetworkEvent[];
}

export interface AssembledWorld { devices: Map<string, unknown> }
export interface SimMailMessage { readonly from: string; readonly to: string; readonly kind: string; readonly body: string; readonly acked: boolean }
export interface SimMailbox {
  post(message: Omit<SimMailMessage, 'acked'>): number;
  list(to: string): SimMailMessage[];
  ack(to: string, id: number): void;
}
export interface WorldScenarioResult {
  pass: boolean;
  observations: Array<{ event: string; verdict: string }>;
  devices: string[];
}

const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
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
      if (typeof host.egress !== 'boolean') throw new Error(`world.hosts[${index}].egress must be boolean`);
      return { name: host.name, arch: host.arch, cpu: Number(host.cpu), pools: host.pools as string[], egress: host.egress };
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
  const events = value.events ?? [];
  if (!Array.isArray(events) || events.some((event) => {
    const row = event as Record<string, unknown> | null;
    return !row || typeof row.at !== 'string' || typeof row.id !== 'string';
  })) throw new Error('world.events must contain {at, id} entries');
  const devices = [...new Set([
    ...(requestedDevices as string[]),
    ...(hosts?.length ? ['fake-kubectl'] : []),
    ...(providers && Object.keys(providers).length ? ['fake-llm'] : []),
    ...(github ? ['fake-gh'] : []),
    ...(clock ? ['fake-clock'] : []),
    ...(seats?.length ? ['mail'] : []),
  ])];
  if (!devices.length) throw new Error('world must declare at least one mock device or device-backed setting');
  const catalog = loadMockScenarioCatalog();
  for (const requestedName of devices) {
    const id = requestedName === 'fake-gh' ? 'fake-github' : requestedName === 'mail' ? 'sim-mailbox' : requestedName;
    if (!catalog.devices.some((candidate) => candidate.id === id)) throw new Error(`unknown mock device: ${requestedName}`);
  }
  const spec: SimWorldSpec = { world: id, seed: Number(seed), devices, events: events as SimWorldSpec['events'] };
  if (clock) spec.clock = clock;
  if (hosts) spec.hosts = hosts;
  if (providers) spec.providers = providers;
  if (github) spec.github = github;
  if (seats) spec.seats = seats;
  return spec;
}

/** Create only below the active explicit --test state root; production roots are never accepted. */
export async function createWorld(worldFile: string): Promise<SimWorld> {
  const testRoot = getTestStateRoot();
  if (!testRoot) throw new Error('sim worlds require an explicit --test universe');
  const physicalTestRoot = realpathSync(resolve(testRoot));
  const absoluteFile = resolve(worldFile);
  const spec = parseSimWorld(readFileSync(absoluteFile, 'utf8'));
  assembleWorld({ spec });
  const simRoot = join(physicalTestRoot, 'sim');
  mkdirSync(simRoot, { recursive: true });
  const physicalSimRoot = realpathSync(simRoot);
  const simRel = relative(physicalTestRoot, physicalSimRoot);
  if (!simRel || simRel === '..' || simRel.startsWith(`..${sep}`) || isAbsolute(simRel)) throw new Error('sim directory escaped the test universe');
  const root = join(physicalSimRoot, spec.world);
  const rel = relative(physicalTestRoot, root);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('world path escaped the test universe');
  mkdirSync(root, { recursive: false, mode: 0o700 });
  writeFileSync(join(root, 'world.json'), `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { id: spec.world, root, spec, networkEvents: [] };
}

/** Resolve aliases against the checked-in device catalog and construct existing in-process fakes. */
export function assembleWorld(world: Pick<SimWorld, 'spec'>): AssembledWorld {
  const catalog = loadMockScenarioCatalog();
  const devices = new Map<string, unknown>();
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
            devices.set(hosts.length === 1 ? requestedName : name, adapter);
          }
        }
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
      case 'fake-clock':
        devices.set(requestedName, { withClock: withSimClock, ...(world.spec.clock ?? {}) });
        break;
      case 'sim-mailbox':
        devices.set(requestedName, createSimMailbox());
        break;
      default:
        throw new Error(`mock device has no world adapter: ${requestedName}`);
    }
  }
  return { devices };
}

/** Defense-in-depth API guards inside the sandboxed scenario executor. */
export async function runInWorld<T>(world: SimWorld, run: () => Promise<T>): Promise<T> {
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
    return await run();
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
  return runInWorld(world, async () => {
    const assembled = assembleWorld(world);
    const scenario = object(parseYaml(readFileSync(resolve(scenarioFile), 'utf8')), 'scenario');
    if (scenario.world !== world.id || !Array.isArray(scenario.steps)) throw new Error('scenario must target its declared world and list steps');
    const steps = scenario.steps.map((step) => object(step, 'scenario step'));
    const stepKeys = steps.map((step) => Object.keys(step).sort().join(','));
    if (steps.length !== 2 || stepKeys[0] !== 'inject' || stepKeys[1] !== 'observe' || steps[1]?.observe !== 'release-readiness') {
      throw new Error('scenario steps must be inject followed by observe: release-readiness');
    }
    const injection = steps[0]!;
    const event = object(injection.inject, 'scenario inject');
    if (Object.keys(event).some((key) => key !== 'id' && key !== 'version')) throw new Error('unsupported scenario inject field');
    if (event.id !== 'dead-pid-lock') throw new Error(`unsupported world event: ${String(event.id)}`);
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
    const declaration = world.spec.events.find((entry) => entry.id === event.id);
    const offset = declaration?.at.match(/^\+(\d+)(ms|s|m|h)$/);
    if (!offset) throw new Error(`unsupported event time: ${declaration?.at ?? 'missing'}`);
    const eventDelay = Number(offset[1]) * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const)[offset[2] as 'ms' | 's' | 'm' | 'h'];
    return clockDevice.withClock(new Date(world.spec.clock?.start ?? '2100-01-01T00:00:00.000Z'), async (clock) => {
      clock.tick(eventDelay);
      writeFileSync(lockPath, `${JSON.stringify({ pid })}\n`, { mode: 0o600, flag: 'wx' });
      const readiness = (isAlivePid: number | undefined) => releaseReadiness(version, {
        ledgerRoot: runRoot,
        isPidAlive: (candidate) => candidate === isAlivePid,
        now: () => new Date(clock.now()),
        checklist: () => ({ ok: true, red: [], undecided: [], blocked: [] }),
      });
      const alive = readiness(pid);
      const dead = readiness(undefined);
      const observations = [
        { event: 'live-pid-lock', verdict: alive.reason },
        { event: 'dead-pid-lock', verdict: dead.reason },
      ];
      const expected = object(scenario.expect, 'scenario.expect');
      const expectAlive = object(expected.livePidLock, 'scenario.expect.livePidLock');
      const expectDead = object(expected.deadPidLock, 'scenario.expect.deadPidLock');
      if (Object.keys(expected).sort().join(',') !== 'deadPidLock,livePidLock'
        || Object.keys(expectAlive).sort().join(',') !== 'ready,reason'
        || Object.keys(expectDead).sort().join(',') !== 'ready,reason') throw new Error('unsupported scenario expectation field');
      const pass = expectAlive.ready === alive.ready && expectAlive.reason === alive.reason &&
        expectDead.ready === dead.ready && expectDead.reason === dead.reason;
      return { pass, observations, devices: [...assembled.devices.keys()] };
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
  try { return JSON.parse(output) as WorldScenarioResult; }
  catch { throw new Error(`sim world runner returned invalid JSON: ${output}`); }
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
  rmSync(owned.root, { recursive: true, force: false });
}

export function loadWorld(id: string): SimWorld {
  const testRoot = getTestStateRoot();
  if (!testRoot) throw new Error('sim worlds require an explicit --test universe');
  if (!WORLD_ID.test(id)) throw new Error('world id must be lowercase letters, digits, and hyphens');
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
