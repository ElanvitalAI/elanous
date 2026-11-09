import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideTrainVerdict, type TrainVerdictInput } from './train-verdict.js';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const changedPathEvidence = (paths: string[]) => {
  const diffOutput = paths.join('\0') + (paths.length ? '\0' : '');
  return { source: 'git-diff' as const, complete: true, base, head, paths, diffOutput, artifactSha256: sha256(diffOutput) };
};
const timeoutEvidence = (failures: Array<{ id: string; file: string }>) => {
  const artifactJson = JSON.stringify({ schema: 'train-timeout-attribution/v1', base, head, failures });
  return { source: 'gate-artifact' as const, artifactSha256: sha256(artifactJson), artifactJson, complete: true, base, head, failures };
};
const remeasureEvidence = (fields: { host?: string; primaryHost?: string; exit: number; failures: Array<{ id: string; file: string }> }) => {
  const artifactJson = JSON.stringify({ schema: 'train-timeout-attribution/v1', base, head, failures: fields.failures });
  return { complete: true, host: fields.host ?? 'aws2', primaryHost: fields.primaryHost ?? 'minim5', base, head,
    exit: fields.exit, failuresComplete: true, artifactSha256: sha256(artifactJson), artifactJson, failures: fields.failures };
};
const clean = (overrides: Partial<TrainVerdictInput> = {}): TrainVerdictInput => ({
  base, head, changedPaths: changedPathEvidence(['src/changed.ts']),
  batch: { base, head, complete: true, exit: 0, introduced: 0, unknown: 0, preconditionUnmet: 0, unrunImporters: 0,
    typecheck: 'pass', alwaysRatchets: 'pass', preexisting: 0, timeouts: 0, timeoutEvidence: timeoutEvidence([]) },
  ...overrides,
});

test('TRAIN-VERDICT · #35709 false rejection: exact baseline-only failures do not become introduced regressions', () => {
  const input = clean({ batch: { ...clean().batch, exit: 1, preexisting: 2,
    preexistingEvidence: { complete: true, base, head, sha: head, ids: ['legacy-a', 'legacy-b'] },
    preexistingBuildEvidence: { base, head, sha: head, valid: true } } });
  expect(decideTrainVerdict(input)).toMatchObject({ verdict: 'pass' });
});

test('TRAIN-VERDICT · #35252 false rejection: primary timeout passing on a different host is not a regression', () => {
  const input = clean({ batch: { ...clean().batch, exit: 1, timeouts: 1,
    timeoutEvidence: timeoutEvidence([{ id: 'test/legacy.test.ts#slow', file: 'test/legacy.test.ts' }]) },
    remeasure: remeasureEvidence({ exit: 0, failures: [] }) });
  expect(decideTrainVerdict(input)).toMatchObject({ verdict: 'pass' });
});

test('a different-host timeout failure passes only when fully attributed and disjoint from batch changes', () => {
  const input = clean({ batch: { ...clean().batch, exit: 1, timeouts: 1,
    timeoutEvidence: timeoutEvidence([{ id: 'test/old.test.ts#slow', file: 'test/old.test.ts' }]) },
    remeasure: remeasureEvidence({ exit: 1, failures: [{ id: 'test/old.test.ts#slow', file: 'test/old.test.ts' }] }) });
  expect(decideTrainVerdict(input)).toMatchObject({ verdict: 'pass' });
});

test('a different-host failure intersecting a changed path is rejected for member re-evaluation', () => {
  const input = clean({ changedPaths: changedPathEvidence(['src/changed.test.ts']),
    batch: { ...clean().batch, exit: 1, timeouts: 1,
      timeoutEvidence: timeoutEvidence([{ id: 'src/changed.test.ts#slow', file: 'src/changed.test.ts' }]) },
    remeasure: remeasureEvidence({ exit: 1, failures: [{ id: 'src/changed.test.ts#slow', file: 'src/changed.test.ts' }] }) });
  expect(decideTrainVerdict(input)).toMatchObject({ verdict: 'fail', reason: expect.stringContaining('intersects changed path') });
});

test.each([
  ['introduced', { introduced: 1 }], ['unknown', { unknown: 1 }],
])('introduced/unknown failure (%s) remains a hard rejection', (_label, counts) => {
  expect(decideTrainVerdict(clean({ batch: { ...clean().batch, ...counts } }))).toMatchObject({ verdict: 'fail' });
});

