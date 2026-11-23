import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateReceiptClosureCache, savePassingGateFileReceipts } from './gate-runtime.js';
import { debug } from '../../src/debug/log.js';
import { gateFileReceiptIdentityFromClosure } from './gate-file-receipts.js';

test('reports one tree and graph build, with RSS and elapsed time, while preserving reuse', () => {
  const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
    if (data && typeof data === 'object') observed.push({ event, data: data as Record<string, unknown> });
  });
  try {
    const files = ['src/one.test.ts'];
    const cache = createGateReceiptClosureCache('/fixture', () => ({ files, read: () => 'export const x = 1;', preload: [] }));
    const commit = 'a'.repeat(40), image = `sha256:${'b'.repeat(64)}`;
    const first = gateFileReceiptIdentityFromClosure(cache(commit), files[0]!, image);
    const second = gateFileReceiptIdentityFromClosure(cache(commit), files[0]!, image);
    expect(first).toEqual(second);
    const events = observed.filter(row => row.event === 'receipt-tree-build' || row.event === 'receipt-graph-build');
    expect(events.map(row => `${row.event}:${row.data.phase}`)).toEqual([
      'receipt-tree-build:started', 'receipt-tree-build:completed',
      'receipt-graph-build:started', 'receipt-graph-build:completed',
    ]);
    for (const event of events) expect(typeof event.data.rssBytes).toBe('number');
    for (const event of events.filter(row => row.data.phase === 'completed')) expect(typeof event.data.elapsedMs).toBe('number');
  } finally { spy.mockRestore(); }
});

test('many shard receipts reuse a single cut tree and keep actual receipt evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-closure-cache-'));
  try {
    const commit = 'a'.repeat(40);
    const files = Array.from({ length: 24 }, (_, i) => `src/shard-${i}.test.ts`); // 출처: #134519 — synthetic multi-shard gate
    let builds = 0;
    const cache = createGateReceiptClosureCache(root, (_repo, sha) => {
      builds++;
      if (sha !== commit) throw new Error('unexpected cut');
      return { files, read: file => files.includes(file) ? 'export const sample = true;' : undefined, preload: [] };
    });
    const completed: number[] = [];
    for (const [index, file] of files.entries()) {
      completed.push(savePassingGateFileReceipts({ repo: root, root, files: [file], commit,
        imageDigest: `sha256:${'b'.repeat(64)}`, runs: [{ rc: 0, pass: 1, fail: 0, errors: 0, passedIds: [`${file} > passes`] }],
        shardId: `pod-${index}`, attempt: 1, host: 'fixture', closureTreeFactory: () => cache(commit) }));
    }
    expect(completed).toEqual(files.map(() => 1));
    expect(builds).toBe(1);
    expect(readdirSync(join(root, 'files'))).toHaveLength(files.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed cut build is retried and a different cut never inherits the previous tree', () => {
  const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
    if (data && typeof data === 'object') observed.push({ event, data: data as Record<string, unknown> });
  });
  try {
  let calls = 0;
  const cache = createGateReceiptClosureCache('/fixture', (_repo, sha) => {
    calls++;
    if (calls === 1) throw new Error('not available');
    return { files: [sha], read: () => '', preload: [] };
  });
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  expect(() => cache(a)).toThrow('not available');
  const first = cache(a);
  expect(cache(a)).toBe(first);
  expect(cache(b)).not.toBe(first);
  expect(calls).toBe(3);
  expect(observed.filter(row => row.event === 'receipt-tree-build').map(row => row.data.phase))
    .toEqual(['started', 'failed', 'started', 'completed', 'started', 'completed']);
  } finally { spy.mockRestore(); }
});
