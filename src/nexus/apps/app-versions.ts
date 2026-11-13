import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createObjectStore, resolveStorageConfig, type ObjectStore } from '../../storage/object-store.js';
import { getUserConfig } from '../../user-config/reader.js';
import { debug } from '../../debug/log.js';
import { nexusRootDir } from '../paths.js';
import { createAppLifecycleStore, type AppLifecycleStore } from './app-db.js';
import { createAppSimulationStore, type AppSimulationStore } from './app-simulation-db.js';
import { validateAppLifecycleEvent, type AppLifecycleEnvironment, type AppLifecycleAction } from './app-lifecycle-ledger.js';

export type AppVersionTrigger = 'agent-turn' | 'deploy' | 'edit' | 'restore';

/** Producers may label only the lifecycle operation that actually succeeded. */
export const APP_VERSION_ACTIONS: Readonly<Record<AppVersionTrigger, readonly AppLifecycleAction[]>> = {
  'agent-turn': ['simulated'], edit: ['simulated'], deploy: ['promoted', 'upgrade'], restore: ['restored', 'rolled-back'],
};

/** Producer contract for APP-RESTORE-VERSION / APP-TRY-CHANGE.
 * Call checkpoint after persisting the successful lifecycle event and its simulation receipt.
 * Version, timestamp, environment and fingerprint always come from that event, never the caller.
 * Consumers use get(appId, versionId, environment); restoring must produce a NEW version/event.
 * Every accepted eventId is durably bound to its normalized input and original return value,
 * including unchanged edits coalesced into an older checkpoint. APP_VERSION_ACTIONS defines the allowed actions.
 */
export interface AppVersionCheckpoint {
  readonly appId: string;
  readonly versionId: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly environment: AppLifecycleEnvironment;
  readonly fingerprint: string;
  readonly receiptId: string;
  readonly trigger: AppVersionTrigger;
  readonly summary: string;
  readonly thumbnailObjectKey: string;
}

export interface AppVersionCheckpointInput {
  readonly eventId: string;
  readonly trigger: AppVersionTrigger;
  /** One line supplied by the agent that summarized the change. */
  readonly summary: string;
  /** Immutable simulation image: apps/<app>/versions/<version>/<fingerprint>/<receipt>.png */
  readonly thumbnailObjectKey: string;
}

export interface AppVersionStore {
  checkpoint(appId: string, input: AppVersionCheckpointInput): AppVersionCheckpoint;
  list(appId: string, environment?: AppLifecycleEnvironment): AppVersionCheckpoint[];
  get(appId: string, versionId: string, environment: AppLifecycleEnvironment): AppVersionCheckpoint | null;
  close(): void;
}

export class AppVersionConflict extends Error {}

function assertAppId(appId: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(appId) || appId.includes('--') || appId.startsWith('xn--') || /-pr\d+$/.test(appId)) {
    throw new Error('invalid app id');
  }
}