test('unmeasured timeout, same-host retry, and mandatory gate failures fail closed', () => {
  const timedOut = clean({ batch: { ...clean().batch, exit: 1, timeouts: 1,
    timeoutEvidence: timeoutEvidence([{ id: 'test/slow.test.ts#x', file: 'test/slow.test.ts' }]) } });
  expect(decideTrainVerdict(timedOut).verdict).toBe('fail');
  expect(decideTrainVerdict({ ...timedOut, remeasure: remeasureEvidence({ host: 'minim5', primaryHost: 'minim5', exit: 0, failures: [] }) }).verdict).toBe('fail');
  expect(decideTrainVerdict(clean({ batch: { ...clean().batch, typecheck: 'fail' } })).verdict).toBe('fail');
  expect(decideTrainVerdict(clean({ batch: { ...clean().batch, alwaysRatchets: 'fail' } })).verdict).toBe('fail');
});

test('JSON CLI emits the pure decision and uses exit 2 for missing input', () => {
  const root = mkdtempSync(join(tmpdir(), 'train-verdict-cli-'));
  try {
    const file = join(root, 'evidence.json');
    writeFileSync(file, JSON.stringify(clean()));
    const pass = spawnSync('bun', [join(import.meta.dir, 'train-verdict.ts'), file], { encoding: 'utf8' });
    expect(pass.status).toBe(0);
    expect(JSON.parse(pass.stdout)).toMatchObject({ verdict: 'pass' });
    const missing = spawnSync('bun', [join(import.meta.dir, 'train-verdict.ts')], { encoding: 'utf8' });
    expect(missing.status).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({ verdict: 'fail' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('evidence revisions, changed-path provenance, preexisting IDs, host identity, and timeout mapping cannot be substituted', () => {
  const validExisting = clean({ batch: { ...clean().batch, exit: 1, preexisting: 1,
    preexistingEvidence: { complete: true, base, head, sha: head, ids: ['known-failure'] },
    preexistingBuildEvidence: { base, head, sha: head, valid: true } } });
  expect(decideTrainVerdict(validExisting).verdict).toBe('pass');
  expect(decideTrainVerdict({ ...validExisting, batch: { ...validExisting.batch, head: base } }).verdict).toBe('fail');
  expect(decideTrainVerdict({ ...validExisting, changedPaths: { ...validExisting.changedPaths, head: base } }).verdict).toBe('fail');
  expect(decideTrainVerdict({ ...validExisting, batch: { ...validExisting.batch, preexistingEvidence: undefined } }).verdict).toBe('fail');
  expect(decideTrainVerdict({ ...validExisting, batch: { ...validExisting.batch, preexistingBuildEvidence: undefined } }).verdict).toBe('fail');
  expect(decideTrainVerdict({ ...validExisting, changedPaths: { ...changedPathEvidence(['../src/changed.ts']) } }).verdict).toBe('fail');
  const timeout = clean({ batch: { ...clean().batch, exit: 1, timeouts: 1,
    timeoutEvidence: timeoutEvidence([{ id: 'test/old.test.ts#slow', file: 'test/old.test.ts' }]) },
    remeasure: remeasureEvidence({ exit: 1, failures: [{ id: 'test/old.test.ts#slow', file: 'test/old.test.ts' }] }) });
  expect(decideTrainVerdict({ ...timeout, remeasure: remeasureEvidence({ primaryHost: 'bad_alias', exit: 1, failures: [] }) }).verdict).toBe('fail');
  expect(decideTrainVerdict({ ...timeout, remeasure: remeasureEvidence({ host: 'AWS2', exit: 1, failures: [] }) }).verdict).toBe('fail');
  expect(decideTrainVerdict({ ...timeout, remeasure: { ...timeout.remeasure!, failures: [{ id: 'test/old.test.ts#slow', file: 'src/changed.ts' }] } }).verdict).toBe('fail');
  expect(decideTrainVerdict({ ...timeout, batch: { ...timeout.batch,
    timeoutEvidence: { ...timeout.batch.timeoutEvidence, artifactJson: timeout.batch.timeoutEvidence.artifactJson.replace('test/old.test.ts', 'src/changed.ts') } } }).verdict).toBe('fail');
  expect(decideTrainVerdict({ ...timeout, changedPaths: { ...timeout.changedPaths, paths: ['src/unlisted.ts'] } }).verdict).toBe('fail');
  const twoInOneFile = clean({ batch: { ...clean().batch, exit: 1, timeouts: 2,
    timeoutEvidence: timeoutEvidence([{ id: 'test/old.test.ts#slow-a', file: 'test/old.test.ts' }, { id: 'test/old.test.ts#slow-b', file: 'test/old.test.ts' }]) },
    remeasure: remeasureEvidence({ exit: 1, failures: [{ id: 'test/old.test.ts#slow-a', file: 'test/old.test.ts' }, { id: 'test/old.test.ts#slow-b', file: 'test/old.test.ts' }] }) });
  expect(decideTrainVerdict(twoInOneFile).verdict).toBe('pass');
});
