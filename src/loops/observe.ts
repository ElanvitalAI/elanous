import { debug } from '../debug/log.js';

/** Event vocabulary of the loop-agent manifest observability contract. */
export const LOOP_EVENTS = [
  'tick', 'posture-change', 'resolution-change', 'grounding', 'heartbeat',
  'absent', 'exchange', 'spawn', 'reap', 'promote', 'hitl',
] as const;

const LOOP_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REQUIRED_CONTEXT = ['runId', 'profile', 'reason', 'sourceRef'] as const;

function validId(id: unknown): id is string {
  return typeof id === 'string' && LOOP_ID.test(id);
}

function reject(reason: 'invalid-loop-id' | 'invalid-event' | 'invalid-data'): void {
  // Never include untrusted identifiers, event names or payloads in a log category.
  debug.log('loop.observe', 'rejected', { reason });
}

/** Category matches observability.category in the loop-agent manifest. */
export function loopCategory(id: string): string {
  if (!validId(id)) {
    reject('invalid-loop-id');
    throw new Error('invalid loop id');
  }
  return `loop.${id}`;
}

/** Emit an RFC loop event, retaining absent context as a measurable list. */
export function loopEvent(loopId: string, event: string, data: Record<string, unknown>): void {
  if (!validId(loopId)) {
    reject('invalid-loop-id');
    return;
  }
  if (typeof event !== 'string' || !LOOP_EVENTS.some(name => name === event)) {
    reject('invalid-event');
    return;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)
    || Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null
    || (Object.hasOwn(data, 'loopId') && data.loopId !== loopId)) {
    reject('invalid-data');
    return;
  }
  const missingRequired = REQUIRED_CONTEXT.filter(field =>
    typeof data[field] !== 'string' || !(data[field] as string).trim());
  debug.log(`loop.${loopId}`, event, { ...data, loopId, missingRequired });
}
