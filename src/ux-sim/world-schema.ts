import { parse as parseYaml } from 'yaml';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';

export interface SimWorldSpec {
  readonly world: string;
  readonly seed: number;
  readonly devices: readonly string[];
  readonly clock?: { readonly start: string; readonly speed: number };
  readonly hosts?: readonly {
    readonly name: string;
    readonly arch: 'arm64' | 'amd64';
    readonly cpu: number;
    readonly pools: readonly string[];
    readonly egress: boolean;
  }[];
  readonly providers?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly github?: { readonly repo: string; readonly openPRs: number };
  readonly apps?: readonly SimWorldApp[];
  readonly seats?: readonly string[];
  readonly processes?: readonly SimWorldProcess[];
  readonly events: readonly { readonly at: string; readonly id: string; readonly appAction?: 'deploy' | 'rollback'; readonly slug?: string; readonly version?: string }[];
  readonly injections?: readonly SimWorldInjection[];
  readonly chaos?: readonly SimChaosFault[];
  readonly expect?: { readonly recovers: SimRecoveryExpectation };
}

export interface SimWorldApp {
  readonly slug: string;
  readonly versions: readonly { readonly id: string; readonly files: Readonly<Record<string, string>> }[];
  readonly current?: string;
}

/** Canonical app file key used by both declaration validation and the fake host. */
export function normalizeSimWorldAppPath(path: string): string | undefined {
  if (!path || path.includes('\\') || path.includes('?') || path.includes('#')) return undefined;
  const segments = path.replace(/^\/+/, '').split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return undefined;
  return `/${segments.join('/')}`;
}

export interface SimWorldProcess {
  readonly id: string;
  readonly host: string;
  readonly releaseVersion: string;
  readonly fingerprint?: string;
  readonly lane?: string;
  readonly mission?: string;
  readonly command?: string;
}

export interface SimWorldInjection {
  readonly at: string;
  readonly ledger?: readonly { readonly event: string; readonly data?: Record<string, unknown> }[];
  readonly logs?: readonly { readonly category: string; readonly event: string; readonly data?: Record<string, unknown> }[];
}

export type SimMonkeyFault = { readonly at: string; readonly monkey: { readonly kill: string; readonly signal: 'KILL' | 'TERM' } };
/** Gorilla = one host's egress, CPU, and down state; every process on that host dies. */
export type SimGorillaFault = { readonly at: string; readonly gorilla: { readonly host: string; readonly egress: false; readonly cpu: number; readonly for: string } };
export type SimHostChaosFault = SimGorillaFault;
export type SimChaosFault = SimMonkeyFault | SimHostChaosFault;

export interface SimRecoveryExpectation {
  readonly within: string;
  readonly hitl: number;
  readonly lostLedger: number;
}

const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOST_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEAT_ID = /^[A-Z][A-Z0-9-]{0,31}$/;
const EVENT_OFFSET = /^\+(?:0|[1-9]\d*)(?:ms|s|m|h)$/;
const TOP_LEVEL_KEYS = ['world', 'seed', 'devices', 'clock', 'hosts', 'providers', 'github', 'apps', 'seats', 'processes', 'events', 'injections', 'chaos', 'expect'];
const WORLD_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${path}.${unknown} is not a supported field`);
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${path} must be a list of non-empty strings`);
  }
  const items = value as string[];
  if (new Set(items).size !== items.length) throw new Error(`${path} cannot contain duplicates`);
  return [...items];
}

function safeInteger(value: unknown, path: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${path} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

function duration(value: unknown, path: string): string {
  const text = string(value, path);
  if (!/^\+(?:0|[1-9]\d*)(?:ms|s|m|h)$/.test(text)) throw new Error(`${path} must be a positive relative duration such as +15m`);
  return text;
}

function relativeDurationMs(value: string): number {
  const match = /^\+(\d+)(ms|s|m|h)$/.exec(value)!;
  return Number(match[1]) * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const)[match[2] as 'ms' | 's' | 'm' | 'h'];
}

