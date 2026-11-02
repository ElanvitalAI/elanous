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
  readonly seats?: readonly string[];
  readonly events: readonly { readonly at: string; readonly id: string }[];
}

const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOST_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEAT_ID = /^[A-Z][A-Z0-9-]{0,31}$/;
const EVENT_OFFSET = /^\+(?:0|[1-9]\d*)(?:ms|s|m|h)$/;
const TOP_LEVEL_KEYS = ['world', 'seed', 'devices', 'clock', 'hosts', 'providers', 'github', 'seats', 'events'];
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
  clock?: unknown;
  hosts?: unknown;
  providers?: unknown;
  github?: unknown;
  seats?: unknown;
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
  if (value.seats !== undefined) requireDevice('fake-herdr', 'world.seats');
  if (result.length === 0) throw new Error('world must declare at least one mock device or device-backed setting');
  return result;
}

/** Parse only the RFC A2 world shape and report invalid references at their field path. */
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
    onlyKeys(row, ['at', 'id'], path);
    const at = string(row.at, `${path}.at`);
    if (!EVENT_OFFSET.test(at)) throw new Error(`${path}.at must be a relative offset such as +5m`);
    const eventId = string(row.id, `${path}.id`);
    if (!registeredWorldEvents.has(eventId)) {
      throw new Error(`${path}.id references unregistered world event: ${eventId}`);
    }
    return { at, id: eventId };
  });

  const devices = inferredDevices({ devices: requestedDevices, clock, hosts, providers, github, seats });
  return {
    world: id,
    seed,
    devices,
    ...(clock ? { clock } : {}),
    ...(hosts ? { hosts } : {}),
    ...(providers ? { providers } : {}),
    ...(github ? { github } : {}),
    ...(seats ? { seats } : {}),
    events,
  };
}
