// P.1 — PWA static export auto-detect.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, dirname } from 'node:path';

import { resolvePwaStaticDir } from '../src/nexus/static-dir-resolve.js';

function mkRepoLike(): { argvBin: string; pwaOut: string; cleanup: () => void } {
  const root = mkdtempSync(joinPath(tmpdir(), 'elanous-pwa-resolve-'));
  const binDir = joinPath(root, 'src');
  const pwaOut = joinPath(root, 'apps/pwa/out');
  const argvBin = joinPath(binDir, 'index.ts');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(pwaOut, { recursive: true });
  return { argvBin, pwaOut: realpathSync(pwaOut), cleanup: () => rmSync(root, { recursive: true }) };
}

describe('P.1 · resolvePwaStaticDir', () => {
  test('repo dev path 우선 (apps/pwa/out 존재 시)', () => {
    const { argvBin, pwaOut, cleanup } = mkRepoLike();
    const got = resolvePwaStaticDir({ argvBin });
    expect(got).toBe(pwaOut);
    cleanup();
  });

  test('repo dev path 부재 + 명시 candidate 인 npm install path → 그것 사용', () => {
    const root = mkdtempSync(joinPath(tmpdir(), 'elanous-pwa-resolve-'));
    const npmShare = joinPath(root, 'share/elanous/pwa-out');
    mkdirSync(npmShare, { recursive: true });
    const got = resolvePwaStaticDir({
      candidates: [
        joinPath(root, 'apps/pwa/out'),  // 부재
        npmShare,                         // 존재
      ],
    });
    expect(got).toBe(realpathSync(npmShare));
    rmSync(root, { recursive: true });
  });

  test('모든 후보 부재 → undefined', () => {
    const got = resolvePwaStaticDir({
      candidates: ['/nonexistent/a', '/nonexistent/b'],
    });
    expect(got).toBeUndefined();
  });

  test('argvBin 빈 문자열 → undefined (default candidates 0개)', () => {
    const got = resolvePwaStaticDir({ argvBin: '' });
    expect(got).toBeUndefined();
  });

  test('exists override 로 fully isolated', () => {
    const got = resolvePwaStaticDir({
      candidates: ['/x/y/z', '/a/b/c'],
      exists: (p) => p === '/a/b/c',
    });
    expect(got).toBe('/a/b/c');
  });
});

describe('P.1 · default candidates derivation', () => {
  test('argvBin 의 dirname 기준 두 후보 produce', () => {
    // The function exposes candidates implicitly via `defaultCandidates`
    // — observe via the exists override capturing what paths get probed.
    const probed: string[] = [];
    resolvePwaStaticDir({
      argvBin: '/Users/x/repo/src/index.ts',
      exists: (p) => { probed.push(p); return false; },
    });
    expect(probed).toContain('/Users/x/repo/apps/pwa/out');
    expect(probed).toContain('/Users/x/repo/share/elanous/pwa-out');
  });

  test('order = repo dev path first', () => {
    const probed: string[] = [];
    resolvePwaStaticDir({
      argvBin: '/x/bin/elanous',
      exists: (p) => { probed.push(p); return false; },
    });
    expect(probed[0]).toContain('apps/pwa/out');
    expect(probed[1]).toContain('share/elanous/pwa-out');
  });
});

// Sanity: dirname helper still available (no missing import regression)
describe('P.1 · sanity', () => {
  test('dirname produces parent dir', () => {
    expect(dirname('/a/b/c')).toBe('/a/b');
  });
});

// 🆕 2026-09-24 (재시작 최소화 RFC S2) — 설치본 패키지엔 `apps/` 가 없다. 명시 지정이 부팅과 셋업 검사에 «같이» 먹어야
//   설치본 데몬이 «PWA 미빌드»로 exit 1 → launchd 크래시 루프에 안 빠진다.
describe('S2 · ELANOUS_PWA_STATIC_DIR', () => {
  test('an existing explicit dir wins over the binary-relative candidates', () => {
    const probed: string[] = [];
    const got = resolvePwaStaticDir({
      argvBin: '/prefix/versions/1.0.0-abc/node_modules/elanous/bin/elanous.mjs',
      env: { ELANOUS_PWA_STATIC_DIR: '/srv/pwa/out' },
      exists: (p) => { probed.push(p); return p === '/srv/pwa/out'; },
    });
    expect(got).toBe('/srv/pwa/out');
    expect(probed).toEqual(['/srv/pwa/out']);
  });

  test('a missing explicit dir falls back to the usual candidates', () => {
    const got = resolvePwaStaticDir({
      argvBin: '/x/repo/bin/elanous.mjs',
      env: { ELANOUS_PWA_STATIC_DIR: '/nowhere' },
      exists: (p) => p === '/x/repo/apps/pwa/out',
    });
    expect(got).toBe('/x/repo/apps/pwa/out');
  });

  test('the headless setup check sees the explicit dir (installed layout has no apps/)', async () => {
    const { checkSetupStatus } = await import('../src/nexus/setup-status.js');
    const dir = mkdtempSync(joinPath(tmpdir(), 'pwa-out-'));
    const saved = process.env.ELANOUS_PWA_STATIC_DIR;
    process.env.ELANOUS_PWA_STATIC_DIR = dir;
    try {
      const result = checkSetupStatus({ argvBin: '/prefix/versions/v/node_modules/elanous/bin/elanous.mjs' });
      expect(result.required.find((i) => i.id === 'pwa-build')?.passed).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.ELANOUS_PWA_STATIC_DIR; else process.env.ELANOUS_PWA_STATIC_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 🆕 2026-09-24 — 설치본은 심링크(`<prefix>/bin/elanous`)로 불린다. 실경로 옆 apps/pwa/out 을 찾는다.
import { mkdirSync as mkdirR, mkdtempSync as mkdtempR, rmSync as rmR, symlinkSync, writeFileSync as writeR, realpathSync as realR } from 'node:fs';
import { tmpdir as tmpR } from 'node:os';
describe('installed copy invoked through a symlink', () => {
  test('finds <pkg>/apps/pwa/out via the realpath of argv[1]', () => {
    const root = realR(mkdtempR(joinPath(tmpR(), 'elanous-pwa-link-')));
    try {
      const pkg = joinPath(root, 'versions/1.0.0-abc/node_modules/elanous');
      mkdirR(joinPath(pkg, 'bin'), { recursive: true });
      mkdirR(joinPath(pkg, 'apps/pwa/out'), { recursive: true });
      writeR(joinPath(pkg, 'bin/elanous.mjs'), '');
      mkdirR(joinPath(root, 'bin'), { recursive: true });
      symlinkSync(joinPath(pkg, 'bin/elanous.mjs'), joinPath(root, 'bin/elanous'));
      expect(resolvePwaStaticDir({ argvBin: joinPath(root, 'bin/elanous'), env: {} })).toBe(joinPath(pkg, 'bin', '..', 'apps/pwa/out'));
    } finally { rmR(root, { recursive: true, force: true }); }
  });
});
