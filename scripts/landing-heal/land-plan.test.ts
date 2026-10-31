import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dirs: string[] = [];
setDefaultTimeout(120_000);
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const script = join(import.meta.dir, 'land-plan.ts');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const head = (seed: string) => createHash('sha256').update(seed).digest('hex').slice(0, 40);

function fixture(): { input: string; commandLog: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'land-plan-'));
  dirs.push(dir);
  const input = join(dir, 'land-queue.json');
  const commandLog = join(dir, 'external-command.log');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const command of ['git', 'gh', 'gate', 'merge']) {
    const path = join(bin, command);
    writeFileSync(path, '#!/bin/sh\nprintf "%s\\n" "$0" >> "$ELANOUS_LAND_PLAN_COMMAND_LOG"\n');
    chmodSync(path, 0o755);
  }
  writeFileSync(input, JSON.stringify({
    pending: [
      { number: 101, head: head('101'), files: ['src/first.ts'] },
      { number: 202, head: head('202'), files: ['src/second.ts'] },
      { number: 303, head: head('303'), files: ['src/first.ts'] },
      { number: 404, head: head('404'), filesUnmeasured: true },
    ],
    verdicts: [{ number: 99, verdict: 'pass' }],
    deferred: [{ number: 98, head: head('98'), reason: 'previous', at: '2026-10-31T00:00:00.000Z' }],
  }, null, 2));
  return { input, commandLog, bin };
}

function run(input: string, commandLog: string, bin?: string) {
  return spawnSync(process.execPath, [script, '--input', input], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ELANOUS_LAND_PLAN_COMMAND_LOG: commandLog, ...(bin ? { PATH: `${bin}:${process.env.PATH}` } : {}) },
  });
}

test('LAND-RECIPE-GRAPH plans pending ledger rows deterministically without changing input or running landing commands', () => {
  const { input, commandLog, bin } = fixture();
  const before = readFileSync(input, 'utf8');
  const first = run(input, commandLog, bin);
  const second = run(input, commandLog, bin);

  expect(first.status).toBe(0);
  expect(second.status).toBe(0);
  expect(first.stderr).toBe('');
  expect(first.stdout).toBe(second.stdout);
  expect(JSON.parse(first.stdout)).toEqual({
    batch: [
      { number: 101, head: head('101'), files: ['src/first.ts'] },
      { number: 202, head: head('202'), files: ['src/second.ts'] },
    ],
    deferred: [
      { number: 303, reason: 'overlap', with: [101] },
      { number: 404, reason: 'files-unknown' },
    ],
  });
  expect(sha(readFileSync(input, 'utf8'))).toBe(sha(before));
  expect(() => readFileSync(commandLog, 'utf8')).toThrow();
});

test('LAND-RECIPE-GRAPH requires an absolute input path', () => {
  const result = spawnSync(process.execPath, [script, '--input', 'land-queue.json'], { encoding: 'utf8', timeout: 120_000 });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('--input requires an absolute path');
});

test('LAND-RECIPE-GRAPH applies the established eight-item maximum batch through the CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'land-plan-max-batch-'));
  dirs.push(dir);
  const input = join(dir, 'land-queue.json');
  writeFileSync(input, JSON.stringify({
    pending: Array.from({ length: 9 }, (_, index) => ({ number: index + 1, head: head(String(index + 1)), files: [`src/${index + 1}.ts`] })),
    verdicts: [],
  }));

  const result = run(input, join(dir, 'external-command.log'));

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).batch.map((item: { number: number }) => item.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(JSON.parse(result.stdout).deferred).toEqual([]);
});