export function parseSimWorldProcesses(value: unknown, hosts: SimWorldSpec['hosts']): SimWorldProcess[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error('world.processes must be a non-empty list');
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const path = `world.processes[${index}]`;
    const row = object(candidate, path);
    onlyKeys(row, ['id', 'host', 'releaseVersion', 'fingerprint', 'lane', 'mission', 'command'], path);
    const id = string(row.id, `${path}.id`);
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) throw new Error(`${path}.id must be a lowercase process id`);
    const host = string(row.host, `${path}.host`);
    if (!hosts?.some((entry) => entry.name === host)) throw new Error(`${path}.host must name a declared world host`);
    const key = `${id} host=${host}`;
    if (seen.has(key)) throw new Error(`world.processes contains duplicate target: ${key}`);
    seen.add(key);
    const releaseVersion = string(row.releaseVersion, `${path}.releaseVersion`);
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(releaseVersion)) {
      throw new Error(`${path}.releaseVersion must be a semantic version`);
    }
    const fingerprint = row.fingerprint === undefined ? undefined : string(row.fingerprint, `${path}.fingerprint`);
    const lane = row.lane === undefined ? undefined : string(row.lane, `${path}.lane`);
    const mission = row.mission === undefined ? undefined : string(row.mission, `${path}.mission`);
    const command = row.command === undefined ? undefined : string(row.command, `${path}.command`);
    return { id, host, releaseVersion, ...(fingerprint ? { fingerprint } : {}), ...(lane ? { lane } : {}),
      ...(mission ? { mission } : {}), ...(command ? { command } : {}) };
  });
}

export function parseSimChaos(value: unknown, processes: SimWorldSpec['processes'], hosts: SimWorldSpec['hosts']): SimChaosFault[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error('world.chaos must be a non-empty list');
  const faults: SimChaosFault[] = value.map((candidate, index): SimChaosFault => {
    const path = `world.chaos[${index}]`;
    const row = object(candidate, path);
    const variant = ['monkey', 'gorilla'].filter((key) => Object.hasOwn(row, key));
    if (variant.length !== 1) throw new Error(`${path} must declare exactly one supported fault: monkey, gorilla`);
    const kind = variant[0]!;
    onlyKeys(row, ['at', kind], path);
    const at = duration(row.at, `${path}.at`);
    const fault = object(row[kind], `${path}.${kind}`);
    if (kind === 'monkey') {
      onlyKeys(fault, ['kill', 'signal'], `${path}.monkey`);
      const kill = string(fault.kill, `${path}.monkey.kill`);
      if (!processes?.some((process) => `${process.id} host=${process.host}` === kill)) {
        throw new Error(`${path}.monkey.kill must name a declared world process`);
      }
      if (fault.signal !== 'KILL' && fault.signal !== 'TERM') throw new Error(`${path}.monkey.signal must be KILL or TERM`);
      return { at, monkey: { kill, signal: fault.signal } };
    }
    const host = string(fault.host, `${path}.${kind}.host`);
    if (!hosts?.some((declared) => declared.name === host)) throw new Error(`${path}.${kind}.host must name exactly one declared world host`);
    if (kind === 'gorilla') {
      onlyKeys(fault, ['host', 'egress', 'cpu', 'for'], `${path}.gorilla`);
      if (fault.egress !== false) throw new Error(`${path}.gorilla.egress must be false`);
      const cpu = safeInteger(fault.cpu, `${path}.gorilla.cpu`, 0);
      const baselineCpu = hosts.find((declared) => declared.name === host)!.cpu;
      if (cpu >= baselineCpu) throw new Error(`${path}.gorilla.cpu must reduce the declared host CPU capacity`);
      const forDuration = duration(fault.for, `${path}.gorilla.for`);
      if (/^\+0(?:ms|s|m|h)$/.test(forDuration)) throw new Error(`${path}.gorilla.for must be greater than zero`);
      return { at, gorilla: { host, egress: false, cpu, for: forDuration } };
    }
    throw new Error(`${path}.${kind} belongs to SIM-CHAOS PR②b`);
  });
  const intervals = new Map<string, { start: number; end: number; index: number }[]>();
  faults.forEach((fault, index) => {
    if (!('gorilla' in fault)) return;
    const host = fault.gorilla.host;
    const start = relativeDurationMs(fault.at);
    const end = start + relativeDurationMs(fault.gorilla.for);
    const rows = intervals.get(host) ?? [];
    rows.push({ start, end, index });
    intervals.set(host, rows);
  });
  for (const [host, rows] of intervals) {
    rows.sort((a, b) => a.start - b.start);
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]!;
      const next = rows[index]!;
      if (next.start <= previous.end) throw new Error(`world.chaos[${next.index}] overlaps another host fault for ${host}`);
    }
  }
  return faults;
}

