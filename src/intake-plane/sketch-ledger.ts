import { canonicalUrl, ingestIntakeItems, intakeItemId, type IntakeSource, type RawIntakeItem } from './items.js';
import { extractLinks } from './normalize.js';
import type { RawIntakeRecord } from './types.js';

const SKETCH_LEDGER_SOURCES: Record<RawIntakeRecord['source'], IntakeSource> = {
  'tui-scratch': 'memo',
  'web-scratch': 'pwa',
  'mobile-scratch': 'pwa',
  voice: 'memo',
  telegram: 'telegram-bot',
  discord: 'memo',
  api: 'memo',
  document: 'memo',
  url: 'memo',
};

export function ledgerSourceForSketch(source: RawIntakeRecord['source']): IntakeSource {
  return SKETCH_LEDGER_SOURCES[source];
}

/** Record one captured sketch in the external intake ledger; empty sketches have no ledger item. */
export function recordSketchInLedger(instanceRoot: string, raw: RawIntakeRecord): string | undefined {
  const source = ledgerSourceForSketch(raw.source);
  const url = extractLinks(raw.rawText).find((link) => canonicalUrl(link) !== undefined);
  const text = raw.rawText.trim().slice(0, 2_000);
  if (!url && !text) return undefined;
  const item: RawIntakeItem = {
    ...(url ? { url } : {}),
    ...(text ? { text } : {}),
    observedAt: raw.receivedAt,
  };
  ingestIntakeItems(instanceRoot, source, [item], raw.receivedAt);
  return intakeItemId(source, item);
}
