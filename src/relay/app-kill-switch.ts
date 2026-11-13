import { Database } from 'bun:sqlite';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';

export type AppKillSwitchIncidentType = 'abuse-report' | 'cost-spike';
export type AppKillSwitchActor = { kind: 'operator' | 'user'; id: string };

export interface AppKillSwitchIncident {
  readonly userId: string;
  readonly appId: string;
  readonly incident: AppKillSwitchIncidentType;
  readonly reason: string;
  readonly requestedBy: string;
}

export interface AppKillSwitchReactivation {
  readonly userId: string;
  readonly appId: string;
  readonly actor: AppKillSwitchActor;
}

export interface AppKillSwitchAuditEvent extends AppKillSwitchIncident {
  readonly id: number;
  readonly action: 'disabled' | 'reactivated';
  readonly actorKind: 'system' | 'operator' | 'user';
  readonly actorId: string;
  readonly occurredAt: string;
}

export interface AppKillSwitchOptions {
  /** Trusted root for state files; canonicalized once before checking descendants. */
  readonly stateRoot?: string;
  readonly now?: () => Date;
  readonly authorizeReactivation?: (input: { readonly userId: string; readonly appId: string; readonly actor: AppKillSwitchActor }) => boolean;
}

const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INCIDENTS = new Set<AppKillSwitchIncidentType>(['abuse-report', 'cost-spike']);
const SECRET_LIKE_ID = /(?:sk-|xai-|ghp_|gho_|github_pat_|AKIA|AIza|xoxb-)/i;

function validateUserId(value: unknown): string {
  if (typeof value !== 'string' || !USER_ID.test(value) || SECRET_LIKE_ID.test(value)) throw new Error('invalid app kill switch user id');
  return value;
}

function validateAppId(value: unknown): string {
  if (typeof value !== 'string' || !APP_ID.test(value) || value.includes('--') || value.startsWith('xn--') || /-pr\d+$/.test(value)) {
    throw new Error('invalid app kill switch app id');
  }
  return value;
}

function validateReason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error('invalid app kill switch reason');
  }
  return value.trim();
}

function validateRequester(value: unknown): string {
  if (typeof value !== 'string' || !USER_ID.test(value) || SECRET_LIKE_ID.test(value)) throw new Error('invalid app kill switch requester');
  return value;
}

function validateIncident(input: AppKillSwitchIncident): AppKillSwitchIncident {
  if (!input || typeof input !== 'object' || !INCIDENTS.has(input.incident)) throw new Error('invalid app kill switch incident');
  return {
    userId: validateUserId(input.userId),
    appId: validateAppId(input.appId),
    incident: input.incident,
    reason: validateReason(input.reason),
    requestedBy: validateRequester(input.requestedBy),
  };
}

function validateActor(actor: AppKillSwitchActor): AppKillSwitchActor {
  if (!actor || (actor.kind !== 'operator' && actor.kind !== 'user')) throw new Error('invalid app kill switch actor');
  return { kind: actor.kind, id: validateRequester(actor.id) };
}

function defaultDatabasePath(): string {
  return join(getElanousConfigDir(), 'relay', 'app-kill-switch.sqlite');
}

