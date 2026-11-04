import type { Command } from 'commander';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import { getUserConfig } from '../user-config.js';
import { parsePodPool } from '../task-orchestrator/surfaces/pod-pool.js';
import { debug } from '../debug/log.js';
import { listPtyManifestRows, listPtySidetabRegistrations, readPtySidetabRegistrationsReadOnly, registerPtySidetabEntry, unregisterPtySidetabEntry, type PtyManifestRow, type PtySidetabRegistration, PTY_MANIFEST_STALE_MS } from '../pty-shell/pty-manifest.js';
import { collectRemoteElnInventory, filterRemoteElnInventory, type RemoteElnInventoryHost, type RemoteElnSession } from '../pty-shell/remote-eln-inventory.js';

export interface RemoteElnPtyCommandDeps {
  readonly rows: () => readonly PtyManifestRow[];
  readonly registrations: () => readonly PtySidetabRegistration[];
  readonly register: (entry: PtySidetabRegistration) => boolean;
  readonly unregister: (ptyId: string) => boolean;
  readonly remoteHosts: () => readonly string[];
  readonly queryHost: (host: string) => Promise<readonly RemoteElnSession[]>;
  readonly now: () => number;
  readonly localHost: () => string;
}

function configuredSshHosts(): string[] {
  const config = getUserConfig() as { harness?: { podPool?: string } };
  const spec = config.harness?.podPool?.trim();
  if (!spec) throw new Error('harness.podPool is required for --all-hosts');
  const hosts = parsePodPool(spec).map((member) => member.sshHost ?? member.context);
  return [...new Set(hosts)];
}

const execFileAsync = promisify(execFile);

export type RemoteElnSshExec = (host: string, command: string) => Promise<string>;

const defaultRemoteElnSshExec: RemoteElnSshExec = async (host, command) => {
  const { stdout } = await execFileAsync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'ControlPath=none', '--', host, command,
  ], { encoding: 'utf8', timeout: 7_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

export async function queryRemoteHostInventory(
  host: string,
  sshExec: RemoteElnSshExec = defaultRemoteElnSshExec,
): Promise<readonly RemoteElnSession[]> {
  const [listedText, registeredText] = await Promise.all([
    sshExec(host, 'eln pty list --all --json'),
    sshExec(host, 'eln pty sidetab registry --json'),
  ]);
  const listed: unknown = JSON.parse(listedText);
  const registered: unknown = JSON.parse(registeredText);
  if (!Array.isArray(listed) || !Array.isArray(registered)) throw new Error('remote inventory must be JSON arrays');
  const registrationById = new Map(registered.map((value) => {
    if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).ptyId !== 'string') throw new Error('malformed remote sidetab registration');
    const row = value as Record<string, unknown>;
    return [row.ptyId as string, row];
  }));
  const listedById = new Map<string, Record<string, unknown>>();
  for (const value of listed) {
    if (!value || typeof value !== 'object') throw new Error('remote inventory contains a malformed row');
    const row = value as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.kind !== 'string' || typeof row.alive !== 'boolean') throw new Error('remote inventory contains a malformed row');
    listedById.set(row.id, row);
  }
  const ids = new Set([...listedById.keys(), ...registrationById.keys()]);
  return [...ids].map((ptyId): RemoteElnSession => {
    const row = listedById.get(ptyId);
    const registration = registrationById.get(ptyId);
    const age = typeof row?.ageMs === 'number' && Number.isFinite(row.ageMs) ? row.ageMs : undefined;
    return {
      ptyId,
      kind: typeof row?.kind === 'string' ? row.kind : 'tui',
      name: typeof registration?.name === 'string' ? registration.name : typeof row?.nickname === 'string' ? row.nickname : ptyId,
      alive: row?.alive === true,
      registered: registration !== undefined,
      ...(typeof registration?.registeredBy === 'string' ? { registeredBy: registration.registeredBy } : {}),
      ...(typeof registration?.registeredAt === 'number' ? { registeredAt: registration.registeredAt } : {}),
      ...(age === undefined ? {} : { lastActivityAt: Date.now() - age }),
      status: row?.alive === true ? 'unknown' : 'stale',
    };
  });
}

const liveDeps: RemoteElnPtyCommandDeps = {
  rows: listPtyManifestRows,
  registrations: listPtySidetabRegistrations,
  register: registerPtySidetabEntry,
  unregister: unregisterPtySidetabEntry,
  remoteHosts: configuredSshHosts,
  queryHost: queryRemoteHostInventory,
  now: Date.now,
  localHost: () => hostname().split('.')[0] || 'local',
};

