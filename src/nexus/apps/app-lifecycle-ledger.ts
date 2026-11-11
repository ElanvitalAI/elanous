import { randomUUID } from 'node:crypto';

export type AppLifecycleAction =
  | 'created'
  | 'simulated'
  | 'receipt-issued'
  | 'promoted'
  | 'upgrade'
  | 'paused'
  | 'rolled-back'
  | 'trashed'
  | 'restored'
  | 'purged';

export type AppLifecycleEnvironment = 'simulation' | 'live';
export type AppLifecycleOutcome = 'succeeded' | 'failed' | 'blocked';
export type AppLifecycleStatus = 'draft' | 'live' | 'paused' | 'trashed' | 'purged';

/** Closed vocabulary: user input and provider error text must never become ledger codes. */
export const APP_LIFECYCLE_REASON_CODES = [
  'app-invalid',
  'app-not-found',
  'operation-failed',
  'permission-denied',
  'provider-unavailable',
  'receipt-missing',
  'receipt-stale',
  'resource-unavailable',
  'simulation-failed',
  'timeout',
] as const;

export type AppLifecycleReasonCode = typeof APP_LIFECYCLE_REASON_CODES[number];

/** One metadata-only row for a user-visible app lifecycle action. Payloads and personal data are excluded. */
export interface AppLifecycleEvent {
  readonly id: string;
  readonly appId: string;
  readonly action: AppLifecycleAction;
  readonly environment: AppLifecycleEnvironment;
  readonly actor: 'user' | 'system';
  readonly outcome: AppLifecycleOutcome;
  readonly occurredAt: string;
  readonly appVersion?: string;
  readonly appFingerprint?: string;
  readonly deviceCatalogVersion?: number;
  readonly runId?: string;
  readonly receiptId?: string;
  readonly reasonCode?: AppLifecycleReasonCode;
}

export type AppLifecycleEventInput = Omit<AppLifecycleEvent, 'id' | 'occurredAt' | 'outcome'> & {
  readonly occurredAt?: string;
  readonly outcome?: AppLifecycleOutcome;
};

export interface AppLifecycleEventOptions {
  readonly now?: () => Date;
  readonly id?: () => string;
}

export interface AppLifecycleSnapshot {
  readonly appId: string;
  readonly status: AppLifecycleStatus;
  readonly currentVersion: string | null;
  readonly previousVersion: string | null;
  readonly latestReceiptId: string | null;
  readonly latestEvent: AppLifecycleEvent;
  readonly eventCount: number;
}

const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const REASON_CODES = new Set<string>(APP_LIFECYCLE_REASON_CODES);
const ACTIONS = new Set<AppLifecycleAction>([
  'created', 'simulated', 'receipt-issued', 'promoted', 'upgrade', 'paused', 'rolled-back', 'trashed', 'restored', 'purged',
]);

function validateAppId(appId: unknown): string {
  if (typeof appId !== 'string' || !APP_ID.test(appId) || appId.includes('--') || appId.startsWith('xn--') || /-pr\d+$/.test(appId)) {
    throw new Error('invalid app lifecycle app id');
  }
  return appId;
}

function validateOpaqueId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value) || /(?:sk-|xai-|ghp_|gho_|github_pat_|AKIA|AIza|xoxb-)/i.test(value)) {
    throw new Error(`invalid app lifecycle ${field}`);
  }
  return value;
}

function validateVersion(value: unknown, field: string): string {
  if (typeof value !== 'string' || !VERSION_ID.test(value) || /(?:sk-|xai-|ghp_|gho_|github_pat_|AKIA|AIza|xoxb-)/i.test(value)) {
    throw new Error(`invalid app lifecycle ${field}`);
  }
  return value;
}

/** Validate an event read from an untrusted persistence boundary. */
export function validateAppLifecycleEvent(input: unknown): AppLifecycleEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid app lifecycle event');
  const event = input as Record<string, unknown>;
  const appId = validateAppId(event.appId);
  if (typeof event.action !== 'string' || !ACTIONS.has(event.action as AppLifecycleAction)) throw new Error('invalid app lifecycle action');
  if (event.environment !== 'simulation' && event.environment !== 'live') throw new Error('invalid app lifecycle environment');
  if (event.actor !== 'user' && event.actor !== 'system') throw new Error('invalid app lifecycle actor');
  if (event.outcome !== 'succeeded' && event.outcome !== 'failed' && event.outcome !== 'blocked') throw new Error('invalid app lifecycle outcome');
  const id = validateOpaqueId(event.id, 'event id');
  if (typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt)) || new Date(event.occurredAt).toISOString() !== event.occurredAt) {
    throw new Error('invalid app lifecycle timestamp');
  }
  if (event.appVersion !== undefined) validateVersion(event.appVersion, 'app version');
  if (event.appFingerprint !== undefined && (typeof event.appFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(event.appFingerprint))) throw new Error('invalid app lifecycle app fingerprint');
  if (event.deviceCatalogVersion !== undefined && (typeof event.deviceCatalogVersion !== 'number' || !Number.isSafeInteger(event.deviceCatalogVersion) || event.deviceCatalogVersion < 1)) {
    throw new Error('invalid app lifecycle device catalog version');
  }
  if (event.runId !== undefined) validateOpaqueId(event.runId, 'run id');
  if (event.receiptId !== undefined) validateOpaqueId(event.receiptId, 'receipt id');
  if (event.action === 'receipt-issued' && event.outcome === 'succeeded' && event.receiptId === undefined) {
    throw new Error('successful receipt-issued event requires a receipt id');
  }
  if (event.reasonCode !== undefined && (typeof event.reasonCode !== 'string' || !REASON_CODES.has(event.reasonCode))) throw new Error('invalid app lifecycle reason code');
  return {
    id,
    appId,
    action: event.action as AppLifecycleAction,
    environment: event.environment,
    actor: event.actor,
    outcome: event.outcome,
    occurredAt: event.occurredAt,
    ...(event.appVersion === undefined ? {} : { appVersion: event.appVersion as string }),
    ...(event.appFingerprint === undefined ? {} : { appFingerprint: event.appFingerprint as string }),
    ...(event.deviceCatalogVersion === undefined ? {} : { deviceCatalogVersion: event.deviceCatalogVersion as number }),
    ...(event.runId === undefined ? {} : { runId: event.runId as string }),
    ...(event.receiptId === undefined ? {} : { receiptId: event.receiptId as string }),
    ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode as AppLifecycleReasonCode }),
  };
}

