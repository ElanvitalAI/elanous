import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickWithHistory, recipeFor } from './node.js';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';

const ROOT = join(import.meta.dir, '..', '..');
/** A test file the worktree really tracks, so a gate-history hit has something to weight. */
const REPEAT_OFFENDER = 'scripts/ci-typecheck-changed.test.ts';
/** A tracked test file with no gate history and no TD1 disposition — a plain keep verdict. */
const PLAIN_KEEP = 'bin/elanous.test.ts';

/** GATE-FAIL-HISTORY input: one release-loop run ledger whose gate node names the repeat offender. */
function seedGateHistory(version: string, extra: { loadFlaky?: string[]; preexisting?: string[] } = {}): string {
  const stateDir = mkdtempSync(join(tmpdir(), 'test-diet-history-'));
  const runsDir = join(stateDir, 'graph-runs', 'release-loop');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, 'run-1.json'), JSON.stringify({
    runId: 'run-1',
    input: { version },
    nodes: [{
      nodeId: 'gate',
      output: {
        outcome: 'regression',
        commit: 'deadbeef',
        preexisting: extra.preexisting ?? [`${REPEAT_OFFENDER} > keeps the gate honest`],
        knownEnv: [],
        introduced: [],
        loadFlaky: extra.loadFlaky ?? [],
      },
    }],
  }));
  return stateDir;
}

/** The graph runner's own entry: `bun scripts/test-diet/node.ts <step>` with a JSON context env. */
function runStep(step: string, stateDir: string, input: Record<string, unknown> = {},
  outputs: Record<string, Record<string, unknown> | null> = {}) {
  const out = spawnSync(process.execPath, [join(ROOT, 'scripts/test-diet/node.ts'), step], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'test-diet', input, outputs }),
      ELANOUS_STATE_DIR: stateDir,
      ELANOUS_CONFIG_DIR: stateDir,
    },
  });
  const text = (out.stdout ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '';
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted below with the raw text */ }
  return { code: out.status, json, raw: out.stdout ?? '', err: out.stderr ?? '' };
}