function nearestExistingStateRoot(databasePath: string): string {
  let directory = dirname(resolve(databasePath));
  while (true) {
    try {
      const entry = lstatSync(directory);
      if (entry.isDirectory() || entry.isSymbolicLink()) return directory;
      throw new Error('app kill switch state root is not a directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(directory);
      if (parent === directory) throw new Error('app kill switch state root is unavailable');
      directory = parent;
    }
  }
}

function descriptorPath(fd: number): string {
  if (process.platform === 'linux') return `/proc/self/fd/${fd}`;
  if (process.platform === 'darwin') return `/dev/fd/${fd}`;
  throw new Error('app kill switch descriptor paths are unsupported on this platform');
}

function assertPrivateDirectory(stateRoot: string, relativeDirectory: string, uid: number): { path: string; descriptor: number } {
  const canonicalRoot = realpathSync(resolve(stateRoot));
  const directoryFlag = constants.O_DIRECTORY;
  const noFollow = constants.O_NOFOLLOW;
  if (typeof directoryFlag !== 'number' || typeof noFollow !== 'number') throw new Error('app kill switch no-follow directory open is unavailable');
  let fd = openSync(canonicalRoot, constants.O_RDONLY | directoryFlag | noFollow);
  try {
    const rootInfo = fstatSync(fd);
    const namedRoot = lstatSync(canonicalRoot);
    if (!rootInfo.isDirectory() || namedRoot.isSymbolicLink() || rootInfo.dev !== namedRoot.dev || rootInfo.ino !== namedRoot.ino
      || rootInfo.uid !== uid || (rootInfo.mode & 0o077) !== 0) throw new Error('unsafe app kill switch state directory');
    const parts = relativeDirectory.split('/').filter(Boolean);
    let expectedPath = canonicalRoot;
    for (const part of parts) {
      const parentPath = process.platform === 'darwin' ? realpathSync(descriptorPath(fd)) : descriptorPath(fd);
      if (process.platform === 'darwin' && parentPath !== expectedPath) throw new Error('unsafe app kill switch state directory');
      const child = join(parentPath, part);
      let before;
      try {
        before = lstatSync(child);
        if (before.isSymbolicLink()) throw new Error('unsafe app kill switch state directory');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Match relay host identity setup: inspect one child at a time and never recurse through unchecked paths.
        mkdirSync(child, { mode: 0o700 });
        before = lstatSync(child);
        if (before.isSymbolicLink()) throw new Error('unsafe app kill switch state directory');
      }
      const next = openSync(child, constants.O_RDONLY | directoryFlag | noFollow);
      const opened = fstatSync(next);
      const named = lstatSync(child);
      const permissions = opened.mode & 0o1777;
      if (!opened.isDirectory() || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino
        || (opened.uid !== uid && opened.uid !== 0)
        || ((permissions & 0o022) !== 0 && (permissions & 0o1000) === 0)) {
        closeSync(next);
        throw new Error('unsafe app kill switch state directory');
      }
      closeSync(fd);
      fd = next;
      expectedPath = child;
    }
    const leaf = fstatSync(fd);
    if (leaf.uid !== uid || (leaf.mode & 0o077) !== 0) throw new Error('unsafe app kill switch state directory');
    const path = process.platform === 'darwin' ? realpathSync(descriptorPath(fd)) : descriptorPath(fd);
    if (process.platform === 'darwin' && path !== expectedPath) throw new Error('unsafe app kill switch state directory');
    return { path, descriptor: fd };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Shared safe-open boundary for private relay SQLite state files. */
export function openPrivateDatabase(databasePath: string, stateRoot: string): { db: Database; descriptor: number; parentDescriptor: number } {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('app kill switch requires an OS user identity');
  const absolute = resolve(databasePath);
  const absoluteRoot = resolve(stateRoot);
  const relativeFile = relative(absoluteRoot, absolute);
  if (!relativeFile || relativeFile === '..' || relativeFile.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('app kill switch database must be under its state root');
  }
  const parent = assertPrivateDirectory(absoluteRoot, dirname(relativeFile) === '.' ? '' : dirname(relativeFile), uid);
  const file = join(parent.path, basename(relativeFile));
  let descriptor: number | undefined;
  let db: Database | undefined;
  try {
    const flags = constants.O_RDWR | constants.O_NOFOLLOW;
    try {
      descriptor = openSync(file, flags);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      descriptor = openSync(file, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
    }
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.uid !== uid || (opened.mode & 0o077) !== 0 || (opened.mode & 0o600) !== 0o600) {
      throw new Error('unsafe app kill switch database');
    }
    const beforeOpen = lstatSync(file);
    if (beforeOpen.isSymbolicLink() || beforeOpen.dev !== opened.dev || beforeOpen.ino !== opened.ino) {
      throw new Error('unsafe app kill switch database path');
    }
    db = new Database(file);
    const afterOpen = lstatSync(file);
    if (afterOpen.isSymbolicLink() || afterOpen.dev !== opened.dev || afterOpen.ino !== opened.ino) {
      throw new Error('unsafe app kill switch database path');
    }
    return { db, descriptor, parentDescriptor: parent.descriptor };
  } catch (error) {
    db?.close();
    if (descriptor !== undefined) closeSync(descriptor);
    closeSync(parent.descriptor);
    if (error instanceof Error && error.message.startsWith('unsafe app kill switch')) throw error;
    throw new Error('unsafe app kill switch database path');
  }
}

function closeGuardDescriptor(descriptor: number): void {
  try { closeSync(descriptor); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error;
  }
}

/** Durable per-user app stop state and audit. Relay request enforcement is wired by the follow-up relay-server slice. */
export function createAppKillSwitch(databasePath = defaultDatabasePath(), options: AppKillSwitchOptions = {}) {
  if (databasePath === ':memory:') throw new Error('app kill switch requires a private database path');
  const stateRoot = options.stateRoot ?? (databasePath === defaultDatabasePath() ? getElanousConfigDir() : nearestExistingStateRoot(databasePath));
  const opened = openPrivateDatabase(databasePath, stateRoot);
  const db = opened.db;
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS app_kill_switch_state (
      user_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      is_down INTEGER NOT NULL CHECK (is_down IN (0, 1)),
      incident TEXT NOT NULL CHECK (incident IN ('abuse-report', 'cost-spike')),
      reason TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, app_id)
    );
    CREATE TABLE IF NOT EXISTS app_kill_switch_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('disabled', 'reactivated')),
      incident TEXT NOT NULL CHECK (incident IN ('abuse-report', 'cost-spike')),
      reason TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system', 'operator', 'user')),
      actor_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS app_kill_switch_audit_scope
      ON app_kill_switch_audit(user_id, app_id, id);
  `); } catch (error) { db.close(); closeSync(opened.descriptor); closeSync(opened.parentDescriptor); throw error; }
  const now = options.now ?? (() => new Date());

  const insertAudit = db.query(`INSERT INTO app_kill_switch_audit
    (user_id, app_id, action, incident, reason, requested_by, actor_kind, actor_id, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  return {
    applyIncident(input: AppKillSwitchIncident): AppKillSwitchAuditEvent {
      const incident = validateIncident(input);
      const occurredAt = now().toISOString();
      const apply = db.transaction(() => {
        db.query(`INSERT INTO app_kill_switch_state
          (user_id, app_id, is_down, incident, reason, requested_by, updated_at)
          VALUES (?, ?, 1, ?, ?, ?, ?)
          ON CONFLICT(user_id, app_id) DO UPDATE SET is_down=1, incident=excluded.incident,
            reason=excluded.reason, requested_by=excluded.requested_by, updated_at=excluded.updated_at`)
          .run(incident.userId, incident.appId, incident.incident, incident.reason, incident.requestedBy, occurredAt);
        insertAudit.run(incident.userId, incident.appId, 'disabled', incident.incident, incident.reason,
          incident.requestedBy, 'system', 'incident-ingress', occurredAt);
        return db.query('SELECT last_insert_rowid() AS id').get() as { id: number };
      });
      const { id } = apply();
      return { ...incident, id, action: 'disabled', actorKind: 'system', actorId: 'incident-ingress', occurredAt };
    },

    reactivate(input: AppKillSwitchReactivation): boolean {
      const userId = validateUserId(input.userId);
      const appId = validateAppId(input.appId);
      const actor = validateActor(input.actor);
      if (actor.kind === 'user' && actor.id !== userId) throw new Error('app kill switch reactivation denied');
      if (!options.authorizeReactivation?.({ userId, appId, actor })) throw new Error('app kill switch reactivation denied');
      const occurredAt = now().toISOString();
      const transition = db.transaction(() => {
        const state = db.query(`SELECT incident, reason, requested_by FROM app_kill_switch_state
          WHERE user_id=? AND app_id=? AND is_down=1`).get(userId, appId) as
          { incident: AppKillSwitchIncidentType; reason: string; requested_by: string } | null;
        if (!state) return false;
        db.query(`UPDATE app_kill_switch_state SET is_down=0, updated_at=? WHERE user_id=? AND app_id=? AND is_down=1`)
          .run(occurredAt, userId, appId);
        insertAudit.run(userId, appId, 'reactivated', state.incident, state.reason, state.requested_by,
          actor.kind, actor.id, occurredAt);
        return true;
      });
      return transition();
    },

    isDown(userIdInput: string, appIdInput: string): boolean {
      const userId = validateUserId(userIdInput);
      const appId = validateAppId(appIdInput);
      const row = db.query('SELECT is_down FROM app_kill_switch_state WHERE user_id=? AND app_id=?')
        .get(userId, appId) as { is_down: number } | null;
      return row?.is_down === 1;
    },

    audit(userIdInput: string, appIdInput: string): AppKillSwitchAuditEvent[] {
      const userId = validateUserId(userIdInput);
      const appId = validateAppId(appIdInput);
      return (db.query(`SELECT id, user_id AS userId, app_id AS appId, action, incident, reason,
        requested_by AS requestedBy, actor_kind AS actorKind, actor_id AS actorId, occurred_at AS occurredAt
        FROM app_kill_switch_audit WHERE user_id=? AND app_id=? ORDER BY id`).all(userId, appId) as AppKillSwitchAuditEvent[])
        .map((event) => ({ ...event }));
    },

    close(): void { db.close(); closeGuardDescriptor(opened.descriptor); closeGuardDescriptor(opened.parentDescriptor); },
  };
}