export function parseSimWorldExpectation(value: unknown): SimWorldSpec['expect'] {
  if (value === undefined) return undefined;
  const path = 'world.expect';
  const row = object(value, path);
  onlyKeys(row, ['recovers'], path);
  const recoversPath = `${path}.recovers`;
  const recovers = object(row.recovers, recoversPath);
  onlyKeys(recovers, ['within', 'hitl', 'lostLedger'], recoversPath);
  return {
    recovers: {
      within: duration(recovers.within, `${recoversPath}.within`),
      hitl: safeInteger(recovers.hitl, `${recoversPath}.hitl`, 0),
      lostLedger: safeInteger(recovers.lostLedger, `${recoversPath}.lostLedger`, 0),
    },
  };
}

export function parseSimWorldInjections(value: unknown): SimWorldInjection[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error('world.injections must be a non-empty list');
  return value.map((candidate, index) => {
    const path = `world.injections[${index}]`;
    const row = object(candidate, path);
    onlyKeys(row, ['at', 'ledger', 'logs'], path);
    const at = duration(row.at, `${path}.at`);
    const parseLedger = (input: unknown): SimWorldInjection['ledger'] => {
      if (input === undefined) return undefined;
      if (!Array.isArray(input) || input.length === 0) throw new Error(`${path}.ledger must be a non-empty list`);
      return input.map((entry, rowIndex) => {
        const entryPath = `${path}.ledger[${rowIndex}]`;
        const ledger = object(entry, entryPath);
        onlyKeys(ledger, ['event', 'data'], entryPath);
        const data = ledger.data === undefined ? undefined : object(ledger.data, `${entryPath}.data`);
        return { event: string(ledger.event, `${entryPath}.event`), ...(data ? { data } : {}) };
      });
    };
    const parseLogs = (input: unknown): SimWorldInjection['logs'] => {
      if (input === undefined) return undefined;
      if (!Array.isArray(input) || input.length === 0) throw new Error(`${path}.logs must be a non-empty list`);
      return input.map((entry, rowIndex) => {
        const entryPath = `${path}.logs[${rowIndex}]`;
        const log = object(entry, entryPath);
        onlyKeys(log, ['category', 'event', 'data'], entryPath);
        const data = log.data === undefined ? undefined : object(log.data, `${entryPath}.data`);
        return { category: string(log.category, `${entryPath}.category`), event: string(log.event, `${entryPath}.event`), ...(data ? { data } : {}) };
      });
    };
    const ledger = parseLedger(row.ledger);
    const logs = parseLogs(row.logs);
    if (!ledger?.length && !logs?.length) throw new Error(`${path} requires ledger or logs rows`);
    return { at, ...(ledger ? { ledger } : {}), ...(logs ? { logs } : {}) };
  });
}

function validWorldDateTime(value: string): boolean {
  const match = WORLD_DATE_TIME.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!daysInMonth || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z') {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetMinute > 59 || offsetHour > 14 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function inferredDevices(value: {
  devices: string[];
  processes?: SimWorldSpec['processes'];
  chaos?: SimWorldSpec['chaos'];
  clock?: unknown;
  hosts?: unknown;
  providers?: unknown;
  github?: unknown;
  seats?: unknown;
  apps?: SimWorldApp[];
}): string[] {
  const catalogIds = new Set(loadMockScenarioCatalog().devices.map((device) => device.id));
  const result: string[] = [];
  const requireDevice = (id: string, path: string) => {
    if (!catalogIds.has(id)) throw new Error(`${path} references unregistered mock device: ${id}`);
    if (!result.includes(id)) result.push(id);
  };
  value.devices.forEach((id, index) => requireDevice(id, `world.devices[${index}]`));
  if (value.hosts !== undefined) requireDevice('fake-kubectl', 'world.hosts');
  if (value.providers !== undefined) requireDevice('fake-llm', 'world.providers');
  if (value.github !== undefined) requireDevice('fake-github', 'world.github');
  if (value.clock !== undefined) requireDevice('fake-clock', 'world.clock');
  if (value.apps?.length) requireDevice('fake-clock', 'world.apps');
  if (value.seats !== undefined) requireDevice('fake-herdr', 'world.seats');
  if (value.processes?.length || value.chaos?.length) requireDevice('fake-ps', 'world.chaos/processes');
  if (result.length === 0) throw new Error('world must declare at least one mock device or device-backed setting');
  return result;
}

