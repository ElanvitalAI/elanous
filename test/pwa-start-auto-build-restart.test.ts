import { describe, expect, test } from 'bun:test';

import { runPwaStart } from '../src/cli/pwa-start.js';

interface CapturedOut {
  log: (s: string) => void;
  error: (s: string) => void;
  logs: string[];
  errors: string[];
}

function makeOut(): CapturedOut {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    log: (s) => logs.push(s),
    error: (s) => errors.push(s),
    logs,
    errors,
  };
}

describe('runPwaStart — auto-build (A)', () => {
  test('static + autoBuild + stale → buildFn called once before bgLaunch', async () => {
    let buildCalls = 0;
    let buildOrderTag = '';
    let bgCalls = 0;
    const out = makeOut();
    await runPwaStart({
      mode: 'static',
      autoBuild: true,
      out,
      resolvePwaCwdFn: () => '/fake/apps/pwa',
      stalenessFn: () => ({ stale: true, reason: 'source-newer' }),
      buildFn: async () => {
        buildCalls += 1;
        buildOrderTag = bgCalls === 0 ? 'before-bg' : 'after-bg';
        return { exitCode: 0, cwd: '/fake/apps/pwa', durationMs: 5 };
      },
      bgLaunchFn: async () => {
        bgCalls += 1;
        return { exitCode: 0, pid: 12345, logPath: '/tmp/log' };
      },
      readShareSwitchFn: () => 'disabled',
      shareProbeFn: async () => ({ installed: false, alive: false }),
      registerInstanceFn: () => { /* no-op */ },
    });
    expect(buildCalls).toBe(1);
    expect(buildOrderTag).toBe('before-bg');
    expect(bgCalls).toBe(1);
    expect(out.logs.some((l) => l.includes('auto-build: PWA bundle stale (source-newer)'))).toBe(true);
  });

  test('static + autoBuild + fresh → buildFn NOT called', async () => {
    let buildCalls = 0;
    await runPwaStart({
      mode: 'static',
      autoBuild: true,
      resolvePwaCwdFn: () => '/fake/apps/pwa',
      stalenessFn: () => ({ stale: false, reason: 'fresh' }),
      buildFn: async () => { buildCalls += 1; return { exitCode: 0, cwd: '', durationMs: 0 }; },
      bgLaunchFn: async () => ({ exitCode: 0, pid: 1 }),
      readShareSwitchFn: () => 'disabled',
      shareProbeFn: async () => ({ installed: false, alive: false }),
      registerInstanceFn: () => { /* */ },
    });
    expect(buildCalls).toBe(0);
  });

  test('autoBuild=false skips staleness build even when source is newer', async () => {
    let buildCalls = 0;
    await runPwaStart({
      mode: 'static',
      autoBuild: false,
      resolvePwaCwdFn: () => '/fake/apps/pwa',
      stalenessFn: () => ({ stale: true, reason: 'source-newer' }),
      buildFn: async () => { buildCalls += 1; return { exitCode: 0, cwd: '', durationMs: 0 }; },
      bgLaunchFn: async () => ({ exitCode: 0, pid: 1 }),
      readShareSwitchFn: () => 'disabled',
      shareProbeFn: async () => ({ installed: false, alive: false }),
      registerInstanceFn: () => { /* */ },
    });
    expect(buildCalls).toBe(0);
  });

  test('--rebuild forces build even when fresh', async () => {
    let buildCalls = 0;
    await runPwaStart({
      mode: 'static',
      rebuild: true,
      resolvePwaCwdFn: () => '/fake/apps/pwa',
      stalenessFn: () => ({ stale: false, reason: 'fresh' }),
      buildFn: async () => { buildCalls += 1; return { exitCode: 0, cwd: '', durationMs: 0 }; },
      bgLaunchFn: async () => ({ exitCode: 0, pid: 1 }),
      readShareSwitchFn: () => 'disabled',
      shareProbeFn: async () => ({ installed: false, alive: false }),
      registerInstanceFn: () => { /* */ },
    });
    expect(buildCalls).toBe(1);
  });

  test('build failure short-circuits start (no bgLaunch call)', async () => {
    let bgCalls = 0;
    const result = await runPwaStart({
      mode: 'static',
      rebuild: true,
      resolvePwaCwdFn: () => '/fake/apps/pwa',
      stalenessFn: () => ({ stale: true, reason: 'source-newer' }),
      buildFn: async () => ({ exitCode: 7, cwd: '', durationMs: 1 }),
      bgLaunchFn: async () => { bgCalls += 1; return { exitCode: 0, pid: 1 }; },
    });
    expect(result.exitCode).toBe(7);
    expect(bgCalls).toBe(0);
  });

  test('autoInstall=true + deps missing → installFn called BEFORE buildFn', async () => {
    let installCalls = 0;
    let buildCalls = 0;
    let installBeforeBuild = false;
    await runPwaStart({
      mode: 'static',
      autoBuild: true,
      autoInstall: true,
      resolvePwaCwdFn: () => '/fake/apps/pwa',
      stalenessFn: () => ({ stale: true, reason: 'source-newer' }),
      depsCheckFn: () => ({ ok: false, missing: ['@dagrejs/dagre', 'next'] }),
      installFn: async () => {
        installCalls += 1;
        installBeforeBuild = buildCalls === 0;
        return { exitCode: 0, durationMs: 5 };
      },
      buildFn: async () => { buildCalls += 1; return { exitCode: 0, cwd: '', durationMs: 0 }; },
      bgLaunchFn: async () => ({ exitCode: 0, pid: 1 }),
      readShareSwitchFn: () => 'disabled',
      shareProbeFn: async () => ({ installed: false, alive: false }),
      registerInstanceFn: () => { /* */ },
    });
    expect(installCalls).toBe(1);
    expect(installBeforeBuild).toBe(true);
    expect(buildCalls).toBe(1);
  });

  test('PWA-RUNTIME-LEAN: installed package with this version\'s prebuilt PWA → no auto-install, no build even when stale or --rebuild', async () => {
    for (const rebuild of [false, true]) {
      let installCalls = 0;
      let buildCalls = 0;
      await runPwaStart({
        mode: 'static',
        autoBuild: true,
        autoInstall: true,
        rebuild,
        resolvePwaCwdFn: () => '/fake/apps/pwa',
        prebuiltFn: () => ({ kind: 'prebuilt', commit: 'a'.repeat(40) }),
        stalenessFn: () => ({ stale: true, reason: 'source-newer' }),
        depsCheckFn: () => ({ ok: false, missing: ['next'] }),
        installFn: async () => { installCalls += 1; return { exitCode: 0, durationMs: 0 }; },
        buildFn: async () => { buildCalls += 1; return { exitCode: 0, cwd: '', durationMs: 0 }; },
        bgLaunchFn: async () => ({ exitCode: 0, pid: 1 }),
        readShareSwitchFn: () => 'disabled',
        shareProbeFn: async () => ({ installed: false, alive: false }),
        registerInstanceFn: () => { /* */ },
      });
      expect(installCalls).toBe(0);
      expect(buildCalls).toBe(0);
    }
  });

  test('autoInstall=true + deps OK → installFn NOT called', async () => {
    let installCalls = 0;
    let buildCalls = 0;
    await runPwaStart({
      mode: 'static',
      autoBuild: true,
      autoInstall: true,
      resolvePwaCwdFn: () => '/fake/apps/pwa',
      stalenessFn: () => ({ stale: true, reason: 'source-newer' }),
      depsCheckFn: () => ({ ok: true, missing: [] }),
      installFn: async () => { installCalls += 1; return { exitCode: 0, durationMs: 0 }; },
      buildFn: async () => { buildCalls += 1; return { exitCode: 0, cwd: '', durationMs: 0 }; },
      bgLaunchFn: async () => ({ exitCode: 0, pid: 1 }),
      readShareSwitchFn: () => 'disabled',
      shareProbeFn: async () => ({ installed: false, alive: false }),
      registerInstanceFn: () => { /* */ },
    });
    expect(installCalls).toBe(0);
    expect(buildCalls).toBe(1);
  });

  test('autoInstall=false + deps missing → installFn NOT called (legacy diagnostic surfaces)', async () => {
    let installCalls = 0;
    let buildCalls = 0;
    await runPwaStart({
      mode: 'static',
      autoBuild: true,
      autoInstall: false,
      resolvePwaCwdFn: () => '/fake/apps/pwa',
      stalenessFn: () => ({ stale: true, reason: 'source-newer' }),
      depsCheckFn: () => ({ ok: false, missing: ['@dagrejs/dagre'] }),
      installFn: async () => { installCalls += 1; return { exitCode: 0, durationMs: 0 }; },
      buildFn: async () => { buildCalls += 1; return { exitCode: 0, cwd: '', durationMs: 0 }; },
      bgLaunchFn: async () => ({ exitCode: 0, pid: 1 }),
      readShareSwitchFn: () => 'disabled',
      shareProbeFn: async () => ({ installed: false, alive: false }),
      registerInstanceFn: () => { /* */ },
    });
    expect(installCalls).toBe(0);
    // buildFn still runs and (in real life) emits the "missing
    // node_modules" diagnostic — we don't simulate that here.
    expect(buildCalls).toBe(1);
  });

  test('autoInstall failure short-circuits before build + start', async () => {
    let buildCalls = 0;
    let bgCalls = 0;
    const r = await runPwaStart({
      mode: 'static',
      autoBuild: true,
      autoInstall: true,
      resolvePwaCwdFn: () => '/fake/apps/pwa',
      stalenessFn: () => ({ stale: true, reason: 'out-missing' }),
      depsCheckFn: () => ({ ok: false, missing: ['next'] }),
      installFn: async () => ({ exitCode: 13, durationMs: 5 }),
      buildFn: async () => { buildCalls += 1; return { exitCode: 0, cwd: '', durationMs: 0 }; },
      bgLaunchFn: async () => { bgCalls += 1; return { exitCode: 0, pid: 1 }; },
    });
    expect(r.exitCode).toBe(13);
    expect(buildCalls).toBe(0);
    expect(bgCalls).toBe(0);
  });

  test('HMR mode skips staleness check (dev server owns iteration)', async () => {
    let stalenessCalls = 0;
    let buildCalls = 0;
    let bgCalls = 0;
    // We make bgLaunch fail-fast so we never reach the HMR dev BG probe.
    // The point of this test is to confirm maybeAutoBuild short-circuits
    // for HMR — both the staleness predicate and the build never fire.
    await runPwaStart({
      mode: 'hmr',
      resolvePwaCwdFn: () => '/fake/apps/pwa',
      stalenessFn: () => { stalenessCalls += 1; return { stale: true, reason: 'source-newer' }; },
      buildFn: async () => { buildCalls += 1; return { exitCode: 0, cwd: '', durationMs: 0 }; },
      bgLaunchFn: async () => { bgCalls += 1; return { exitCode: 1 }; },
      listInstancesFn: () => [], // skip same-tree retry
    });
    expect(stalenessCalls).toBe(0);
    expect(buildCalls).toBe(0);
    expect(bgCalls).toBe(1);
  });
});

