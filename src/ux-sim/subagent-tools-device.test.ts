import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubagentToolsDevice } from './subagent-tools-device.js';

const REPO_CLI = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

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