export function inventorySessionRows(
  rows: readonly PtyManifestRow[],
  registrations: readonly PtySidetabRegistration[],
  now = Date.now(),
): RemoteElnSession[] {
  const byId = new Map(registrations.map((entry) => [entry.ptyId, entry]));
  return rows.map((row) => {
    const registration = byId.get(row.id);
    const activity = row.progressAt ?? row.turnAt ?? row.updatedAt;
    const age = Math.max(0, now - activity);
    const status = !row.alive || age > PTY_MANIFEST_STALE_MS
      ? 'stale'
      : row.turnState ?? 'unknown';
    return {
      ptyId: row.id,
      kind: row.kind,
      name: registration?.name ?? row.nickname ?? row.kind,
      alive: row.alive,
      registered: registration !== undefined,
      ...(registration ? { registeredBy: registration.registeredBy, registeredAt: registration.registeredAt } : {}),
      lastActivityAt: activity,
      status,
    };
  });
}

export function isElanousTuiManifestRow(row: PtyManifestRow): boolean {
  if (row.kind !== 'tui') return false;
  if (row.terminalOriginCategory === 'elanous') return true;
  const command = row.cmd.trim().toLowerCase().replaceAll(String.fromCharCode(92), String.fromCharCode(47));
  return command === 'elanous' || command === 'eln' || command.endsWith('/elanous')
    || command.endsWith('/eln') || command.endsWith('/elanous.mjs') || command.includes('/bin/elanous.mjs ');
}

export function registeredRemoteSidetabSessions(
  rows: readonly PtyManifestRow[],
  registrations: readonly PtySidetabRegistration[],
  now = Date.now(),
): Array<RemoteElnSession & { host: string }> {
  const registrationById = new Map(registrations.map((entry) => [entry.ptyId, entry]));
  return rows.flatMap((row) => {
    const registration = registrationById.get(row.id);
    if (!registration || !isElanousTuiManifestRow(row) || !row.alive) return [];
    const activity = row.progressAt ?? row.turnAt ?? row.updatedAt;
    const status = now - activity > PTY_MANIFEST_STALE_MS ? 'stale' : row.turnState ?? 'unknown';
    return [{
      ptyId: row.id,
      kind: row.kind,
      name: registration.name,
      alive: true,
      registered: true,
      registeredBy: registration.registeredBy,
      registeredAt: registration.registeredAt,
      lastActivityAt: activity,
      status,
      host: registration.host,
    }];
  });
}

function printInventory(hosts: readonly RemoteElnInventoryHost[], json: boolean): void {
  if (json) {
    const rows: Array<Record<string, unknown>> = [];
    for (const host of hosts) {
      if (host.status === 'unmeasured') rows.push({ host: host.host, status: 'unmeasured', reason: host.reason });
      else for (const session of host.sessions) rows.push({ host: host.host, ...session });
    }
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }
  for (const host of hosts) {
    if (host.status === 'unmeasured') {
      console.log(`${host.host} · 측정 불가 · ${host.reason}`);
      continue;
    }
    if (host.sessions.length === 0) console.log(`${host.host} · 세션 없음`);
    for (const session of host.sessions) {
      console.log(`${host.host}:${session.name} · ${session.kind} · ${session.status ?? (session.alive ? 'unknown' : 'stale')} · registered=${session.registered}`);
    }
  }
}

function resolveSidetabRegisterRef(
  rows: readonly PtyManifestRow[],
  ref: string,
): { readonly row?: PtyManifestRow; readonly ambiguous: boolean } {
  const matches = rows.filter((candidate) => candidate.id === ref || candidate.nickname === ref);
  return matches.length > 1 ? { ambiguous: true } : { row: matches[0], ambiguous: false };
}

export function resolveSidetabUnregisterRef(
  registrations: readonly PtySidetabRegistration[],
  ref: string,
): { readonly entry?: PtySidetabRegistration; readonly ambiguous: boolean } {
  const matches = registrations.filter((candidate) => candidate.ptyId === ref || candidate.name === ref);
  return matches.length > 1 ? { ambiguous: true } : { entry: matches[0], ambiguous: false };
}

