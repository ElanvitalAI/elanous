import { debug } from '../debug/log.js';
import { ingestIntakeItems, intakeItemId, markIntakeItem, type IntakeSource } from './items.js';

/** Record a URL route only after its note has been saved. Ledger failure must not block the reply. */
export function recordRoutedLinkAbsorbed(
  root: string,
  input: { source: IntakeSource; url: string; notePath: string; title?: string },
  now = new Date().toISOString(),
): string | null {
  try {
    const { source, url, notePath, title } = input;
    const id = intakeItemId(source, { url });
    ingestIntakeItems(root, source, [{ url, title }], now);
    if (!markIntakeItem(root, id, { status: 'absorbed', output: { kind: 'note', ref: notePath } }, now)) {
      throw new Error('item-not-found');
    }
    debug.log('intake.link-ledger', 'recorded', { source, id });
    return id;
  } catch (error) {
    // FS errors may embed the private note path. Only emit the error class/code.
    const reason = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof Error ? error.name : 'unknown';
    debug.log('intake.link-ledger', 'record-failed', { reason });
    return null;
  }
}