/** Append-only metadata store; no source/ref mutation, promotion or consumer integration. */
export function createAppVersionStore(options: {
  databasePath: string;
  lifecycle: Pick<AppLifecycleStore, 'events'>;
  simulations: Pick<AppSimulationStore, 'snapshot'>;
  thumbnails: Pick<ObjectStore, 'head'>;
}): AppVersionStore {
  mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
  const db = new Database(options.databasePath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS app_version_checkpoints (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, version_id TEXT NOT NULL,
      environment TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, checkpoint_json TEXT NOT NULL,
      UNIQUE(app_id, version_id, environment)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS app_version_checkpoint_requests (
      event_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, request_json TEXT NOT NULL, checkpoint_json TEXT NOT NULL
    )`);
  } catch (error) { db.close(); throw error; }
  const list = (appId: string, environment?: AppLifecycleEnvironment): AppVersionCheckpoint[] => {
    assertAppId(appId);
    if (environment !== undefined && environment !== 'live' && environment !== 'simulation') throw new Error('invalid environment');
    const rows = db.query(`SELECT checkpoint_json FROM app_version_checkpoints WHERE app_id = ?
      ${environment ? 'AND environment = ?' : ''} ORDER BY sequence DESC`).all(...(environment ? [appId, environment] : [appId])) as { checkpoint_json: string }[];
    return rows.map(row => JSON.parse(row.checkpoint_json) as AppVersionCheckpoint)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  };
  return {
    checkpoint(appId, input) {
      assertAppId(appId);
      if (!input || !['agent-turn', 'deploy', 'edit', 'restore'].includes(input.trigger)
        || typeof input.eventId !== 'string' || typeof input.summary !== 'string'
        || !input.summary.trim() || input.summary.length > 240 || /[\r\n\x00-\x1f\x7f]/.test(input.summary)) throw new Error('invalid checkpoint');
      const requestJson = JSON.stringify({ appId, eventId: input.eventId, trigger: input.trigger,
        summary: input.summary.trim(), thumbnailObjectKey: input.thumbnailObjectKey });
      const readRequest = (): AppVersionCheckpoint | null => {
        const prior = db.query('SELECT app_id, request_json, checkpoint_json FROM app_version_checkpoint_requests WHERE event_id = ?')
          .get(input.eventId) as { app_id: string; request_json: string; checkpoint_json: string } | null;
        if (!prior) return null;
        if (prior.app_id !== appId || prior.request_json !== requestJson) throw new AppVersionConflict('version checkpoint is immutable');
        return JSON.parse(prior.checkpoint_json) as AppVersionCheckpoint;
      };
      // Includes coalesced requests; later simulations/history must never change a retry's result.
      const prior = readRequest();
      if (prior) return prior;
      const found = options.lifecycle.events(appId).find(event => event.id === input.eventId);
      if (!found) throw new AppVersionConflict('lifecycle event unavailable');
      const event = validateAppLifecycleEvent(found);
      if (event.appId !== appId || event.outcome !== 'succeeded' || !event.appVersion || !event.appFingerprint || !event.receiptId) {
        throw new AppVersionConflict('lifecycle event lacks version evidence');
      }
      if (!APP_VERSION_ACTIONS[input.trigger].includes(event.action)) {
        throw new AppVersionConflict('lifecycle action does not match checkpoint trigger');
      }
      const receipt = options.simulations.snapshot(appId).receipts.find(value => value.id === event.receiptId);
      if (!receipt || receipt.outcome !== 'passed' || receipt.appId !== appId || receipt.appFingerprint !== event.appFingerprint
        || (event.runId !== undefined && receipt.runId !== event.runId)) throw new AppVersionConflict('simulation receipt does not match version');
      const thumbnailObjectKey = `apps/${appId}/versions/${event.appVersion}/${event.appFingerprint}/${receipt.id}.png`;
      if (input.thumbnailObjectKey !== thumbnailObjectKey) throw new AppVersionConflict('thumbnail does not match version');
      const thumbnail = options.thumbnails.head(thumbnailObjectKey);
      if (!thumbnail.exists || !thumbnail.bytes) throw new AppVersionConflict('simulation thumbnail unavailable');
      const checkpoint: AppVersionCheckpoint = {
        appId, versionId: event.appVersion, eventId: event.id, occurredAt: event.occurredAt,
        environment: event.environment, fingerprint: event.appFingerprint, receiptId: receipt.id,
        trigger: input.trigger, summary: input.summary.trim(), thumbnailObjectKey,
      };
      const serialized = JSON.stringify(checkpoint);
      const remember = (saved: AppVersionCheckpoint): AppVersionCheckpoint => {
        db.query(`INSERT INTO app_version_checkpoint_requests(event_id, app_id, request_json, checkpoint_json)
          VALUES (?, ?, ?, ?)`).run(input.eventId, appId, requestJson, JSON.stringify(saved));
        return saved;
      };
      const save = db.transaction(() => {
        const concurrent = readRequest();
        if (concurrent) return concurrent;
        const existing = db.query(`SELECT checkpoint_json FROM app_version_checkpoints
          WHERE event_id = ? OR (app_id = ? AND version_id = ? AND environment = ?)`)
          .all(event.id, appId, event.appVersion!, event.environment) as { checkpoint_json: string }[];
        if (existing.length) {
          if (existing.length === 1 && existing[0]!.checkpoint_json === serialized) return remember(checkpoint);
          // A new event may describe the same unchanged version. Preserve that version's
          // checkpoint and durably map this event to it, rather than treating it as a rewrite.
          if (existing.length === 1 && (input.trigger === 'edit' || input.trigger === 'agent-turn')) {
            const saved = JSON.parse(existing[0]!.checkpoint_json) as AppVersionCheckpoint;
            if (saved.appId === appId && saved.versionId === event.appVersion && saved.environment === event.environment
              && saved.fingerprint === event.appFingerprint && saved.eventId !== event.id) return remember(saved);
          }
          throw new AppVersionConflict('version checkpoint is immutable');
        }
        const previous = list(appId, event.environment)[0];
        // Repeated turn/edit notifications with no source change keep the existing save point.
        if (previous?.fingerprint === event.appFingerprint && (input.trigger === 'agent-turn' || input.trigger === 'edit')) {
          return remember(previous);
        }
        db.query(`INSERT INTO app_version_checkpoints(app_id, version_id, environment, event_id, checkpoint_json)
          VALUES (?, ?, ?, ?, ?)`).run(appId, event.appVersion!, event.environment, event.id, serialized);
        return remember(checkpoint);
      });
      try {
        const saved = save.immediate();
        debug.log('nexus.app-versions', 'checkpoint-saved', { appId, versionId: saved.versionId, eventId: saved.eventId, trigger: saved.trigger });
        return saved;
      } catch (error) {
        debug.log('nexus.app-versions', 'checkpoint-refused', { appId, reason: error instanceof AppVersionConflict ? 'conflict' : 'storage-unavailable' });
        throw error;
      }
    },
    list,
    get(appId, versionId, environment) { return list(appId, environment).find(value => value.versionId === versionId) ?? null; },
    close() { db.close(); },
  };
}

/** Request-scoped production adapter: always closes its three SQLite handles. */
export function openAppVersionStore(root = nexusRootDir(), thumbnails: Pick<ObjectStore, 'head'> = createObjectStore(
  resolveStorageConfig(getUserConfig() as Parameters<typeof resolveStorageConfig>[0]),
)): AppVersionStore {
  const lifecycle = createAppLifecycleStore(join(root, 'app-lifecycle.sqlite'));
  let simulations: AppSimulationStore | undefined;
  let store: AppVersionStore;
  try {
    simulations = createAppSimulationStore(join(root, 'app-simulation.sqlite'));
    store = createAppVersionStore({ databasePath: join(root, 'app-versions.sqlite'), lifecycle, simulations, thumbnails });
  } catch (error) { simulations?.close(); lifecycle.close(); throw error; }
  return { ...store, close() { try { store.close(); } finally { try { simulations!.close(); } finally { lifecycle.close(); } } } };
}
