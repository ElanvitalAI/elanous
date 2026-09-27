import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordRoutedLinkAbsorbed } from './link-ledger.js';
import { ingestIntakeItems, intakeItemId, intakeLedgerDir, loadIntakeLedger, markIntakeItem, pickAbsorbQueue } from './items.js';

const roots: string[] = [];
const now = '2026-09-27T01:00:00.000Z';
const source = 'telegram-bot';
const url = 'https://example.org/post?a=1&b=2';
const notePath = '/vault/note.md';
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'link-ledger-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    try { chmodSync(intakeLedgerDir(dir), 0o700); } catch { /* folder may not exist */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('new URL creates a telegram-bot absorbed item with one note output', () => {
  const dir = root();
  const id = recordRoutedLinkAbsorbed(dir, { source, url, notePath, title: 'Note' }, now);
  expect(id).toBe(intakeItemId(source, { url }));
  expect([...loadIntakeLedger(dir).items.values()]).toMatchObject([{
    id, source, status: 'absorbed', title: 'Note', outputs: [{ kind: 'note', ref: notePath }],
  }]);
});

test('same URL with reordered query parameters merges into the same item', () => {
  const dir = root();
  const id = recordRoutedLinkAbsorbed(dir, { source, url, notePath }, now);
  const again = recordRoutedLinkAbsorbed(dir, { source, url: 'https://example.org/post?b=2&a=1', notePath }, now);
  expect(again).toBe(id);
  expect(loadIntakeLedger(dir).items.size).toBe(1);
});

test('queued item becomes absorbed and cannot be selected by the 07:00 queue', () => {
  const dir = root();
  ingestIntakeItems(dir, 'youtube', [{ url }], now, () => {});
  const id = intakeItemId(source, { url });
  expect(markIntakeItem(dir, id, { status: 'queued' }, now)).toBe(true);
  expect(loadIntakeLedger(dir).items.get(id)?.status).toBe('queued');
  expect(recordRoutedLinkAbsorbed(dir, { source, url, notePath }, now)).toBe(id);
  expect(loadIntakeLedger(dir).items.get(id)).toMatchObject({
    status: 'absorbed', sources: ['youtube', 'telegram-bot'], outputs: [{ kind: 'note', ref: notePath }],
  });
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, '2026-09-29T07:00:00.000Z')).toEqual([]);
});

test('read-only ledger directory fails soft without throwing', () => {
  const dir = root();
  const ledgerDir = intakeLedgerDir(dir);
  mkdirSync(ledgerDir);
  // Root can bypass permission bits; an occupied ledger filename also prevents writes.
  const rootUser = process.getuid?.() === 0;
  if (rootUser) mkdirSync(join(ledgerDir, 'items.jsonl'));
  chmodSync(ledgerDir, 0o500);
  try {
    expect(recordRoutedLinkAbsorbed(dir, { source, url, notePath }, now)).toBeNull();
    if (!rootUser) expect(loadIntakeLedger(dir).items.size).toBe(0);
  } finally {
    chmodSync(ledgerDir, 0o700);
  }
});