/** The same sorted list the pick step itself lifts from `git ls-files` — no invented paths. */
function repoTestFiles(): string[] {
  const out = spawnSync('git', ['ls-files', '*.test.ts'], { cwd: ROOT, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  return (out.stdout ?? '').split('\n').filter(Boolean).sort();
}

/** A measure output for the files the pick step actually selected (a shadow run, rc 0 everywhere). */
function measureFor(files: readonly string[]): Record<string, unknown> {
  return { measurements: files.map((file) => ({ file, secs: 20, rssMb: 300, rc: 0, pass: 3, fail: 0 })),
    commit: 'deadbeef', host: 'node-b' };
}

function ledgerLines(stateDir: string): Array<Record<string, unknown>> {
  const path = join(stateDir, 'test-diet', 'ledger.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

/** Task-card drafts are files on the isolated root, so a card can be asserted by content. */
function cards(stateDir: string): string {
  const dir = join(stateDir, 'task-cards');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    .map((name) => readFileSync(join(dir, name), 'utf8')).join('\n');
}

describe('test-diet pick weighs gate-fail history', () => {
  test('a preexisting gate failure is picked ahead of a file with no history', () => {
    const stateDir = seedGateHistory('0.2.28');
    const { code, json, raw, err } = runStep('pick', stateDir);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    const picked = json.files as string[] | undefined;
    // The production entry must surface the history-weighted order, not just any list.
    expect({ picked: picked?.[0], raw: picked ? '' : raw.slice(0, 2000) }).toEqual({ picked: REPEAT_OFFENDER, raw: '' });
  });
});

describe('test-diet pick keeps the cursor on files the budget skipped', () => {
  const FILES = ['a.test.ts', 'b.test.ts', 'c.test.ts'];
  const costs = (secs: Record<string, number>) => new Map(Object.entries(secs));
  const history = (file: string, weight: number, preexisting: number) =>
    new Map([[file, { file, weight, preexisting, knownEnv: 0, flaky: 0 }]]);

  test('a budget filled by history does not jump past the unselected cursor file', () => {
    const c = costs({ 'a.test.ts': 600, 'b.test.ts': 600, 'c.test.ts': 600 });
    const pick = pickWithHistory(FILES, 0, c, 700, history('c.test.ts', 4, 1));
    expect(pick.files).toEqual(['c.test.ts']);
    expect(pick.historyFiles.map((entry) => entry.file)).toEqual(['c.test.ts']);
    // `a` is the cursor slice the budget could not take — `next` stays on it, it is not skipped.
    expect(pick.next).toBe(0);
    expect(FILES[pick.next] === 'a.test.ts' && !pick.files.includes('a.test.ts')).toBe(true);
    // The next pick, once the history no longer hogs the budget, takes exactly that file.
    const next = pickWithHistory(FILES, pick.next, c, 700, new Map());
    expect(next.files).toEqual(['a.test.ts']);
  });

  test('the cursor advances past every cursor file the budget did select', () => {
    const c = costs({ 'a.test.ts': 600, 'b.test.ts': 600, 'c.test.ts': 100 });
    const pick = pickWithHistory(FILES, 0, c, 700, history('c.test.ts', 4, 1));
    expect(pick.files).toEqual(['c.test.ts', 'a.test.ts']);
    expect(pick.estimatedSecs).toBe(700);
    // `a` was selected, so `next` is the file after it — `b`, not further.
    expect(pick.next).toBe(1);
    expect(FILES[pick.next]).toBe('b.test.ts');
  });
});

describe('test-diet prescription recipe carries gate history', () => {
  test('history repeat offenders get a prescription even when the daily verdict is keep', () => {
    const file = REPEAT_OFFENDER;
    expect(recipeFor({ file, verdict: 'keep', history: { preexisting: 2, knownEnv: 0 } }).type).toBe('T6');
    expect(recipeFor({ file, verdict: 'keep', history: { preexisting: 1, knownEnv: 2 } }).type).toBe('T5');
    // Boundary ①: a flaky-only repeat offender is the same «history» the pick weighs, so keep still means T6.
    expect(recipeFor({ file, verdict: 'keep', history: { preexisting: 0, knownEnv: 0, flaky: 2 } }).type).toBe('T6');
    expect(recipeFor({ file, verdict: 'keep' }).type).toBe('TA');
  });

  test('the history counts land in the prescription basis', () => {
    const recipe = recipeFor({ file: REPEAT_OFFENDER, verdict: 'keep', history: { preexisting: 2, knownEnv: 3 } });
    expect(recipe.basis).toContain('gate history preexisting 2 · knownEnv 3');
    expect(recipeFor({ file: REPEAT_OFFENDER, verdict: 'keep', history: { preexisting: 0, knownEnv: 0, flaky: 2 } }).basis)
      .toContain('flaky 2');
  });
});

describe('test-diet record consumes the pick slice it was handed', () => {
  test('a history winner cannot occupy both consecutive slices while the cursor remains parked', () => {
    const stateDir = seedGateHistory('0.2.34', { preexisting: [REPEAT_OFFENDER, PLAIN_KEEP].map((file) => `${file} > repeat`) });
    const first = runStep('pick', stateDir, { budgetSecs: 0.000001 });
    expect(first.json.files).toHaveLength(1);
    const weighted = (first.json.historyFiles as Array<{ file: string }>).map((entry) => entry.file);
    expect(weighted).toEqual(expect.arrayContaining([REPEAT_OFFENDER, PLAIN_KEEP]));
    const cursorFile = repoTestFiles()[Number(first.json.start)]!;
    expect(weighted).not.toContain(cursorFile);

    const firstRecord = runStep('record', stateDir, {}, { pick: first.json, measure: measureFor(first.json.files as string[]) });
    expect(firstRecord.code).toBe(0);
    // Keep graph-runs intact: the same gate-history weight must remain available to the next pick.
    const second = runStep('pick', stateDir, { budgetSecs: 0.000001 });
    expect(second.json.files).toContain(cursorFile);
    const secondRecord = runStep('record', stateDir, {}, { pick: second.json, measure: measureFor(second.json.files as string[]) });
    expect(secondRecord.code).toBe(0);
  }, 120000);

  test('history-weighted picks record exact selected files and their non-contiguous index range', () => {
    const files = repoTestFiles();
    const costs = new Map(files.map((file) => [file, 10]));
    costs.set(files[0]!, 600);
    costs.set(files[1]!, 600);
    costs.set(files[2]!, 100);
    const historyFile = files[2]!;
    const weights = new Map([[historyFile, { file: historyFile, weight: 4, preexisting: 1, knownEnv: 0, flaky: 0 }]]);
    const picked = pickWithHistory(files, 0, costs, 700, weights);
    expect(picked.files).toEqual([files[2], files[0]]);
    expect(picked.selectedIndices).toEqual([2, 0]);
    expect(picked.rangeLabel).toBe('#2,#0');

    const stateDir = mkdtempSync(join(tmpdir(), 'test-diet-range-'));
    const recordPick = { ...picked, total: files.length, budgetSecs: 700, sweep: true, totalCostSecs: 700, slicesNeeded: 5, sweepElapsed: 0 };
    const rec = runStep('record', stateDir, {}, { pick: recordPick, measure: measureFor(picked.files) });
    expect(rec.code).toBe(0);
    const line = ledgerLines(stateDir).at(-1)!;
    expect(line.range).toBe(picked.rangeLabel);
    expect(line.selectedFiles).toEqual(picked.files);
    expect(line.selectedIndices).toEqual(picked.selectedIndices);
    expect((line.results as Array<{ file: string }>).map((result) => result.file)).toEqual(picked.files);
    expect(line.sweepVisited).toBe(1);
  }, 120000);

  test('the real pick output drives record: history survives a ledger change and the skipped cursor file stays reachable', () => {
    const stateDir = seedGateHistory('0.2.34');
    // A 9-second budget: the repeat offender (9s) fills it and the first cursor file is skipped by the budget.
    const pick = runStep('pick', stateDir, { budgetSecs: 9 });
    expect({ code: pick.code, err: pick.err }).toEqual({ code: 0, err: '' });
    expect(pick.json.files).toEqual([REPEAT_OFFENDER]);
    const files = repoTestFiles();
    const skipped = files[Number(pick.json.start)]!;
    // The skipped cursor file is not selected, and the cursor stays on it instead of jumping past.
    const pickedFiles = pick.json.files as string[];
    expect({ skipped, picked: pickedFiles.includes(skipped), next: pick.json.next })
      .toEqual({ skipped, picked: false, next: pick.json.start });
    // The gate ledger changes between pick and record — record must keep the pick's own snapshot.
    rmSync(join(stateDir, 'graph-runs'), { recursive: true, force: true });
    const measure = measureFor([REPEAT_OFFENDER, PLAIN_KEEP]);
    const rec = runStep('record', stateDir, {}, { pick: pick.json, measure });
    expect({ code: rec.code, err: rec.err }).toEqual({ code: 0, err: '' });
    // History repeat offender → T6; the plain keep with no proposal/failure/history → TA, not skipped.
    expect(rec.json.recipes).toEqual({ T6: 1, TA: 1 });
    expect(rec.json.history).toEqual({ preexisting: 1, knownEnv: 0, total: 1, files: [REPEAT_OFFENDER],
      deltaPreexisting: 1, deltaKnownEnv: 0 });
    const line = ledgerLines(stateDir).at(-1)!;
    // The totals AND their delta live on the same ledger line (boundary ③), not only in the step's stdout.
    expect(line.gateHistory).toEqual({ preexisting: 1, knownEnv: 0, total: 1, deltaPreexisting: 1, deltaKnownEnv: 0 });
    // Both verdicts get their one prescription card draft — the TA keep is not dropped.
    expect(cards(stateDir)).toContain(`test-diet:${REPEAT_OFFENDER}:gate-history:T6`);
    expect(cards(stateDir)).toContain(`test-diet:${PLAIN_KEEP}:verdict:TA`);
    expect(existsSync(join(ROOT, REPEAT_OFFENDER))).toBe(true);
    // The next pick starts where the cursor stayed: the file the budget skipped is selected then.
    const next = runStep('pick', stateDir, { start: Number(pick.json.next), budgetSecs: 9 });
    expect({ code: next.code, first: (next.json.files as string[] | undefined)?.[0] })
      .toEqual({ code: 0, first: skipped });
  }, 120000);

  test('a later pick without history records a negative preexisting delta against the previous line', () => {
    const stateDir = seedGateHistory('0.2.34');
    const first = runStep('pick', stateDir, { budgetSecs: 9 });
    expect(runStep('record', stateDir, {}, { pick: first.json, measure: measureFor([REPEAT_OFFENDER]) }).code).toBe(0);
    // The gate ledger shrinks between slices — the next pick carries no history files.
    rmSync(join(stateDir, 'graph-runs'), { recursive: true, force: true });
    const second = runStep('pick', stateDir, { start: 0, budgetSecs: 9 });
    const rec = runStep('record', stateDir, {}, { pick: second.json, measure: measureFor(second.json.files as string[]) });
    expect(rec.code).toBe(0);
    expect(rec.json.history)
      .toEqual({ preexisting: 0, knownEnv: 0, total: 0, files: [], deltaPreexisting: -1, deltaKnownEnv: 0 });
    // A zero line still carries gateHistory, so «판마다 이월» is readable row by row.
    expect(ledgerLines(stateDir).at(-1)!.gateHistory)
      .toEqual({ preexisting: 0, knownEnv: 0, total: 0, deltaPreexisting: -1, deltaKnownEnv: 0 });
  }, 120000);

  test('a flaky-only repeat offender still yields the isolation prescription and a zero-total ledger line', () => {
    const stateDir = seedGateHistory('0.2.34', { preexisting: [], loadFlaky: [`${REPEAT_OFFENDER} > keeps the gate honest`] });
    const pick = runStep('pick', stateDir, { budgetSecs: 9 });
    expect(pick.json.files).toEqual([REPEAT_OFFENDER]);
    const rec = runStep('record', stateDir, {}, { pick: pick.json, measure: measureFor([REPEAT_OFFENDER]) });
    expect({ code: rec.code, err: rec.err }).toEqual({ code: 0, err: '' });
    // Picked on flaky weight and prescribed as interference isolation — pick and prescription agree.
    expect(rec.json.recipes).toEqual({ T6: 1 });
    expect(rec.json.history).toEqual({ preexisting: 0, knownEnv: 0, total: 0, files: [REPEAT_OFFENDER],
      deltaPreexisting: 0, deltaKnownEnv: 0 });
    expect(ledgerLines(stateDir).at(-1)!.gateHistory)
      .toEqual({ preexisting: 0, knownEnv: 0, total: 0, deltaPreexisting: 0, deltaKnownEnv: 0 });
    expect(cards(stateDir)).toContain(`test-diet:${REPEAT_OFFENDER}:gate-history:T6`);
  }, 120000);
});
