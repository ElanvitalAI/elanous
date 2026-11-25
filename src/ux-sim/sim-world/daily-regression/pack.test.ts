// DAILY-REGRESSION pack gate: every scenario green on this tree, the runner's verdict/receipt/exit contract, and the
// real CLI door (`--test sim run --pack daily-regression`). Expectations are literals.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simCli } from '../../in-process-cli.js';
import { formatSimRegressionLine, runSimRegressionPack, type SimRegressionReceipt } from './pack.js';
import { dailyRegressionPending, dailyRegressionScenarios } from './scenarios.js';

const roots: string[] = [];
const root = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir; };
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

test('pack lists DR01–DR08, DR11, DR12, DR14, DR15, DR16, DR17 and DR18 as scenarios and DR01b/DR09/DR10 as pending (skip with reason)', () => {
  expect(dailyRegressionScenarios.map((row) => row.id)).toEqual(['DR01', 'DR02', 'DR03', 'DR04', 'DR05', 'DR06', 'DR07', 'DR08', 'DR11', 'DR12', 'DR14', 'DR15', 'DR16', 'DR17', 'DR18']);
  expect(dailyRegressionPending.map((row) => row.id)).toEqual(['DR01b', 'DR09', 'DR10']);
});

for (const scenario of dailyRegressionScenarios) {
  test(`${scenario.id} PASS · ${scenario.title}`, async () => {
    const receipt = await runSimRegressionPack({ pack: 'daily-regression', stateRoot: root(`dr-${scenario.id}-`), only: scenario.id, runId: 'r1' });
    const row = receipt.rows[0]!;
    if (row.verdict !== 'PASS') console.error(`${scenario.id} detail:\n${row.detail}`);
    expect([row.id, row.verdict]).toEqual([scenario.id, 'PASS']);
  }, 240_000);
}

test('runner: a failing scenario → FAIL line with its first diff line, ok=false, receipt on disk, kept universe', async () => {
  const state = root('dr-runner-');
  const lines: string[] = [];
  const receipt = await runSimRegressionPack({ pack: 'daily-regression', stateRoot: state, runId: 'r2', onRow: (row) => lines.push(formatSimRegressionLine({ ...row, durationMs: 1234 })),
    scenarios: [
      { id: 'X1', title: 'green one', prs: [1], run: async (ctx) => { ctx.note('seen', { a: 1 }); return { ok: true }; } },
      { id: 'X2', title: 'red one', prs: [2], run: async () => ({ ok: false, diff: 'answer on screen: expected true · observed false\nsecond' }) },
      { id: 'X3', title: 'throws', prs: [3], run: async () => { throw new Error('boom'); } },
    ] });
  expect(lines).toEqual([
    'PASS X1       1.2s  green one',
    'FAIL X2       1.2s  red one — answer on screen: expected true · observed false',
    'FAIL X3       1.2s  throws — threw: boom',
  ]);
  expect([receipt.ok, receipt.counts]).toEqual([false, { pass: 1, fail: 2, skip: 0 }]);
  expect(receipt.receiptPath).toBe(join(state, 'sim-regression', 'r2', 'receipt.json'));
  const onDisk = JSON.parse(readFileSync(receipt.receiptPath, 'utf8')) as SimRegressionReceipt;
  expect([onDisk.schema, onDisk.rows.map((row) => row.verdict), onDisk.rows[0]!.notes]).toEqual(['sim-regression.receipt/1', ['PASS', 'FAIL', 'FAIL'], [{ kind: 'seen', data: { a: 1 } }]]);
  expect(existsSync(join(state, 'sim-regression', 'r2', 'universe', 'X1'))).toBe(false);
  expect(existsSync(join(state, 'sim-regression', 'r2', 'universe', 'X2'))).toBe(true);
});

test('runner: pending rows print SKIP with the reason and do not fail the run', async () => {
  const receipt = await runSimRegressionPack({ pack: 'daily-regression', stateRoot: root('dr-skip-'), only: 'DR09', runId: 'r3' });
  expect([receipt.ok, receipt.counts, formatSimRegressionLine(receipt.rows[0]!)]).toEqual([true, { pass: 0, fail: 0, skip: 1 },
    'SKIP DR09     0.0s  baton auto on restart: TC first, never both down, 3 mails during the gap not lost — #39942 not merged']);
});

test('CLI door: unknown pack and pack+file are refused (exit 2); a pending-only run exits 0 with the receipt line', async () => {
  const state = root('dr-cli-');
  const cli = (...args: string[]) => simCli(['sim', 'run', ...args], { mode: 'spawn', stateRoot: state, allowPaths: [['sim', 'run']], timeoutMs: 60_000 });
  const unknown = await cli('--pack', 'nope');
  expect([unknown.exitCode, unknown.stderr.trim().split('\n').at(-1)]).toEqual([2, 'sim run: unknown pack nope (known: daily-regression)']);
  const both = await cli('x.yaml', '--pack', 'daily-regression');
  expect([both.exitCode, both.stderr.trim().split('\n').at(-1)]).toEqual([2, 'sim run: --pack takes no scenario file']);
  const skip = await cli('--pack', 'daily-regression', '--only', 'DR10');
  expect(skip.exitCode).toBe(0);
  const out = skip.stdout.trim().split('\n').filter((line) => /^(SKIP|OK|FAIL) /u.test(line));
  expect(out[0]).toStartWith('SKIP DR10 ');
  expect(out[1]).toMatch(/^OK daily-regression · pass 0 · fail 0 · skip 1 · receipt \/.+\/sim-regression\/[^/]+\/receipt\.json$/u);
}, 90_000);
