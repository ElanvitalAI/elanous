// P.2 — `elanous nexus pwa build` subcommand · runPwaBuild unit coverage.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import { checkPwaBuildDeps, resolvePwaCwd, runPwaBuild } from '../src/cli/pwa-build.js';

function mkRepoLike(): { argvBin: string; pwaDir: string; cleanup: () => void } {
  const root = mkdtempSync(joinPath(tmpdir(), 'elanous-pwa-build-'));
  const binDir = joinPath(root, 'src');
  const pwaDir = joinPath(root, 'apps/pwa');
  const argvBin = joinPath(binDir, 'index.ts');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(pwaDir, { recursive: true });
  writeFileSync(joinPath(pwaDir, 'package.json'), '{"name":"pwa"}');
  // FU5 (2026-05-12) — the build wrapper now sanity-checks
  // apps/pwa/node_modules for required deps (@dagrejs/dagre · next ·
  // react) before spawning `bun run build`. Test fixture stubs those
  // so the precheck passes; the dedicated FU5 test file exercises the
  // missing-dep branch.
  for (const dep of ['@dagrejs/dagre', 'next', 'react']) {
    const target = joinPath(pwaDir, 'node_modules', dep);
    mkdirSync(target, { recursive: true });
    writeFileSync(joinPath(target, 'package.json'), `{"name":"${dep}","version":"1.0.0"}`);
  }
  return { argvBin, pwaDir, cleanup: () => rmSync(root, { recursive: true }) };
}

function silentSink(): { log: (s: string) => void; error: (s: string) => void; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    log: (s) => { logs.push(s); },
    error: (s) => { errors.push(s); },
    logs,
    errors,
  };
}

describe('P.2 · resolvePwaCwd', () => {
  test('argvBin 의 sibling apps/pwa/package.json 존재 시 그 dir 반환', () => {
    const { argvBin, pwaDir, cleanup } = mkRepoLike();
    expect(resolvePwaCwd(argvBin)).toBe(pwaDir);
    cleanup();
  });

  test('apps/pwa/package.json 부재 시 undefined', () => {
    const root = mkdtempSync(joinPath(tmpdir(), 'elanous-pwa-build-'));
    const argvBin = joinPath(root, 'src/index.ts');
    mkdirSync(joinPath(root, 'src'), { recursive: true });
    expect(resolvePwaCwd(argvBin)).toBeUndefined();
    rmSync(root, { recursive: true });
  });

  test('argvBin 빈 문자열 → undefined', () => {
    expect(resolvePwaCwd('')).toBeUndefined();
  });
});

describe('PWA type package precheck', () => {
  test.each([
    { field: 'types', declaration: 'dist/main.d.ts' },
    { field: 'typings', declaration: 'lib/main.d.ts' },
    { field: undefined, declaration: 'index.d.ts' },
  ])('rejects package.json-only @types dependency, then accepts $field declaration', async ({ field, declaration }) => {
    const { pwaDir, cleanup } = mkRepoLike();
    try {
      writeFileSync(joinPath(pwaDir, 'package.json'), JSON.stringify({ devDependencies: { '@types/d3-force': '^3.0.10' } }));
      const typeDir = joinPath(pwaDir, 'node_modules/@types/d3-force');
      mkdirSync(typeDir, { recursive: true });
      writeFileSync(joinPath(typeDir, 'package.json'), JSON.stringify({ name: '@types/d3-force', ...(field ? { [field]: declaration } : {}) }));
      expect(checkPwaBuildDeps(pwaDir)).toEqual({ ok: false, missing: ['@types/d3-force'] });
      const sink = silentSink();
      let spawned = false;
      const result = await runPwaBuild({ cwd: pwaDir, out: sink, spawnFn: async () => { spawned = true; return 0; } });
      expect(result.exitCode).toBe(1);
      expect(spawned).toBe(false);
      expect(sink.errors).toEqual([
        `✗ elanous nexus build: missing or incomplete node_modules in ${pwaDir}: @types/d3-force`,
        `  fix:  cd "${pwaDir}" && bun install --force`,
      ]);
      mkdirSync(joinPath(typeDir, declaration, '..'), { recursive: true });
      writeFileSync(joinPath(typeDir, declaration), 'export {};');
      expect(checkPwaBuildDeps(pwaDir)).toEqual({ ok: true, missing: [] });
    } finally { cleanup(); }
  });
});

describe('P.2 · runPwaBuild', () => {
  test('기본 cwd 자동 resolve + spawn 호출 + 성공 propagate', async () => {
    const { argvBin, pwaDir, cleanup } = mkRepoLike();
    const sink = silentSink();
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const result = await runPwaBuild({
      argvBin,
      out: sink,
      spawnFn: (cmd, args, cwd) => {
        calls.push({ cmd, args, cwd });
        return Promise.resolve(0);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.cwd).toBe(pwaDir);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('bun');
    expect(calls[0]!.args).toEqual(['run', 'build']);
    expect(calls[0]!.cwd).toBe(pwaDir);
    expect(sink.logs.some((l) => l.includes('build succeeded'))).toBe(true);
    cleanup();
  });

  test('exit code propagation — 자식 fail 시 동일 code 반환', async () => {
    const { argvBin, cleanup } = mkRepoLike();
    const sink = silentSink();
    const result = await runPwaBuild({
      argvBin,
      out: sink,
      spawnFn: () => Promise.resolve(2),
    });
    expect(result.exitCode).toBe(2);
    expect(sink.errors.some((l) => l.includes('build failed'))).toBe(true);
    expect(sink.errors.some((l) => l.includes('exit 2'))).toBe(true);
    cleanup();
  });

  test('명시 cwd 가 자동 resolve override', async () => {
    // FU5 — precheck looks at the cwd's node_modules, so we need a real
    // tmpdir with the required deps stubbed in for this case too. The
    // test still asserts the explicit cwd wins over argvBin resolution.
    const { pwaDir, cleanup } = mkRepoLike();
    const sink = silentSink();
    const calls: Array<{ cwd: string }> = [];
    const result = await runPwaBuild({
      cwd: pwaDir,
      out: sink,
      spawnFn: (_cmd, _args, cwd) => {
        calls.push({ cwd });
        return Promise.resolve(0);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.cwd).toBe(pwaDir);
    expect(calls[0]!.cwd).toBe(pwaDir);
    cleanup();
  });

  test('cwd resolution 실패 시 spawn 미호출 + exit 1', async () => {
    const root = mkdtempSync(joinPath(tmpdir(), 'elanous-pwa-build-'));
    const argvBin = joinPath(root, 'src/index.ts');
    mkdirSync(joinPath(root, 'src'), { recursive: true });
    // No apps/pwa/package.json — resolvePwaCwd returns undefined.
    const sink = silentSink();
    let spawnCalls = 0;
    const result = await runPwaBuild({
      argvBin,
      out: sink,
      spawnFn: () => {
        spawnCalls += 1;
        return Promise.resolve(0);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.cwd).toBe('');
    expect(spawnCalls).toBe(0);
    expect(sink.errors.some((e) => e.includes('could not locate apps/pwa'))).toBe(true);
    rmSync(root, { recursive: true });
  });

  test('duration 측정 (>= 0)', async () => {
    const { argvBin, cleanup } = mkRepoLike();
    const sink = silentSink();
    const result = await runPwaBuild({
      argvBin,
      out: sink,
      spawnFn: () => new Promise((r) => setTimeout(() => r(0), 5)),
    });
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    cleanup();
  });
});