export function registerRemoteElnPtyCommands(
  pty: Command,
  deps: RemoteElnPtyCommandDeps = liveDeps,
): void {
  pty.command('inventory')
    .description('Read-only PTY inventory; --all-hosts queries the configured SSH host roster')
    .option('--all-hosts', 'query each configured host independently; unreadable hosts remain unmeasured')
    .option('--host <host...>', 'filter by SSH host alias')
    .option('--kind <kind...>', 'filter by PTY kind')
    .option('--registered <value>', 'filter by yes or no')
    .option('--json', 'emit one row per session plus explicit unmeasured host rows')
    .action(async (options: { allHosts?: boolean; host?: string[]; kind?: string[]; registered?: string; json?: boolean }) => {
      const registered = options.registered === undefined ? undefined
        : options.registered === 'yes' ? true : options.registered === 'no' ? false : null;
      if (registered === null) {
        process.stderr.write('pty inventory: --registered must be yes or no\n');
        process.exitCode = 2;
        return;
      }
      let hosts: RemoteElnInventoryHost[];
      if (options.allHosts) {
        const configured = [...deps.remoteHosts()];
        const selected = options.host?.length ? configured.filter((host) => options.host!.includes(host)) : configured;
        hosts = await collectRemoteElnInventory(selected, deps.queryHost);
      } else {
        const localHost = deps.localHost();
        hosts = await collectRemoteElnInventory([localHost], async () =>
          inventorySessionRows(deps.rows(), deps.registrations(), deps.now()));
      }
      printInventory(filterRemoteElnInventory(hosts, {
        ...(options.host?.length && !options.allHosts ? { host: options.host } : {}),
        ...(options.kind ? { kind: options.kind } : {}),
        ...(registered === undefined ? {} : { registered }),
      }), options.json === true);
      process.exitCode = 0;
    });

  const sidetab = pty.command('sidetab').description('Explicit remote TUI registration; only registered live TUI sessions are returned');
  sidetab.command('register <ref>')
    .requiredOption('--host <alias>', 'SSH host alias used by the controller')
    .requiredOption('--name <name>', 'human-readable side-tab label')
    .requiredOption('--by <person>', 'person who explicitly registered this session')
    .description('Register a live TUI for side-tab display; ordinary PTYs cannot be registered')
    .action((ref: string, options: { host: string; name: string; by: string }) => {
      const resolved = resolveSidetabRegisterRef(deps.rows(), ref);
      if (resolved.ambiguous) {
        process.stderr.write(`pty sidetab register: ambiguous registration ref: ${ref}\n`);
        process.exitCode = 2;
        return;
      }
      const row = resolved.row;
      if (!row || !row.alive || !isElanousTuiManifestRow(row)) {
        process.stderr.write(`pty sidetab register: live TUI ref not found: ${ref}\n`);
        process.exitCode = 1;
        return;
      }
      const registeredAt = deps.now();
      const entry = { ptyId: row.id, host: options.host, name: options.name, registeredBy: options.by, registeredAt };
      if (!deps.register(entry)) {
        process.stderr.write(`pty sidetab register: invalid registration for ${row.id}\n`);
        process.exitCode = 1;
        return;
      }
      debug.log('sidetab.remote', 'register', { host: entry.host, name: entry.name, ptyId: entry.ptyId, registeredBy: entry.registeredBy, registeredAt });
      process.stdout.write(JSON.stringify({ ok: true, ...entry }) + '\n');
      process.exitCode = 0;
    });
  sidetab.command('unregister <ref>')
    .description('Remove an explicit side-tab registration')
    .action((ref: string) => {
      const resolved = resolveSidetabUnregisterRef(deps.registrations(), ref);
      if (resolved.ambiguous) {
        process.stderr.write(`pty sidetab unregister: ambiguous registration ref: ${ref}\n`);
        process.exitCode = 2;
        return;
      }
      const entry = resolved.entry;
      if (!entry || !deps.unregister(entry.ptyId)) {
        process.stderr.write(`pty sidetab unregister: registration not found: ${ref}\n`);
        process.exitCode = 1;
        return;
      }
      debug.log('sidetab.remote', 'unregister', { host: entry.host, name: entry.name, ptyId: entry.ptyId });
      process.stdout.write(JSON.stringify({ ok: true, ptyId: entry.ptyId, host: entry.host, name: entry.name }) + '\n');
      process.exitCode = 0;
    });
  sidetab.command('registry')
    .option('--json', 'emit the explicit registration ledger as JSON')
    .description('Read the registration ledger directly; never filters by live sidebar eligibility')
    .action((options: { json?: boolean }) => {
      try {
        const rows = readPtySidetabRegistrationsReadOnly();
        if (options.json) process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
        else for (const row of rows) console.log(`${row.ptyId} · ${row.host}:${row.name} · ${row.registeredBy}`);
        process.exitCode = 0;
      } catch (error) {
        process.stderr.write(`pty sidetab registry: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    });
  sidetab.command('list')
    .option('--json', 'emit registered live TUI sessions as JSON')
    .description('List explicitly registered, live TUI sessions only; does not scan other PTYs')
    .action((options: { json?: boolean }) => {
      const rows = registeredRemoteSidetabSessions(deps.rows(), deps.registrations(), deps.now());
      if (options.json) process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      else for (const row of rows) console.log(`${row.host}:${row.name} · ${row.status} · ${row.lastActivityAt}`);
      process.exitCode = 0;
    });
}