/** Create a validated event without persisting it. Durable append belongs to the follow-up store slice. */
export function createAppLifecycleEvent(
  input: AppLifecycleEventInput,
  options: AppLifecycleEventOptions = {},
): AppLifecycleEvent {
  const event = {
    id: (options.id ?? randomUUID)(),
    appId: input.appId,
    action: input.action,
    environment: input.environment,
    actor: input.actor,
    outcome: input.outcome === undefined ? 'succeeded' : input.outcome,
    occurredAt: input.occurredAt === undefined ? (options.now ?? (() => new Date()))().toISOString() : input.occurredAt,
    ...(input.appVersion === undefined ? {} : { appVersion: input.appVersion }),
    ...(input.appFingerprint === undefined ? {} : { appFingerprint: input.appFingerprint }),
    ...(input.deviceCatalogVersion === undefined ? {} : { deviceCatalogVersion: input.deviceCatalogVersion }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.receiptId === undefined ? {} : { receiptId: input.receiptId }),
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
  } satisfies AppLifecycleEvent;
  return validateAppLifecycleEvent(event);
}

/** Pure projection for the tile. Persisting or wiring events to app operations is a separate slice. */
export function projectAppLifecycleSnapshot(
  appId: string,
  inputEvents: readonly AppLifecycleEvent[],
): AppLifecycleSnapshot | null {
  // Input array order is the lifecycle append order; occurredAt is metadata and is not used to reorder events.
  validateAppId(appId);
  const events = inputEvents.map(validateAppLifecycleEvent);
  if (events.some(event => event.appId !== appId)) throw new Error('app lifecycle event belongs to another app');
  if (events.length === 0) return null;

  let status: AppLifecycleStatus = 'draft';
  let statusBeforeTrash: AppLifecycleStatus = 'draft';
  let currentVersion: string | null = null;
  let previousVersion: string | null = null;
  let latestReceiptId: string | null = null;
  let hasCreatedApp = false;
  for (const event of events) {
    // Failed and blocked actions remain visible in history but cannot advance the projected state.
    if (event.outcome !== 'succeeded') continue;
    // Pre-creation history stays auditable but cannot seed state for an app that did not yet exist.
    if (!hasCreatedApp && event.action !== 'created') continue;
    // Permanent removal is terminal in this projection. Later events remain auditable in history,
    // but recreating a purged app requires a separate app identity and explicit create flow.
    if (status === 'purged') continue;
    switch (event.action) {
      case 'created':
        // App identity is single-create within a lifecycle. A duplicate create is history only.
        if (hasCreatedApp) break;
        hasCreatedApp = true;
        status = 'draft';
        currentVersion = event.appVersion ?? currentVersion;
        break;
      case 'receipt-issued':
        latestReceiptId = event.receiptId ?? null;
        break;
      case 'promoted':
      case 'upgrade':
        if (event.appVersion !== undefined && event.appVersion !== currentVersion) {
          previousVersion = currentVersion;
          currentVersion = event.appVersion;
        }
        status = 'live';
        break;
      case 'paused':
        status = 'paused';
        break;
      case 'rolled-back': {
        const rollbackVersion: string | null = event.appVersion ?? previousVersion;
        if (rollbackVersion !== null && rollbackVersion !== currentVersion) {
          previousVersion = currentVersion;
          currentVersion = rollbackVersion;
        }
        status = 'live';
        break;
      }
      case 'trashed':
        if (status !== 'trashed') statusBeforeTrash = status;
        status = 'trashed';
        break;
      case 'restored':
        status = status === 'trashed' ? statusBeforeTrash : status;
        break;
      case 'purged':
        status = 'purged';
        break;
      case 'simulated':
        break;
    }
  }
  if (!hasCreatedApp) return null;
  return {
    appId,
    status,
    currentVersion,
    previousVersion,
    latestReceiptId,
    latestEvent: events[events.length - 1]!,
    eventCount: events.length,
  };
}