/** Parse only the RFC A2 world shape and report invalid references at their field path. */
function parseSimWorldApps(value: unknown): SimWorldApp[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('world.apps must be a list');
  const apps = value.map((candidate, index) => {
    const path = `world.apps[${index}]`;
    const row = object(candidate, path);
    onlyKeys(row, ['slug', 'versions', 'current'], path);
    const slug = string(row.slug, `${path}.slug`);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) throw new Error(`${path}.slug must be a lowercase app id`);
    if (!Array.isArray(row.versions) || row.versions.length === 0) throw new Error(`${path}.versions must be a non-empty list`);
    const versions = row.versions.map((item, versionIndex) => {
      const versionPath = `${path}.versions[${versionIndex}]`;
      const version = object(item, versionPath);
      onlyKeys(version, ['id', 'files'], versionPath);
      const id = string(version.id, `${versionPath}.id`);
      const rawFiles = object(version.files, `${versionPath}.files`);
      const normalizedPaths = new Set<string>();
      const files = Object.fromEntries(Object.entries(rawFiles).map(([file, content]) => {
        const normalized = normalizeSimWorldAppPath(file);
        if (!normalized || typeof content !== 'string') throw new Error(`${versionPath}.files.${file} must be a valid path with string content`);
        if (normalizedPaths.has(normalized)) throw new Error(`${versionPath}.files contains duplicate normalized path: ${normalized}`);
        normalizedPaths.add(normalized);
        return [file, content];
      }));
      return { id, files };
    });
    if (new Set(versions.map((version) => version.id)).size !== versions.length) throw new Error(`${path}.versions cannot contain duplicate ids`);
    const current = row.current === undefined ? undefined : string(row.current, `${path}.current`);
    if (current !== undefined && !versions.some((version) => version.id === current)) throw new Error(`${path}.current must reference a declared version`);
    return { slug, versions, ...(current ? { current } : {}) };
  });
  if (new Set(apps.map((app) => app.slug)).size !== apps.length) throw new Error('world.apps cannot contain duplicate slugs');
  return apps;
}

