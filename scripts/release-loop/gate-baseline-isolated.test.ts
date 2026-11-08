import { expect, test } from 'bun:test';
import { diffFailures } from './gate-diff.js';
import { runPairedIsolatedBatch, runPairedIsolatedBatches } from './gate-baseline-isolated.js';

const CUT = 'a'.repeat(40);
const BASELINE = 'b'.repeat(40);

test('GATE-BASELINE-SWEEP-TO-ISOLATED simulation: three failed files are isolated in paired batches with stable attribution', async () => {
  const A = 'src/a.test.ts > preexisting';
  const B = 'src/b.test.ts > introduced B';
  const C = 'src/c.test.ts > introduced C';
  const cutByFile: Record<string, string[]> = { 'src/a.test.ts': [A], 'src/b.test.ts': [B], 'src/c.test.ts': [C] };
  const baselineByFile: Record<string, string[]> = { 'src/a.test.ts': [A], 'src/b.test.ts': [], 'src/c.test.ts': [] };
  const starts: string[] = [];
  let bothInFlight = false;
  const paired = await runPairedIsolatedBatch({
    cutFiles: Object.keys(cutByFile),
    baselineFiles: Object.keys(cutByFile),
    cutCommit: CUT,
    baselineCommit: BASELINE,
    async runBatch(files, commit) {
      starts.push(commit);
      bothInFlight ||= starts.includes(CUT) && starts.includes(BASELINE);
      await Promise.resolve();
      const fixture = commit === CUT ? cutByFile : baselineByFile;
      return new Map(files.map((file) => [file, fixture[file]!]));
    },
  });

  expect(starts).toEqual([CUT, BASELINE]);
  expect(bothInFlight).toBe(true);
  expect(paired.failures).toEqual([]);
  expect([...paired.cut.values()].flat()).toEqual([A, B, C]);
  expect(diffFailures([...paired.cut.values()].flat(), [...paired.baseline.values()].flat()))
    .toEqual({ newFailures: [B, C], fixed: [], common: [A] });
});

test('paired isolated batches retain cut success when baseline throws synchronously', async () => {
  const cutResult = new Map<string, string[]>([['src/a.test.ts', ['failure']]]);
  const paired = await runPairedIsolatedBatch({
    cutFiles: ['src/a.test.ts'], baselineFiles: ['src/a.test.ts'], cutCommit: CUT, baselineCommit: BASELINE,
    runBatch(files, commit) {
      if (commit === BASELINE) throw new Error('baseline sync failure');
      return Promise.resolve(new Map(files.map((file) => [file, ['failure']])));
    },
  });
  expect(paired.cut).toEqual(cutResult);
  expect(paired.baseline).toEqual(new Map());
  expect(paired.failures).toHaveLength(1);
  expect(String(paired.failures[0])).toContain('baseline sync failure');
});

test('paired isolated batches retain both rejection reasons when both sides fail', async () => {
  const paired = await runPairedIsolatedBatch({
    cutFiles: ['src/a.test.ts'], baselineFiles: ['src/a.test.ts'], cutCommit: CUT, baselineCommit: BASELINE,
    async runBatch(_files, commit) { throw new Error(commit === CUT ? 'cut failure' : 'baseline failure'); },
  });
  expect(paired.cut).toEqual(new Map());
  expect(paired.baseline).toEqual(new Map());
  expect(paired.failures.map(String)).toEqual(['Error: cut failure', 'Error: baseline failure']);
});

test('paired isolated batch skips an empty baseline while preserving cut results', async () => {
  const calls: string[] = [];
  const paired = await runPairedIsolatedBatch({
    cutFiles: ['src/a.test.ts'], baselineFiles: [], cutCommit: CUT, baselineCommit: BASELINE,
    async runBatch(files, commit) { calls.push(commit); return new Map(files.map((file) => [file, ['cut failure']])); },
  });
  expect(calls).toEqual([CUT]);
  expect(paired.cut).toEqual(new Map([['src/a.test.ts', ['cut failure']]]));
  expect(paired.baseline).toEqual(new Map());
  expect(paired.failures).toEqual([]);
});

test('paired isolated batches split nine files into 8+1 and reuse measured baseline rows', async () => {
  const files = Array.from({ length: 9 }, (_, index) => `src/pair-${index}.test.ts`);
  const ids = files.map((file) => `${file} > failure`);
  const calls: Array<{ commit: string; files: string[] }> = [];
  const measuredBaseline = new Map([[files[0]!, [ids[0]!]]]);
  const paired = await runPairedIsolatedBatches({
    cutFiles: files, baselineFiles: files, cachedBaseline: measuredBaseline, maxBatchFiles: 8,
    cutCommit: CUT, baselineCommit: BASELINE,
    async runBatch(batchFiles, commit) {
      calls.push({ commit, files: [...batchFiles] });
      const failures = commit === CUT ? ids : [];
      return new Map(batchFiles.map((file) => [file, failures.filter((id) => id.startsWith(`${file} > `))]));
    },
  });
  expect(calls).toEqual([
    { commit: CUT, files: files.slice(0, 8) },
    { commit: BASELINE, files: files.slice(1, 8) },
    { commit: CUT, files: files.slice(8) },
    { commit: BASELINE, files: files.slice(8) },
  ]);
  expect(paired.batches).toBe(2);
  expect(diffFailures([...paired.cut.values()].flat(), [...paired.baseline.values()].flat()))
    .toEqual({ newFailures: ids.slice(1), fixed: [], common: [ids[0]] });
  expect(paired.failures).toEqual([]);
});

test('paired isolated batches skip baseline-absent files and fail closed on an incomplete result map', async () => {
  const files = ['src/a.test.ts', 'src/b.test.ts'];
  const calls: Array<{ commit: string; files: string[] }> = [];
  const absent = await runPairedIsolatedBatches({
    cutFiles: files, baselineFiles: [files[0]!], maxBatchFiles: 8, cutCommit: CUT, baselineCommit: BASELINE,
    async runBatch(batchFiles, commit) {
      calls.push({ commit, files: [...batchFiles] });
      return new Map(batchFiles.map((file) => [file, [file]]));
    },
  });
  expect(calls).toEqual([{ commit: CUT, files }, { commit: BASELINE, files: [files[0]!] }]);
  expect(absent.failures).toEqual([]);

  const incomplete = await runPairedIsolatedBatch({
    cutFiles: files, baselineFiles: files, cutCommit: CUT, baselineCommit: BASELINE,
    async runBatch(batchFiles, commit) {
      const returned = commit === BASELINE ? batchFiles.slice(0, 1) : batchFiles;
      return new Map(returned.map((file) => [file, [file]]));
    },
  });
  expect(incomplete.cut.size).toBe(2);
  expect(incomplete.baseline.size).toBe(1);
  expect(incomplete.failures.map(String)).toEqual([`Error: paired isolated baseline batch missing result: ${files[1]}`]);
});
