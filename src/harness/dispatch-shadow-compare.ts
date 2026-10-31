import { debug } from '../debug/log.js';

/** Input contract for a dispatcher decision to be compared at the product entry. */
export const DISPATCH_SHADOW_COMPARE_ENV = 'ELANOUS_DISPATCH_SHADOW_COMPARE';

export interface DispatchShadowCompareContext {
  requestId: string;
  cellId: string;
  tickId: string;
  snapshotHash: string;
  dispatcherAction: string;
  dispatcherReason: string;
  loopShadowAction: string;
  loopShadowReason: string;
  policyVersion: string;
  runId: string;
}

export interface DispatchShadowCompareEntry {
  entrance: string;
  productEntryAction: 'queue' | 'launch-gate';
  productEntryReason: string;
}

const CONTEXT_FIELDS = [
  'requestId', 'cellId', 'tickId', 'snapshotHash', 'dispatcherAction', 'dispatcherReason',
  'loopShadowAction', 'loopShadowReason', 'policyVersion', 'runId',
] as const;
const MAX_CONTEXT_BYTES = 2048;
const MAX_VALUE_LENGTH = 240;

function compactString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compact = value.replace(/[\r\n\t]+/g, ' ').trim();
  return compact.length > 0 && compact.length <= MAX_VALUE_LENGTH ? compact : undefined;
}

/** Parse the dispatcher handoff without making malformed optional metadata affect launches. */
export function parseDispatchShadowCompareContext(raw: string | undefined): DispatchShadowCompareContext | undefined {
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_CONTEXT_BYTES) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const fields = Object.fromEntries(CONTEXT_FIELDS.map(field => [field, compactString(row[field])])) as
    Record<(typeof CONTEXT_FIELDS)[number], string | undefined>;
  if (CONTEXT_FIELDS.some(field => fields[field] === undefined)) return undefined;
  if (!/^[a-f0-9]{64}$/i.test(fields.snapshotHash!)) return undefined;
  return fields as DispatchShadowCompareContext;
}

/** One fail-soft comparison row; it only observes the product entry's selected route. */
export function recordDispatchShadowCompare(
  context: DispatchShadowCompareContext | undefined,
  entry: DispatchShadowCompareEntry,
  log: (category: string, event: string, data: unknown) => void = (category, event, data) => debug.log(category, event, data),
): void {
  if (!context) return;
  try {
    log('harness', 'dispatch.shadow.compare', {
      ...context,
      ...entry,
      agreement: context.dispatcherAction === context.loopShadowAction,
    });
  } catch { /* Measurement must not alter the harness entry or launch decision. */ }
}

export function recordDispatchShadowCompareFromEnv(
  raw: string | undefined,
  entry: DispatchShadowCompareEntry,
  log?: (category: string, event: string, data: unknown) => void,
): void {
  recordDispatchShadowCompare(parseDispatchShadowCompareContext(raw), entry, log);
}
