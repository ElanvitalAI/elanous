import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { buildIntakeDraftFromRaw } from './draft.js';
import { recordSketchInLedger } from './sketch-ledger.js';
import type { IntakeStore } from './store.js';
import type { IntakeSession, RawIntakeRecord } from './types.js';

export function captureAndDraftIntakeRecord(
  store: IntakeStore,
  raw: RawIntakeRecord,
  opts: { normalizedDetailSource?: string; ledgerRoot?: string } = {},
): IntakeSession {
  store.capture(raw);
  try {
    const id = recordSketchInLedger(opts.ledgerRoot ?? effectiveInstanceRoot(), raw);
    if (id) debug.log('intake.sketch-ledger', 'recorded', { source: raw.source, hasUrl: /https?:\/\//.test(raw.rawText) });
  } catch (error) {
    // Ledger persistence is best-effort; capture and drafting remain available. 본문·경로는 싣지 않는다.
    const reason = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof Error ? error.name : 'unknown';
    debug.log('intake.sketch-ledger', 'record-failed', { source: raw.source, reason });
  }
  store.setState(raw.intakeId, 'normalized', {
    source: opts.normalizedDetailSource ?? `intake:${raw.source}`,
  });
  const draft = buildIntakeDraftFromRaw(raw);
  return store.saveDraft(raw.intakeId, draft);
}
