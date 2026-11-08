import { debug } from '../../debug/log.js';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

export const NEXUS_FUNNEL_CATEGORY = 'nexus.funnel' as const;
export const NEXUS_FUNNEL_PAID_CONVERSION_WINDOW_DAYS = 30 as const;
const PAID_CONVERSION_WINDOW_MS = NEXUS_FUNNEL_PAID_CONVERSION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const HASH_PATTERN = /^[a-f\d]{64}$/iu;
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export type NexusFunnelEvent =
  | { type: 'signup'; accountHash: string; inviteSource: 'invite' | 'organic' }
  | { type: 'first-success'; accountHash: string; appHash: string }
  | { type: 'app-open'; accountHash: string; appHash: string }
  | { type: 'limit-reached'; accountHash: string; appHash?: string }
  | { type: 'paid-convert'; accountHash: string; limitReachedAt: string }
  | { type: 'invite-sent'; accountHash: string };

export type NexusFunnelEventSink = (event: NexusFunnelEvent) => unknown;

export interface NexusFunnelRuntime {
  readonly accountHash: string;
  readonly appHash: (appSlug: string) => string;
  readonly recordFirstSuccess: (appSlug: string) => boolean;
  readonly observe: NexusFunnelEventSink;
}

/** Atomically claims the first-success marker for this installation/app across process restarts. */
export function claimNexusFunnelFirstSuccess(directory: string, markerHash: string): boolean {
  mkdirSync(directory, { recursive: true });
  let fd: number;
  try {
    fd = openSync(join(directory, `${markerHash}.seen`), 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  closeSync(fd);
  return true;
}

/** Hash stable installation/app identifiers before they enter an event payload. */
export function hashNexusFunnelIdentity(namespace: 'account' | 'app', identity: string): string {
  return createHash('sha256').update(`nexus-funnel:${namespace}:`, 'utf8').update(identity, 'utf8').digest('hex');
}

export function createNexusFunnelRuntime(
  installationIdentity: string,
  observe: NexusFunnelEventSink = observeNexusFunnelEvent,
  claimFirstSuccess?: (appHash: string) => boolean,
): NexusFunnelRuntime {
  const firstSuccessApps = new Set<string>();
  const appHash = (appSlug: string) => hashNexusFunnelIdentity('app', appSlug);
  const accountHash = hashNexusFunnelIdentity('account', installationIdentity);
  return {
    accountHash,
    appHash,
    recordFirstSuccess(appSlug) {
      const markerHash = createHash('sha256')
        .update(`nexus-funnel:first-success:${accountHash}:`, 'utf8')
        .update(appHash(appSlug), 'utf8')
        .digest('hex');
      if (firstSuccessApps.has(markerHash)) return false;
      firstSuccessApps.add(markerHash);
      try { return claimFirstSuccess ? claimFirstSuccess(markerHash) : true; }
      catch { return false; }
    },
    observe,
  };
}

/** Identity storage is optional for analytics: failure disables events without blocking Nexus startup. */
export function tryCreateNexusFunnelRuntime(
  getInstallationIdentity: () => string,
  observe: NexusFunnelEventSink = observeNexusFunnelEvent,
  claimFirstSuccess?: (appHash: string) => boolean,
): NexusFunnelRuntime | undefined {
  try { return createNexusFunnelRuntime(getInstallationIdentity(), observe, claimFirstSuccess); }
  catch { return undefined; }
}

/** Funnel logging must never interrupt the product request, even when a test or sink throws. */
export function emitNexusFunnelEvent(runtime: NexusFunnelRuntime | undefined, event: NexusFunnelEvent): void {
  try { runtime?.observe(event); } catch { /* Analytics is fail-soft by contract. */ }
}

type FunnelLog = (category: string, event: string, data: Readonly<Record<string, unknown>>) => void;

export interface NexusFunnelObserverOptions {
  /** Injected by contract tests; production callers should use observeNexusFunnelEvent. */
  log?: FunnelLog;
  /** The event timestamp is supplied by debug.log; this clock only assigns the KST week bucket. */
  now?: () => Date;
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function parseUtcTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!parts) return undefined;
  const [, year, month, day, hour, minute, second] = parts;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day) || parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) || parsed.getUTCSeconds() !== Number(second)
  ) return undefined;
  return timestamp;
}

function weekStartKst(at: Date): string | undefined {
  const epoch = at.getTime();
  if (!Number.isFinite(epoch)) return undefined;

  const local = new Date(epoch + KST_OFFSET_MS);
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  local.setUTCDate(local.getUTCDate() - daysSinceMonday);
  local.setUTCHours(0, 0, 0, 0);
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}T00:00:00+09:00`;
}

function eventData(event: NexusFunnelEvent, week: string, eventAt: Date): Readonly<Record<string, unknown>> | undefined {
  if (!isHash(event.accountHash)) return undefined;
  const base = { accountHash: event.accountHash.toLowerCase(), weekStartKst: week };

  switch (event.type) {
    case 'signup':
      if (event.inviteSource !== 'invite' && event.inviteSource !== 'organic') return undefined;
      return { ...base, inviteSource: event.inviteSource };
    case 'first-success':
    case 'app-open':
      if (!isHash(event.appHash)) return undefined;
      return { ...base, appHash: event.appHash.toLowerCase() };
    case 'limit-reached':
      if (event.appHash !== undefined && !isHash(event.appHash)) return undefined;
      return { ...base, ...(event.appHash ? { appHash: event.appHash.toLowerCase() } : {}) };
    case 'paid-convert':
      const limitReachedAt = parseUtcTimestamp(event.limitReachedAt);
      if (limitReachedAt === undefined) return undefined;
      const elapsed = eventAt.getTime() - limitReachedAt;
      if (elapsed < 0 || elapsed > PAID_CONVERSION_WINDOW_MS) return undefined;
      return { ...base, conversionWindowDays: NEXUS_FUNNEL_PAID_CONVERSION_WINDOW_DAYS };
    case 'invite-sent':
      return base;
    default:
      return undefined;
  }
}

/** Creates a fail-soft logger; the injectable sink and clock exist for contract tests. */
function createNexusFunnelObserver(options: NexusFunnelObserverOptions = {}): (event: NexusFunnelEvent) => boolean {
  const log = options.log ?? ((category, event, data) => debug.log(category, event, data));
  const now = options.now ?? (() => new Date());

  return (event) => {
    try {
      const eventAt = now();
      const week = weekStartKst(eventAt);
      if (!week || !event || typeof event !== 'object') return false;
      const data = eventData(event, week, eventAt);
      if (!data || !NEXUS_FUNNEL_EVENT_TYPES.includes(event.type)) return false;
      log(NEXUS_FUNNEL_CATEGORY, event.type, data);
      return true;
    } catch {
      // Analytics must never block signup, app use, quota checks, or payment flows.
      return false;
    }
  };
}

export const NEXUS_FUNNEL_EVENT_TYPES = [
  'signup',
  'first-success',
  'app-open',
  'limit-reached',
  'paid-convert',
  'invite-sent',
] as const;

/** Production callers use the default debug logger; tests may replace only the sink and clock. */
export function observeNexusFunnelEvent(event: NexusFunnelEvent, options: NexusFunnelObserverOptions = {}): boolean {
  return createNexusFunnelObserver(options)(event);
}