describe('runPwaStart — same-tree auto-restart (B)', () => {
  test('port collision + same-tree → stopFn called, bgLaunch retried once', async () => {
    let bgCalls = 0;
    let stopCalls = 0;
    await runPwaStart({
      mode: 'static',
      autoBuild: false,
      autoRestart: true,
      bgLaunchFn: async () => {
        bgCalls += 1;
        return bgCalls === 1 ? { exitCode: 1 } : { exitCode: 0, pid: 12345 };
      },
      listInstancesFn: () => [{ cwd: process.cwd(), alive: true, daemonDir: '/some/dir' }],
      stopFn: async (_opts) => { stopCalls += 1; return { exitCode: 0, devKilled: false, nexusStopped: false, shareReset: false, shareUnmount: { status: 'skipped', reason: 'pwa-port-unknown' } }; },
      readShareSwitchFn: () => 'disabled',
      shareProbeFn: async () => ({ installed: false, alive: false }),
      registerInstanceFn: () => { /* */ },
    });
    expect(bgCalls).toBe(2);
    expect(stopCalls).toBe(1);
  });

  test('port collision + cross-tree → stopFn NOT called, 4-option hint shown', async () => {
    let bgCalls = 0;
    let stopCalls = 0;
    const out = makeOut();
    const r = await runPwaStart({
      mode: 'static',
      autoBuild: false,
      autoRestart: true,
      out,
      bgLaunchFn: async () => { bgCalls += 1; return { exitCode: 1 }; },
      listInstancesFn: () => [
        { cwd: '/some/OTHER/tree', alive: true, daemonDir: '/some/other/dir' },
      ],
      stopFn: async (_opts) => { stopCalls += 1; return { exitCode: 0, devKilled: false, nexusStopped: false, shareReset: false, shareUnmount: { status: 'skipped', reason: 'pwa-port-unknown' } }; },
    });
    expect(r.exitCode).toBe(1);
    expect(bgCalls).toBe(1);
    expect(stopCalls).toBe(0);
    expect(out.errors.some((e) => e.includes('nexus failed to claim port'))).toBe(true);
  });

  test('autoRestart=false → stopFn NOT called even on same-tree collision', async () => {
    let stopCalls = 0;
    await runPwaStart({
      mode: 'static',
      autoBuild: false,
      autoRestart: false,
      bgLaunchFn: async () => ({ exitCode: 1 }),
      listInstancesFn: () => [{ cwd: process.cwd(), alive: true, daemonDir: '/d' }],
      stopFn: async (_opts) => { stopCalls += 1; return { exitCode: 0, devKilled: false, nexusStopped: false, shareReset: false, shareUnmount: { status: 'skipped', reason: 'pwa-port-unknown' } }; },
    });
    expect(stopCalls).toBe(0);
  });

  test('retry still fails → final exit non-zero (no infinite loop)', async () => {
    let bgCalls = 0;
    const r = await runPwaStart({
      mode: 'static',
      autoBuild: false,
      autoRestart: true,
      bgLaunchFn: async () => { bgCalls += 1; return { exitCode: 1 }; },
      listInstancesFn: () => [{ cwd: process.cwd(), alive: true, daemonDir: '/d' }],
      stopFn: async (_opts) => ({ exitCode: 0, devKilled: false, nexusStopped: false, shareReset: false, shareUnmount: { status: 'skipped', reason: 'pwa-port-unknown' } }),
    });
    expect(r.exitCode).toBe(1);
    expect(bgCalls).toBe(2); // exactly one retry, no infinite loop
  });
});
