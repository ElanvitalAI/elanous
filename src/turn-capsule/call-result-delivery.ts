import { emitTurnLife } from '../debug/turn-life.js';
import type { CapsuleDoneEvent, CapsuleKind, CapsuleStatus } from './contract.js';

/** The queue owns result persistence and deduplication by capsuleId. */
export interface CapsuleResultSink {
  store(input: { capsuleId: string; sessionId: string; status: CapsuleStatus; output: string }): void | Promise<void>;
  /** Emit only after store succeeds. The caller supplies the B1 session bridge. */
  emit(event: CapsuleDoneEvent): void | Promise<void>;
  log?(event: string, data: Record<string, unknown>): void;
}

/** Delivers the full result through the queue and only a caller-redacted summary through the frame. */
export async function deliverCapsuleResult(input: {
  capsuleId: string;
  sessionId: string;
  kind: Extract<CapsuleKind, 'harness' | 'mcp'>;
  startedAt: number;
  endedAt: number;
  status: CapsuleStatus;
  output: string;
  /** Safe one-line label; never derive it from arguments or raw output. */
  summary: string;
}, sink: CapsuleResultSink): Promise<void> {
  if (!input.capsuleId || !input.sessionId || !Number.isFinite(input.startedAt)
    || !Number.isFinite(input.endedAt) || input.startedAt < 0 || input.endedAt < input.startedAt) {
    throw new RangeError('invalid capsule identity or timestamps');
  }
  await sink.store({ capsuleId: input.capsuleId, sessionId: input.sessionId, status: input.status, output: input.output });
  try { (sink.log ?? emitTurnLife)('turn-life:capsule-result-stored', { capsuleId: input.capsuleId }); } catch { /* observational */ }
  await sink.emit({ type: 'capsule-done', capsuleId: input.capsuleId, sessionId: input.sessionId, kind: input.kind,
    startedAt: input.startedAt, endedAt: input.endedAt, status: input.status,
    summary: input.summary.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 160) });
  try { (sink.log ?? emitTurnLife)('turn-life:capsule-done-emitted', { capsuleId: input.capsuleId }); } catch { /* observational */ }
}
