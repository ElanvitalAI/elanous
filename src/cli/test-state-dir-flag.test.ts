/**
 * --test-state-dir 플래그 — ISO-2 config 완전 분기 계약 (2026-07-13).
 *
 * NODE_ENV=test 에서는 sync/불변식 블록이 스킵되므로(실 운영 config 미접촉)
 * 여기서는 분기 코어(플래그 추출·config-dir 강제·state env)를 고정한다.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { applyTestStateDirFlagFromArgv, extractTestStateDirFlag } from './test-state-dir-flag.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { setTestStateRoot } from '../nexus/paths.js';

describe('extractTestStateDirFlag — 순수 추출', () => {
  it('플래그+값 제거, 마지막 값 승리, = 형식 지원', () => {
    expect(extractTestStateDirFlag(['a', '--test-state-dir', '/x', 'b'])).toEqual({ dir: '/x', argv: ['a', 'b'] });
    expect(extractTestStateDirFlag(['--test-state-dir=/y']).dir).toBe('/y');
    expect(extractTestStateDirFlag(['--test-state-dir', '/x', '--test-state-dir', '/z']).dir).toBe('/z');
  });
});

describe('applyTestStateDirFlagFromArgv — ISO-2 완전 분기', () => {
  const savedArgv = [...process.argv];
  const savedStateDir = process.env.ELANOUS_STATE_DIR;

  afterEach(() => {
    process.argv = [...savedArgv];
    if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = savedStateDir;
    resetElanousConfigDir();
    setTestStateRoot(null);
  });

  it('플래그 하나로 state root + ELANOUS_STATE_DIR + config dir 전부 test 루트로', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-testflag-'));
    delete process.env.ELANOUS_STATE_DIR;
    process.argv = ['bun', 'index.ts', '--test-state-dir', dir, 'nexus', 'run'];
    const applied = applyTestStateDirFlagFromArgv();
    expect(applied).toBe(dir);
    expect(process.env.ELANOUS_STATE_DIR ?? '').toBe(dir);
    expect(getElanousConfigDirOverride()).toBe(dir); // ← config 완전 분기 핵심
    expect(process.argv).toEqual(['bun', 'index.ts', 'nexus', 'run']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('선행 --config-dir(운영 등)이 있어도 test 루트가 이긴다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-testflag-'));
    setElanousConfigDir('/somewhere/prod-like');
    process.argv = ['bun', 'index.ts', '--test-state-dir', dir];
    applyTestStateDirFlagFromArgv();
    expect(getElanousConfigDirOverride()).toBe(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it('명시한 test root가 오래된 부모 stamp를 덮어 자식 TUI 도구에 전파한다', () => {
    const inherited = mkdtempSync(join(tmpdir(), 'elanous-testflag-parent-'));
    const dir = mkdtempSync(join(tmpdir(), 'elanous-testflag-child-'));
    try {
      process.env.ELANOUS_STATE_DIR = inherited;
      process.argv = ['bun', 'index.ts', '--test-state-dir', dir, 'nexus', 'run'];

      applyTestStateDirFlagFromArgv();

      expect(process.env.ELANOUS_STATE_DIR).toBe(dir);
      expect(getElanousConfigDirOverride()).toBe(dir);
      const cli = resolve(import.meta.dir, '../../bin/elanous.mjs');
      const child = spawnSync(process.execPath, [cli, 'where', '--json'], {
        cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 15_000,
      });
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout).actualRoot).toBe(dir);
    } finally {
      rmSync(inherited, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('플래그 없으면 아무것도 안 바꾼다', () => {
    process.argv = ['bun', 'index.ts', 'nexus', 'run'];
    expect(applyTestStateDirFlagFromArgv()).toBeUndefined();
    expect(getElanousConfigDirOverride()).toBeUndefined();
  });
});