export function parseSimWorld(source: string): SimWorldSpec {
  let parsed: unknown;
  try { parsed = parseYaml(source); }
  catch (error) { throw new Error(`world YAML is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  const value = object(parsed, 'world');
  onlyKeys(value, TOP_LEVEL_KEYS, 'world');

  const id = string(value.world, 'world.world');
  if (!WORLD_ID.test(id)) throw new Error('world.world must be a lowercase world id');
  const seed = value.seed === undefined ? 0 : safeInteger(value.seed, 'world.seed', 0);
  const requestedDevices = value.devices === undefined ? [] : stringList(value.devices, 'world.devices');

  let clock: SimWorldSpec['clock'];
  if (value.clock !== undefined) {
    const row = object(value.clock, 'world.clock');
    onlyKeys(row, ['start', 'speed'], 'world.clock');
    const start = string(row.start, 'world.clock.start');
    if (!validWorldDateTime(start)) throw new Error('world.clock.start must be a valid ISO 8601 date-time');
    clock = { start, speed: safeInteger(row.speed, 'world.clock.speed', 1) };
  }

  let hosts: SimWorldSpec['hosts'];
  if (value.hosts !== undefined) {
    if (!Array.isArray(value.hosts)) throw new Error('world.hosts must be a list');
    const seen = new Set<string>();
    hosts = value.hosts.map((entry, index) => {
      const path = `world.hosts[${index}]`;
      const row = object(entry, path);
      onlyKeys(row, ['name', 'arch', 'cpu', 'pools', 'egress'], path);
      const name = string(row.name, `${path}.name`);
      if (!HOST_ID.test(name)) throw new Error(`${path}.name must be a lowercase host id`);
      if (seen.has(name)) throw new Error(`world.hosts contains duplicate name: ${name}`);
      seen.add(name);
      if (row.arch !== 'arm64' && row.arch !== 'amd64') throw new Error(`${path}.arch must be arm64 or amd64`);
      const pools = row.pools === undefined ? [] : stringList(row.pools, `${path}.pools`);
      if (row.egress !== undefined && typeof row.egress !== 'boolean') throw new Error(`${path}.egress must be boolean`);
      return { name, arch: row.arch, cpu: safeInteger(row.cpu, `${path}.cpu`, 1), pools, egress: row.egress === true };
    });
  }

  let providers: SimWorldSpec['providers'];
  if (value.providers !== undefined) {
    const rows = object(value.providers, 'world.providers');
    const names = Object.keys(rows);
    if (names.length === 0) throw new Error('world.providers must contain at least one provider');
    providers = Object.fromEntries(names.map((name) => {
      const path = `world.providers.${name}`;
      if (name !== 'codex' && name !== 'claude') throw new Error(`${path} is not a supported RFC A2 provider`);
      const row = object(rows[name], path);
      if (name === 'codex') {
        onlyKeys(row, ['accounts'], path);
        if (!Array.isArray(row.accounts) || row.accounts.length === 0) throw new Error(`${path}.accounts must be a non-empty list`);
        const accounts = row.accounts.map((account, index) => {
          const accountPath = `${path}.accounts[${index}]`;
          const entry = string(account, accountPath);
          const balance = /^[a-z][a-z0-9-]*:(\d+(?:\.\d+)?)%$/.exec(entry);
          if (!balance || Number(balance[1]) > 100) throw new Error(`${accountPath} must be a provider label and percentage from 0 to 100`);
          return entry;
        });
        return [name, { accounts }];
      }
      onlyKeys(row, ['quota'], path);
      return [name, { quota: string(row.quota, `${path}.quota`) }];
    }));
  }

  let github: SimWorldSpec['github'];
  if (value.github !== undefined) {
    const row = object(value.github, 'world.github');
    onlyKeys(row, ['repo', 'openPRs'], 'world.github');
    github = {
      repo: string(row.repo, 'world.github.repo'),
      openPRs: safeInteger(row.openPRs, 'world.github.openPRs', 0),
    };
  }

  let seats: SimWorldSpec['seats'];
  const apps = parseSimWorldApps(value.apps);
  if (value.seats !== undefined) {
    seats = stringList(value.seats, 'world.seats');
    for (const seat of seats) if (!SEAT_ID.test(seat)) throw new Error(`world.seats contains invalid seat name: ${seat}`);
  }

  const rawEvents = value.events === undefined ? [] : value.events;
  if (!Array.isArray(rawEvents)) throw new Error('world.events must be a list');
  const registeredWorldEvents = new Set(loadMockScenarioCatalog().worldEvents.map((event) => event.id));
  const events = rawEvents.map((entry, index) => {
    const path = `world.events[${index}]`;
    const row = object(entry, path);
    onlyKeys(row, ['at', 'id', 'appAction', 'slug', 'version'], path);
    const at = string(row.at, `${path}.at`);
    if (!EVENT_OFFSET.test(at)) throw new Error(`${path}.at must be a relative offset such as +5m`);
    const eventId = string(row.id, `${path}.id`);
    if (!registeredWorldEvents.has(eventId)) {
      throw new Error(`${path}.id references unregistered world event: ${eventId}`);
    }
    const appAction = row.appAction as 'deploy' | 'rollback' | undefined;
    if (appAction !== undefined && appAction !== 'deploy' && appAction !== 'rollback') throw new Error(`${path}.appAction must be deploy or rollback`);
    const slug = row.slug === undefined ? undefined : string(row.slug, `${path}.slug`);
    const version = row.version === undefined ? undefined : string(row.version, `${path}.version`);
    if (appAction && !slug) throw new Error(`${path}.slug is required for app actions`);
    if (appAction === 'deploy' && !version) throw new Error(`${path}.version is required for deploy`);
    if (!appAction && (slug !== undefined || version !== undefined)) throw new Error(`${path}.slug and version require appAction`);
    if (appAction) {
      const app = apps?.find((candidate) => candidate.slug === slug);
      if (!app) throw new Error(`${path}.slug must reference a declared world.apps slug`);
      if (appAction === 'deploy' && !app.versions.some((candidate) => candidate.id === version)) {
        throw new Error(`${path}.version must reference a declared app version`);
      }
      if (appAction === 'rollback' && version !== undefined) throw new Error(`${path}.version is only valid for deploy`);
    }
    return { at, id: eventId, ...(appAction ? { appAction } : {}), ...(slug ? { slug } : {}), ...(version ? { version } : {}) };
  });

  const processes = parseSimWorldProcesses(value.processes, hosts);
  const chaos = parseSimChaos(value.chaos, processes, hosts);
  const injections = parseSimWorldInjections(value.injections);
  const expect = parseSimWorldExpectation(value.expect);
  if (expect && !chaos?.length) throw new Error('world.expect.recovers requires world.chaos');
  if (expect && !injections?.some((injection) => injection.ledger?.length)) {
    throw new Error('world.expect.recovers requires injected ledger rows to measure losses');
  }

  const devices = inferredDevices({ devices: requestedDevices, processes, chaos, clock, hosts, providers, github, seats, apps });
  return {
    world: id,
    seed,
    devices,
    ...(clock ? { clock } : {}),
    ...(hosts ? { hosts } : {}),
    ...(providers ? { providers } : {}),
    ...(github ? { github } : {}),
    ...(apps ? { apps } : {}),
    ...(seats ? { seats } : {}),
    ...(processes ? { processes } : {}),
    events,
    ...(injections ? { injections } : {}),
    ...(chaos ? { chaos } : {}),
    ...(expect ? { expect } : {}),
  };
}
