// LAND-GLOBAL-CHECKS — 착지 게이트가 «실제 저장소의» release/next.md 를 발행 notes-check 와 같은 check() 로 판정하는 것을 증명한다.
//
// 0.2.24 의 어긋남: next.md 의 «신설:» 한국어 줄이 발행 notes-check(B11) 에서는 ✗ 났는데 착지에서는 통과했다.
// 이 시험은 임시 git 무대의 실제 release/next.md 파일로 (a) 위반 줄이 착지를 막는 것 · (b) 정상 노트는 통과하는 것을 직접 증명한다.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { runLandGlobalChecksGate } from '../../scripts/land-global-checks.js';

/** mkdtempSync 임시 git 무대 — release/next.md 를 체크인한다. */
function stage(nextMd: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'land-global-checks-'));
  mkdirSync(join(cwd, 'release'));
  writeFileSync(join(cwd, 'release', 'next.md'), nextMd);
  const git = (...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '-q');
  git('add', 'release/next.md');
  git('-c', 'user.name=land-global-checks-test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'test stage');
  return cwd;
}

const okTests = () => ({ status: 0, output: '' });

describe('runLandGlobalChecksGate — 실제 release/next.md 판정', () => {
  test('«신설:» 한국어 줄이 실제 next.md 에 있으면 착지를 막는다(0.2.24 어긋남 재현 방지)', () => {
    const errors: string[] = [];
    const cwd = stage('# Next\n\n## Fix\n\n- fix — 신설: 한국어가 발행 노트에 섞였다.\n');
    const ok = runLandGlobalChecksGate({
      changedFiles: ['release/next.md'], cwd,
      log: () => {}, error: (message) => errors.push(message), runTests: okTests,
    });
    expect(ok).toBe(false);
    expect(errors.some((message) => message.includes('B11') && message.includes('release/next.md'))).toBe(true);
  });

  test('정상(신설 없는) next.md 는 통과한다', () => {
    const logs: string[] = [];
    const cwd = stage('# Next\n\n## Fix\n\n- fix — Adds a landing gate for release notes.\n');
    const ok = runLandGlobalChecksGate({
      changedFiles: ['release/next.md'], cwd,
      log: (message) => logs.push(message), error: () => {}, runTests: okTests,
    });
    expect(ok).toBe(true);
    expect(logs.some((message) => message.includes('release/next.md 발행 노트 검사(check-node) PASS'))).toBe(true);
  });
});