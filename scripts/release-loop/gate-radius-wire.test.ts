import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOptions, runGateNode, writeGateVerdictRecord } from './gate-runtime.js';

test('cut radius remains opt-in and malformed prior identity requests a full fallback', () => {
  const args = ['--commit', 'a'.repeat(40), '--version', '0.3.12', '--baseline-version', '0.3.11'];
  expect(parseOptions(args, {})).toMatchObject({ commit: 'a'.repeat(40) });
  expect(parseOptions(args, {})).not.toHaveProperty('radiusWinnowOptIn');
  expect(parseOptions(args, { ELANOUS_GATE_RADIUS_WINNOW: '1',
    ELANOUS_GATE_RADIUS_PRIOR_RUN_ID: 'prior-run' })).toMatchObject({
      radiusWinnowOptIn: true, radiusWinnowPriorRunId: 'prior-run',
    });
  expect(parseOptions(args, { ELANOUS_GATE_RADIUS_WINNOW: '1',
    ELANOUS_GATE_RADIUS_PRIOR_RUN_ID: '../unsafe' })).toMatchObject({ radiusWinnowOptIn: true });
  expect(parseOptions(args, { ELANOUS_GATE_RADIUS_WINNOW: '1',
    ELANOUS_GATE_RADIUS_PRIOR_RUN_ID: '../unsafe' })).not.toHaveProperty('radiusWinnowPriorRunId');
});

test('gate CLI passes the opt-in prior run to the judge and keeps its default off', async () => {
  const args = ['--commit', 'a'.repeat(40), '--version', '0.3.12', '--baseline-version', '0.3.11', '--json'];
  const received: Array<{ enabled: boolean; priorRunId?: string }> = [];
  const judge: Parameters<typeof runGateNode>[3] = async (opts) => {
    received.push({ enabled: opts.radiusWinnowOptIn === true, priorRunId: opts.radiusWinnowPriorRunId });
    return { outcome: 'ok', commit: opts.commit, introduced: [], preexisting: 0, fixed: 0,
      knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 0 };
  };
  expect(await runGateNode(args, {}, undefined, judge)).toBe(0);
  expect(await runGateNode(args, { ELANOUS_GATE_RADIUS_WINNOW: '1',
    ELANOUS_GATE_RADIUS_PRIOR_RUN_ID: 'prior-run' }, undefined, judge)).toBe(0);
  expect(received).toEqual([{ enabled: false, priorRunId: undefined },
    { enabled: true, priorRunId: 'prior-run' }]);
});

test('a complete radius verdict atomically replaces the prior full verdict; incomplete attempts preserve it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'winnow-verdict-'));
  const path = join(dir, 'gate-verdict.json');
  const priorCut = 'a'.repeat(40), newCut = 'b'.repeat(40);
  try {
    writeGateVerdictRecord(path, { runId: 'prior-run', commit: priorCut, outcome: 'ok',
      baselineReceipt: { schema: 2, valid: true, commit: priorCut } });
    const radius = { schema: 'gate-radius-judged-run-v1', runId: 'new-run', cutSha: newCut,
      imageDigest: `sha256:${'d'.repeat(64)}`, lockfileHash: 'e'.repeat(64),
      expectedFiles: ['src/a.test.ts', 'src/b.test.ts'],
      files: [{ file: 'src/a.test.ts', outcome: 'pass', key: '1'.repeat(64), recordSha256: '2'.repeat(64),
        sourceRunId: 'new-run', sourceCutSha: newCut },
      { file: 'src/b.test.ts', outcome: 'pass', key: '3'.repeat(64), recordSha256: '4'.repeat(64),
        sourceRunId: 'prior-run', sourceCutSha: priorCut }] };
    writeGateVerdictRecord(path, { runId: 'new-run', commit: newCut, outcome: 'ok', radiusJudgedRun: radius });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ runId: 'new-run', commit: newCut });
    writeGateVerdictRecord(path, { runId: 'bad-run', commit: 'c'.repeat(40), outcome: 'ok',
      radiusJudgedRun: { ...radius, runId: 'bad-run', cutSha: 'c'.repeat(40),
        files: [{ ...radius.files[0], recordSha256: undefined }, radius.files[1]] } });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ runId: 'new-run', commit: newCut });
    writeGateVerdictRecord(path, { runId: 'bad-run', commit: 'c'.repeat(40), outcome: 'ok',
      radiusJudgedRun: { ...radius, runId: 'bad-run', cutSha: 'c'.repeat(40),
        files: [{ ...radius.files[0], sourceRunId: 'bad-run', sourceCutSha: 'c'.repeat(40) },
          { file: 'src/b.test.ts', outcome: 'fail' }] } });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ runId: 'new-run', commit: newCut });
    writeGateVerdictRecord(path, { runId: 'incomplete-run', commit: 'c'.repeat(40), outcome: 'error' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ runId: 'new-run', commit: newCut });
    expect(readFileSync(join(dir, 'gate-verdict-attempts.jsonl'), 'utf8').trim().split('\n')).toHaveLength(5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a valid baseline receipt cannot override a contradictory radius inventory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'winnow-verdict-contradiction-'));
  const path = join(dir, 'gate-verdict.json');
  const priorCut = 'a'.repeat(40), newCut = 'b'.repeat(40);
  try {
    writeGateVerdictRecord(path, { runId: 'prior-run', commit: priorCut, outcome: 'ok',
      baselineReceipt: { schema: 2, valid: true, commit: priorCut } });
    const previous = readFileSync(path, 'utf8');
    const radius = { schema: 'gate-radius-judged-run-v1', runId: 'new-run', cutSha: newCut,
      imageDigest: `sha256:${'d'.repeat(64)}`, lockfileHash: 'e'.repeat(64),
      expectedFiles: ['src/a.test.ts'],
      files: [{ file: 'src/a.test.ts', outcome: 'pass', key: '1'.repeat(64), recordSha256: '2'.repeat(64),
        sourceRunId: 'new-run', sourceCutSha: newCut }] };
    for (const inventory of [
      { ...radius, files: [{ file: 'src/a.test.ts', outcome: 'fail' }] },
      { ...radius, runId: 'wrong-run' },
      { ...radius, cutSha: priorCut },
    ]) {
      writeGateVerdictRecord(path, { runId: 'new-run', commit: newCut, outcome: 'ok',
        baselineReceipt: { schema: 2, valid: true, commit: newCut }, radiusJudgedRun: inventory });
      expect(readFileSync(path, 'utf8')).toBe(previous);
    }
    expect(readFileSync(join(dir, 'gate-verdict-attempts.jsonl'), 'utf8').trim().split('\n')).toHaveLength(4);
    writeGateVerdictRecord(path, { runId: 'new-run', commit: newCut, outcome: 'ok',
      baselineReceipt: { schema: 2, valid: true, commit: newCut }, radiusJudgedRun: radius });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ runId: 'new-run', commit: newCut });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
