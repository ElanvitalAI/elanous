import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLedger } from './event-ledger.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('event identity is provider plus eventId and survives reopening JSONL', () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-ledger-'));
  roots.push(root);
  const path = join(root, 'connectors', 'events.jsonl');
  const ledger = new EventLedger(path);
  expect(ledger.seen('linear', 'delivery-1')).toBe(false);
  expect(ledger.record('linear', 'delivery-1')).toBe(true);
  expect(ledger.record('linear', 'delivery-1')).toBe(false);
  expect(new EventLedger(path).seen('linear', 'delivery-1')).toBe(true);
  expect(ledger.seen('asana', 'delivery-1')).toBe(false);
  expect(ledger.seen('linear', 'delivery-2')).toBe(false);
  expect(JSON.parse(readFileSync(path, 'utf8').trim())).toEqual({ provider: 'linear', eventId: 'delivery-1' });
});

test('distinct delivery and polling ids for one revision share a change key', () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-ledger-cross-'));
  roots.push(root);
  const ledger = new EventLedger(join(root, 'events.jsonl'));
  const change = { ref: 'id-5', occurredAt: '2026-09-27T00:00:00Z' };
  expect(ledger.record('linear', 'delivery-1', change)).toBe(true);
  expect(ledger.seen('linear', `${change.ref}:${change.occurredAt}`)).toBe(false);
  expect(new EventLedger(ledger.path).seenChange('linear', change.ref, change.occurredAt)).toBe(true);
  expect(ledger.record('linear', `${change.ref}:${change.occurredAt}`, change)).toBe(false);
  expect(ledger.seenChange('asana', change.ref, change.occurredAt)).toBe(false);
  expect(ledger.seenChange('linear', change.ref, '2026-09-27T00:00:01Z')).toBe(false);
});
