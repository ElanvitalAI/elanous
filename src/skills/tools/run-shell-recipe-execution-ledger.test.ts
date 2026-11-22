import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { appendExecution } from './run-shell-recipe-execution-ledger.js';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'recipe-audit-')), 'executions.jsonl');
const row = (runId: string, phase: string) => ({ runId, phase });
test('start and finish are unique across completed and pending runs', () => {
  const path = fresh();
  appendExecution(path, row('one', 'start'));
  expect(() => appendExecution(path, row('one', 'start'))).toThrow();
  appendExecution(path, row('one', 'finish'));
  expect(() => appendExecution(path, row('one', 'finish'))).toThrow();
  expect(() => appendExecution(path, row('one', 'start'))).toThrow();
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
});
test('rejects corrupted ledger and reserves terminal room before start', () => {
  const path = fresh();
  writeFileSync(path, '{broken}\n', { mode: 0o600 });
  expect(() => appendExecution(path, row('one', 'start'))).toThrow();
  const rows = Array.from({ length: 1020 }, (_, i) => JSON.stringify({ runId: String(i), phase: 'start', pad: 'x'.repeat(4000) }) + '\n').join('');
  writeFileSync(path, rows, { mode: 0o600 });
  expect(() => appendExecution(path, row('one', 'start'))).toThrow();
});

test('near capacity, concurrent starts compete for one terminal reservation', async () => {
  const path = fresh();
  const limit = 4_194_304; // 출처: #39649 EXECUTION_LEDGER_LIMIT in run-shell-recipe-execution-ledger.ts
  const makeLine = (id: string, phase: string, length: number) => {
    const base = JSON.stringify({ runId: id, phase, pad: '' }) + '\n';
    return JSON.stringify({ runId: id, phase, pad: 'x'.repeat(length - Buffer.byteLength(base)) }) + '\n';
  };
  // Valid completed runs fill all but two maximal rows and a small start.
  const start = JSON.stringify(row('live', 'start')) + '\n';
  const total = limit - 4096 - Buffer.byteLength(start);
  const lines: string[] = [];
  let remaining = total;
  for (let i = 0; remaining > 0; i++) {
    const size = Math.min(4096, remaining);
    // Alternate complete pairs, with two last rows sized so neither is tiny.
    if (remaining < 8192) {
      const a = Math.floor(remaining / 2);
      lines.push(makeLine(String(i), 'start', a), makeLine(String(i), 'finish', remaining - a));
      remaining = 0;
    } else {
      lines.push(makeLine(String(i), 'start', size), makeLine(String(i), 'finish', 4096));
      remaining -= size + 4096;
    }
  }
  writeFileSync(path, lines.join(''), { mode: 0o600 });
  // Cross-process locking is the production boundary, not an in-process Promise race.
  const ids = ['run0', 'run1', 'run2', 'run3', 'run4', 'run5'];
  const results = await race(path, 'start', ids);
  expect(results.filter(code => code === 0)).toHaveLength(1);
  expect(results.filter(code => code === 2)).toHaveLength(ids.length - 1);
  const winner = ids[results.indexOf(0)]!;
  expect(() => appendExecution(path, row('other', 'start'))).toThrow('terminal reserve');
  const finishBase = JSON.stringify({ runId: winner, phase: 'finish', pad: '' }) + '\n';
  appendExecution(path, { ...row(winner, 'finish'), pad: 'x'.repeat(4096 - Buffer.byteLength(finishBase)) });
  expect(Buffer.byteLength(readFileSync(path))).toBe(limit);
}, 30_000);

test('validates the serialized row rather than a misleading toJSON object', () => {
  const path = fresh();
  appendExecution(path, row('existing', 'start'));
  expect(() => appendExecution(path, {
    ...row('other', 'start'), toJSON: () => row('existing', 'start'),
  })).toThrow('duplicate recipe execution start');
  appendExecution(path, row('existing', 'finish'));
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
});

const race = (path: string, phase: string, ids: string[]) => Promise.all(ids.map(id => new Promise<number>((resolve, reject) => {
  const code = `import { appendExecution } from ${JSON.stringify(new URL('./run-shell-recipe-execution-ledger.ts', import.meta.url).href)};
    try { appendExecution(${JSON.stringify(path)}, {runId: ${JSON.stringify(id)}, phase: ${JSON.stringify(phase)}}); }
    catch (error) { process.exitCode = String(error).includes('terminal reserve') ? 2 : 1; }`;
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  child.on('error', reject);
  child.on('exit', code => resolve(code ?? -1));
})));

test('concurrent processes serialize duplicate and distinct starts and terminals', async () => {
  const path = fresh();
  const ids = Array.from({ length: 12 }, (_, i) => `run-${i}`);
  expect((await race(path, 'start', ids)).filter(code => code === 0)).toHaveLength(ids.length);
  expect((await race(path, 'start', Array(8).fill('duplicate'))).filter(code => code === 0)).toHaveLength(1);
  expect((await race(path, 'finish', Array(8).fill('duplicate'))).filter(code => code === 0)).toHaveLength(1);
  expect((await race(path, 'finish', ids)).filter(code => code === 0)).toHaveLength(ids.length);
  const entries = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const id of [...ids, 'duplicate']) {
    expect(entries.filter(entry => entry.runId === id).map(entry => entry.phase)).toEqual(['start', 'finish']);
  }
}, 30_000);
