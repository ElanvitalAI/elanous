import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observedArrayCount, runSubagentToolsDevice } from './subagent-tools-device.js';

const REPO_CLI = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

test('dispatch observation counts truncated arrays and rejects malformed summaries', () => {
  expect(observedArrayCount([...Array.from({ length: 200 }, (_, index) => `tool-${index}`), { _more: 3 }])).toBe(203);
  expect(observedArrayCount(['Read', { _more: 0 }])).toBe(-1);
  expect(observedArrayCount(['Read', { _more: -1 }])).toBe(-1);
  expect(observedArrayCount(['Read', { _more: 1.5 }])).toBe(-1);
  expect(observedArrayCount(['Read', { _more: Number.MAX_SAFE_INTEGER }])).toBe(-1);
  expect(observedArrayCount(['Read', { _more: 9_007_199_254_740_992 }])).toBe(-1);
  expect(observedArrayCount(['Read', {}])).toBe(-1);
  expect(observedArrayCount(['Read', { _more: 1 }, { _more: 1 }])).toBe(-1);
  expect(observedArrayCount(['Read', { _more: 1 }, 'Bash'])).toBe(-1);
  expect(observedArrayCount(['Read', { _more: 1, extra: true }])).toBe(-1);
});

describe('N03 subagent-tools 장치 (이 트리 classic TUI · fake LLM)', () => {
  test('mismatch: 모르는 이름뿐인 allow 는 무시되고 자식이 도구를 물려받는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-subtools-'));
    try {
      const r = await runSubagentToolsDevice({ scenario: 'mismatch', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({ filterObserved: true, allowIgnored: true, unknownLogged: true, nothingRemoved: true, childGotAllTools: true, noRefusal: true, exitedClean: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);

  test('zero-refused: 필터가 0개를 만들면 발사 거부 1 · dispatch 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-subtools-zero-'));
    try {
      const r = await runSubagentToolsDevice({ scenario: 'zero-refused', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({ filterLeftZero: true, refusedOnce: true, noDispatch: true, exitedClean: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150_000);
});

