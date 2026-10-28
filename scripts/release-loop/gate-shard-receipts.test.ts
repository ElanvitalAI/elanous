import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateShardReceiptPath, markGateShardUnmeasured, readGateShardResult, saveGateShardResult } from './gate-shard-receipts.js';
import type { GateShardReceipt } from './gate-shard-dispatch.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const receipt = (): GateShardReceipt => ({ id: 'pod-0', files: ['src/a.test.ts'], head40: 'a'.repeat(40), base40: 'b'.repeat(40),
  host: 'node-b', envKey: 'env:sha256', status: 'complete', failureIds: [], errorIds: [], evidencePath: 'pending',
  evidenceSha256: '0'.repeat(64), measuredAt: '2026-10-27T00:00:00.000Z', attempt: 1 });

test('only exact head/base/files/env and intact measured bytes may be inherited', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-')); roots.push(root);
  const original = receipt();
  const saved = saveGateShardResult(root, { receipt: original,
    runs: [{ output: '1 pass\n0 fail\nRan 1 test across 1 file.\n', rc: 0, pass: 1, fail: 0, errors: 0, ran: 1, files: 1, passedIds: ['src/a.test.ts > pass'] }] });
  const expected = { shard: original, head40: original.head40, base40: original.base40, envKey: original.envKey };
  expect(readGateShardResult(root, expected)?.runs[0]?.ran).toBe(1);
  expect(readGateShardResult(root, { ...expected, head40: 'c'.repeat(40) })).toBeNull();
  expect(readGateShardResult(root, { ...expected, base40: 'c'.repeat(40) })).toBeNull();
  expect(readGateShardResult(root, { ...expected, shard: { id: original.id, files: ['src/b.test.ts'] } })).toBeNull();
  expect(readGateShardResult(root, { ...expected, envKey: 'other' })).toBeNull();
  writeFileSync(join(root, saved.evidencePath), readFileSync(join(root, saved.evidencePath), 'utf8') + 'tampered');
  expect(readGateShardResult(root, expected)).toBeNull();
});

test('a replacement attempt blocks reuse of its predecessor before execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-')); roots.push(root);
  const old = receipt();
  saveGateShardResult(root, { receipt: old,
    runs: [{ output: '1 pass\n0 fail\nRan 1 test across 1 file.\n', rc: 0, pass: 1, fail: 0, errors: 0, ran: 1, files: 1, passedIds: [] }] });
  markGateShardUnmeasured(root, { ...old, attempt: 2 });
  expect(JSON.parse(readFileSync(gateShardReceiptPath(root, old.id), 'utf8')).status).toBe('unmeasured');
  expect(readGateShardResult(root, { shard: old, head40: old.head40, base40: old.base40, envKey: old.envKey })).toBeNull();
});
