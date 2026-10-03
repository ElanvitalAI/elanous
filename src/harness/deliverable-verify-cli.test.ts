import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import type { DeployVerifyResult } from './browser-verify.js';
import { defaultPortOwnerPid, installDeliverableVerifyCliCommand, launchAndVerifyGoalDeliverable, renderDeliverableVerifyReport, verifyGoalDeliverable } from './deliverable-verify-cli.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repoRoot = resolve(import.meta.dir, '../..');
const elanousBin = join(repoRoot, 'bin/elanous.mjs');
const bunBin = process.execPath;
const stackFramePattern = /\n\s+at\s+[^\n]+/g;

const goalWith = (body: string): string => `# Goal\n\n## 산출물을 어떻게 켜나\n${body}\n`;

const verified = (overrides: Partial<DeployVerifyResult> = {}): DeployVerifyResult => ({
  ok: true,
  url: 'http://127.0.0.1:4312',
  findings: [],
  ...overrides,
});

describe('verifyGoalDeliverable', () => {
  test('observes the declared local Port and renders confirmed findings', async () => {
    const targets: string[] = [];
    const report = await verifyGoalDeliverable('/goals/web.md', {
      readGoal: async () => goalWith('Port: 4312'),
      verify: async (target) => {
        targets.push(target);
        return verified({ structuredFindings: [{ kind: 'empty-body', certainty: 'confirmed', message: 'body missing' }] });
      },
    });

    expect(targets).toEqual(['http://127.0.0.1:4312']);
    expect(report.status).toBe('observed');
    expect(renderDeliverableVerifyReport(report).join('\n')).toContain('finding: empty-body (confirmed) — body missing');
  });

  test('reports and renders the declaration stop position while observing valid labels before prose', async () => {
    const report = await verifyGoalDeliverable('/goals/prose.md', {
      readGoal: async () => goalWith(['Port: 4312', '', 'Entrypoint: npm start', '', 'The rest describes the service.'].join('\n')),
      verify: async () => verified(),
    });

    expect(report).toMatchObject({
      status: 'observed',
      declarationStoppedAt: { line: 8, text: 'The rest describes the service.' },
    });
    expect(renderDeliverableVerifyReport(report).join('\n')).toContain('launch-declaration-stopped-at: line 8: The rest describes the service.');
  });

  test('reports the original-ask fallback stop position using the enclosing document line', async () => {
    const document = [
      '# Authored goal',
      '',
      '## PROBLEM',
      'Generated context.',
      '',
      'Original ask (verbatim, unmodified):',
      '```',
      '## 산출물을 어떻게 켜나',
      'Port: 4312',
      'The preserved ask prose begins here.',
      '```',
    ].join('\n');
    const report = await verifyGoalDeliverable('/goals/original-ask.md', {
      readGoal: async () => document,
      verify: async () => verified(),
    });

    expect(report).toMatchObject({
      status: 'observed',
      declarationStoppedAt: { line: 10, text: 'The preserved ask prose begins here.' },
    });
    expect(renderDeliverableVerifyReport(report).join('\n')).toContain('launch-declaration-stopped-at: line 10: The preserved ask prose begins here.');
  });

  test('reports and renders the heading where declaration parsing stops', async () => {
    const report = await verifyGoalDeliverable('/goals/heading-boundary.md', {
      readGoal: async () => [
        '## 산출물을 어떻게 켜나',
        'Port: 4312',
        'Entrypoint: npm start',
        '## ACCEPTANCE CRITERIA',
      ].join('\n'),
      verify: async () => verified(),
    });

    expect(report).toMatchObject({
      status: 'observed',
      declarationStoppedAt: { line: 4, text: '## ACCEPTANCE CRITERIA' },
    });
    expect(renderDeliverableVerifyReport(report).join('\n')).toContain('launch-declaration-stopped-at: line 4: ## ACCEPTANCE CRITERIA');
  });

  test('renders unmeasured reasons separately from a clean measurement', async () => {
    const report = await verifyGoalDeliverable('/goals/unmeasured.md', {
      readGoal: async () => goalWith('Port: 4312'),
      verify: async () => verified({ ok: false, skipped: 'no-cdp' }),
    });

    const output = renderDeliverableVerifyReport(report).join('\n');
    expect(output).toContain('unmeasured: no-cdp');
    expect(output).not.toContain('measurement: clean');
  });

  test('distinguishes no declaration from no Port declaration without observing', async () => {
    let calls = 0;
    const noDeclaration = await verifyGoalDeliverable('/goals/no-declaration.md', {
      readGoal: async () => '# Goal',
      verify: async () => { calls += 1; return verified(); },
    });
    const noPort = await verifyGoalDeliverable('/goals/no-port.md', {
      readGoal: async () => goalWith('Entrypoint: apps/pwa'),
      verify: async () => { calls += 1; return verified(); },
    });

    expect(noDeclaration.status).toBe('no-launch-declaration');
    expect(noPort.status).toBe('no-port-declaration');
    expect(calls).toBe(0);
    expect(renderDeliverableVerifyReport(noDeclaration).join('\n')).toContain('status: no-launch-declaration');
    expect(renderDeliverableVerifyReport(noPort).join('\n')).toContain('status: no-port-declaration');
  });

  test('reports malformed declarations and goal read errors as distinct values', async () => {
    const malformed = await verifyGoalDeliverable('/goals/malformed.md', {
      readGoal: async () => goalWith('Port: nope'),
    });
    const unreadable = await verifyGoalDeliverable('/goals/missing.md', {
      readGoal: async () => { throw new Error('missing goal'); },
    });

    expect(malformed.status).toBe('invalid-launch-declaration');
    expect(renderDeliverableVerifyReport(malformed).join('\n')).toContain('Port must be an integer');
    expect(unreadable.status).toBe('read-error');
    expect(renderDeliverableVerifyReport(unreadable).join('\n')).toContain('error: missing goal');
  });
});

describe('installDeliverableVerifyCliCommand', () => {
  test('forwards the Commander goal-path argument to the verification seam', async () => {
    const output: string[] = [];
    const program = new Command().exitOverride();
    const harness = program.command('harness');
    let exitCode: number | undefined;
    installDeliverableVerifyCliCommand(harness, {
      readGoal: async (path) => {
        expect(path).toBe('/goals/forwarded.md');
        return goalWith('Port: 4312');
      },
      verify: async () => verified(),
      write: (text) => output.push(text),
      setExitCode: (code) => { exitCode = code; },
    });

    await program.parseAsync(['node', 'elanous', 'harness', 'deliverable-verify', '/goals/forwarded.md']);
    expect(output.join('')).toContain('[deliverable verify] /goals/forwarded.md');
    expect(exitCode).toBeUndefined();
  });

  test('sets a non-zero exit code when the goal document cannot be read without changing prose', async () => {
    const output: string[] = [];
    const program = new Command().exitOverride();
    const harness = program.command('harness');
    let exitCode: number | undefined;
    installDeliverableVerifyCliCommand(harness, {
      readGoal: async () => { throw new Error('missing goal'); },
      write: (text) => output.push(text),
      setExitCode: (code) => { exitCode = code; },
    });

    await program.parseAsync(['node', 'elanous', 'harness', 'deliverable-verify', '/goals/missing.md']);
    expect(exitCode).toBe(1);
    expect(output.join('')).toBe('[deliverable verify] /goals/missing.md\nstatus: read-error\nerror: missing goal\n');
  });
});

type CliRun = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
};

function runElanousCli(args: string[], cwd = repoRoot, env: NodeJS.ProcessEnv = process.env): CliRun {
  const result = spawnSync(bunBin, [elanousBin, `--test=${join(cwd, '.elanous-test')}`, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...env, NO_COLOR: '1' },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status, stdout, stderr, output: `${stdout}${stderr}` };
}

function waitForFile(path: string, timeoutMs = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function createMockCdpServer(root: string): { port: string; stop: () => void } {
  const portFile = join(root, 'port.txt');
  const script = join(root, 'cdp-version-server.js');
  writeFileSync(script, `
    import { writeFileSync } from 'node:fs';
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === '/json/new') {
          return Response.json({ id: 'target-1', webSocketDebuggerUrl: 'ws://127.0.0.1:' + server.port + '/devtools/page/mock' });
        }
        if (url.pathname === '/json/close/target-1') {
          return new Response('Target is closing');
        }
        if (url.pathname === '/devtools/page/mock') {
          if (server.upgrade(req)) return undefined;
          return new Response('upgrade failed', { status: 400 });
        }
        return new Response('not found', { status: 404 });
      },
      websocket: {
        message(ws, message) {
          const msg = JSON.parse(String(message));
          if (msg.method === 'Page.navigate') {
            if (msg.params?.url === '::::not-a-url::::') {
              ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'Cannot navigate to invalid URL' } }));
            } else {
              ws.send(JSON.stringify({ id: msg.id, result: { frameId: 'frame-1' } }));
            }
          } else if (msg.method === 'Runtime.evaluate') {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { type: 'object', value: { title: 'OK', bodyLength: 42, unloadedImageCount: 0, consecutiveDuplicateText: null } } } }));
          } else if (msg.method === 'Page.captureScreenshot') {
            ws.send(JSON.stringify({ id: msg.id, result: { data: 'aW1hZ2U=' } }));
          } else {
            ws.send(JSON.stringify({ id: msg.id, result: {} }));
          }
        },
      },
    });
    writeFileSync(process.argv[2], String(server.port));
    await new Promise(() => {});
  `);
  const server = spawn('bun', [script, portFile], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
  waitForFile(portFile);
  return { port: readFileSync(portFile, 'utf8').trim(), stop: () => server.kill() };
}

describe('actual harness CLI exit-code contract', () => {
  test('deliverable-verify missing goal exits non-zero while preserving prose and hiding stacks', () => {
    const missingPath = '/tmp/elanous-deliverable-verify-cli-missing-goal.md';
    const run = runElanousCli(['harness', 'deliverable-verify', missingPath]);

    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe(`[deliverable verify] ${missingPath}\nstatus: read-error\nerror: ENOENT: no such file or directory, open '${missingPath}'\n`);
    expect(run.output.match(stackFramePattern)?.length ?? 0).toBe(0);
  });

  test('deliverable-verify reports a signal-present missing declaration distinctly', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-deliverable-verify-cli-signal-'));
    const goalPath = join(root, 'goal.md');
    writeFileSync(goalPath, '# Goal\n\n대상 경로: src/server.ts\n');
    try {
      const run = runElanousCli(['harness', 'deliverable-verify', goalPath], root);

      expect(run.status).toBe(0);
      expect(run.stdout).toBe(`[deliverable verify] ${goalPath}\nstatus: no-launch-declaration\nlaunch-declaration-classification: absent-with-signal\n`);
      expect(run.output.match(stackFramePattern)?.length ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('deliverable-verify preserves the signal-absent missing-declaration output exactly', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-deliverable-verify-cli-no-signal-'));
    const goalPath = join(root, 'goal.md');
    writeFileSync(goalPath, '# Goal\n\n대상 경로: src/example.ts\n');
    try {
      const run = runElanousCli(['harness', 'deliverable-verify', goalPath], root);

      expect(run.status).toBe(0);
      expect(run.stdout).toBe(`[deliverable verify] ${goalPath}\nstatus: no-launch-declaration\n`);
      expect(run.output.match(stackFramePattern)?.length ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('deliverable-verify preserves declared-goal report, output, exit code, and flow', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-deliverable-verify-cli-declared-'));
    const goalPath = join(root, 'goal.md');
    writeFileSync(goalPath, goalWith('Entrypoint: src/server.ts'));
    try {
      const run = runElanousCli(['harness', 'deliverable-verify', goalPath], root);

      expect(run.status).toBe(0);
      expect(run.stdout).toBe(`[deliverable verify] ${goalPath}\nstatus: no-port-declaration\n`);
      expect(run.output.match(stackFramePattern)?.length ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * ⛔⭐⭐ **이 시험의 «전제»는 「기본 CDP 포트에 아무도 없다」이고, 그것은 «주변 환경»이다.**
   *
   * 🚨 2026-08-28 에 드러난 것: 이 시험은 목 CDP 서버를 세우고 `ELANOUS_CDP_PORT` 로 가리켰는데
   *    ***그 환경변수를 읽는 코드가 «0곳»이다***(`rg -uu 'ELANOUS_CDP_PORT' src/` ⇒ 0줄).
   *    ⇒ 격리가 «가짜»였다. 같은 파일의 다른 두 시험은 진짜 플래그 `--port` 를 쓴다.
   *    ⇒ 브라우저가 떠 있는 기계(= 봇을 모는 이 저장소의 «정상» 상태)에서는 실제 브라우저를 보고
   *       `cdp-error` 를 내므로 ***영영 빨갛다***. 나는 이 빨강을 「남의 것」으로 격리해 뒀고,
   *       ***그 기록이 내 새 회귀를 가렸다***(`#13671`).
   *
   * ⇒ ⭐ 처방(대표 저장소 처방 그대로): ***전제를 「단언」이 아니라 «선언»으로 만든다.***
   *    ⛔ 그리고 조용히 건너뛰지 «않는다» — 「못 쟀다」를 산출에 «남긴다».
   *
   * 🔵 남긴 물음(제품 축 · 소유자 판단): ***`deliverable-verify` 가 `--port` 를 받아야 하나.***
   *    받으면 이 전제를 «환경»이 아니라 «인자»로 만들 수 있다.
   */
  test('deliverable-verify omits backend and preserves the existing stdout exactly', async () => {
    const cdpBusy = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(1500) })
      .then(() => true).catch(() => false);
    if (cdpBusy) {
      console.log('⚪ 못 쟀다: 기본 CDP 포트(9222)에 브라우저가 «있다» — 이 시험의 전제는 「없다」이고,'
        + ' 이 경로는 포트를 인자로 못 받는다(ELANOUS_CDP_PORT 를 읽는 코드가 0곳). 판정 불가 — «통과가 아니다».');
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'elanous-deliverable-verify-cli-default-'));
    const goalPath = join(root, 'goal.md');
    writeFileSync(goalPath, goalWith('Port: 4312'));
    try {
      const run = runElanousCli(['harness', 'deliverable-verify', goalPath], root);

      expect(run.status).toBe(0);
      expect(run.stdout).toBe(`[deliverable verify] ${goalPath}\nstatus: observed\ntarget: http://127.0.0.1:4312\nunmeasured: no-cdp\n`);
      expect(run.output.match(stackFramePattern)?.length ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('deliverable-verify forwards aside to the browser backend', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-deliverable-verify-cli-aside-'));
    const goalPath = join(root, 'goal.md');
    writeFileSync(goalPath, goalWith('Port: 4312'));
    const asidePath = join(root, 'aside');
    writeFileSync(asidePath, '#!/bin/sh\nprintf \'{"title":"Aside","bodyLength":42,"unloadedImageCount":0,"screenshotBytes":5}\\n[ok | fake]\\n\'\n');
    chmodSync(asidePath, 0o755);
    try {
      const run = runElanousCli(['harness', 'deliverable-verify', '--backend', 'aside', goalPath], root, { ...process.env, PATH: root });

      expect(run.status).toBe(0);
      expect(run.stdout).toBe(`[deliverable verify] ${goalPath}\nstatus: observed\ntarget: http://127.0.0.1:4312\nunmeasured: javascript-errors\n`);
      expect(run.output.match(stackFramePattern)?.length ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test('deliverable-verify rejects an invalid backend without a stack trace', () => {
    const run = runElanousCli(['harness', 'deliverable-verify', '--backend', 'unknown', '/tmp/goal.md']);

    expect(run.status).not.toBe(0);
    expect(run.output).toContain("option '--backend <backend>' argument 'unknown' is invalid. Allowed choices are cdp, aside.");
    expect(run.output.match(stackFramePattern)?.length ?? 0).toBe(0);
  });

  test('verify-url invalid URL exits non-zero while preserving prose and hiding stacks', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-verify-url-cli-'));
    const server = createMockCdpServer(root);
    try {
      const run = runElanousCli(['harness', 'verify-url', '--port', server.port, '::::not-a-url::::'], root);

      expect(run.status).not.toBe(0);
      expect(run.stdout).toBe(`\n━━ 배포 검증: ::::not-a-url:::: ━━\n  ⚠️ 문제 감지\n  title: (없음)\n  본문 길이: ? · 스크린샷: 0 bytes\n  - CDP 검증 오류: Cannot navigate to invalid URL\n`);
      expect(run.output.match(stackFramePattern)?.length ?? 0).toBe(0);
    } finally {
      // ⛔⭐ 🚨 이 한 줄이 «없어서» 이 시험은 매 실행마다 ***고아 프로세스를 하나씩 남겼다***.
      //    📏 2026-08-29 실측: `ppid=1` 인 `…/elanous-verify-url-cli-XXXX/cdp-version-server` 가 «셋» 살아 있었고
      //       가장 오래된 것은 ***1일 2시간째***였다(접미사 없는 이름 = 정확히 이 시험).
      //    ⚠️ 바로 아래 형제 시험(`-success-`)에는 이 줄이 «있었다» — 그래서 눈에 안 띄었다.
      //    ⛔ 죽이는 것이 «먼저»다: 서버가 그 디렉터리에서 돌고 있으므로 지우기 전에 멎어야 한다.
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('verify-url omits backend and preserves the existing stdout exactly', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-verify-url-cli-success-'));
    const server = createMockCdpServer(root);
    try {
      const run = runElanousCli(['harness', 'verify-url', '--port', server.port, 'http://example.test/'], root);

      expect(run.status).toBe(0);
      expect(run.stdout).toBe(`\n━━ 배포 검증: http://example.test/ ━━\n  ✅ 렌더 정상\n  title: OK\n  본문 길이: 42 · 스크린샷: 5 bytes\n`);
      expect(run.output.match(stackFramePattern)?.length ?? 0).toBe(0);
    } finally {
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('verify-url rejects an invalid backend without a stack trace', () => {
    const run = runElanousCli(['harness', 'verify-url', '--backend', 'unknown', 'http://example.test/']);

    expect(run.status).not.toBe(0);
    expect(run.output).toContain("option '--backend <backend>' argument 'unknown' is invalid. Allowed choices are cdp, aside.");
    expect(run.output.match(stackFramePattern)?.length ?? 0).toBe(0);
  });

  test('verify-url aside writes reported screenshot bytes and exits zero', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-verify-url-aside-shot-'));
    const aside = join(root, 'aside');
    const shot = join(root, 'shot.png');
    const png = Buffer.from('89504e470d0a1a0a00010203', 'hex');
    writeFileSync(aside, `#!/bin/sh\nprintf '%s\\n' '{"title":"Page","bodyLength":80,"unloadedImageCount":0,"screenshotBytes":${png.length}}' 'ELANOUS_SHOT_BASE64:${png.toString('base64')}' '[ok | 1ms]'\n`);
    chmodSync(aside, 0o755);
    try {
      const run = runElanousCli(['harness', 'verify-url', 'https://example.com', '--backend', 'aside', '--shot', shot], root, { ...process.env, PATH: root, HOME: root });
      expect(run.status).toBe(0);
      expect(readFileSync(shot)).toEqual(png);
      expect(run.stdout).toContain(`스크린샷: ${png.length} bytes → ${shot}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('verify-url aside 0-byte screenshot exits nonzero with finding', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-verify-url-aside-zero-'));
    const aside = join(root, 'aside');
    const shot = join(root, 'shot.png');
    writeFileSync(aside, '#!/bin/sh\nprintf \'%s\\n\' \'{"title":"Page","bodyLength":80,"unloadedImageCount":0,"screenshotBytes":0}\' \'[ok | 1ms]\'\n');
    chmodSync(aside, 0o755);
    try {
      const run = runElanousCli(['harness', 'verify-url', 'https://example.com', '--backend', 'aside', '--shot', shot], root, { ...process.env, PATH: root, HOME: root });
      expect(run.status).toBe(1);
      expect(existsSync(shot)).toBe(false);
      expect(run.stdout).toContain('스크린샷 0바이트 — 렌더 증거 없음');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('verify-url --shot write failure reports the reason and exits one for both backends', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-verify-url-write-fail-'));
    const shot = join(root, 'missing', 'shot.png');
    const aside = join(root, 'aside');
    writeFileSync(aside, '#!/bin/sh\nprintf \'%s\\n\' \'{"title":"Page","bodyLength":80,"unloadedImageCount":0,"screenshotBytes":5}\' \'ELANOUS_SHOT_BASE64:aW1hZ2U=\' \'[ok | 1ms]\'\n');
    chmodSync(aside, 0o755);
    const server = createMockCdpServer(root);
    try {
      for (const args of [['--backend', 'aside'], ['--port', server.port]]) {
        const run = runElanousCli(['harness', 'verify-url', 'https://example.com', ...args, '--shot', shot], root, { ...process.env, PATH: root, HOME: root });
        expect(run.status).toBe(1);
        expect(run.stdout).toContain(`스크린샷을 ${shot} 에 못 썼다 — ENOENT`);
        expect(existsSync(shot)).toBe(false);
      }
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  });

  test('verify-url aside without its executable reports a non-blocking backend-specific skip', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-verify-url-cli-aside-'));
    try {
      // ⛔ PATH 만 비우면 안 된다 — `src/ensure-bin-path.ts` 가 `~/.local/bin` 등을 뒤에 붙여, aside 가 깔린 기계에선
      //   진짜 aside 로 검증이 돈다(2026-09-24 이 맥에서 fail). HOME 도 비워 보강 후보를 없는 자리로 만든다.
      const run = runElanousCli(['harness', 'verify-url', '--backend', 'aside', '--shot', join(root, 'missing.png'), 'http://example.test/'], root, { ...process.env, PATH: root, HOME: root });

      expect(run.status).toBe(0);
      expect(run.stdout).toBe('⚠️ aside 실행 파일을 찾을 수 없음 — 검증 skip. aside 부재는 배포 검증을 막지 않습니다.\n');
      expect(run.output.match(stackFramePattern)?.length ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('launchAndVerifyGoalDeliverable — 기동기 배선(--launch)', () => {
  const handle = (url: string, attribution: 'confirmed' | 'unverified', onStop: () => void) => ({
    url, attribution, stop: async () => { onStop(); },
  });

  test('켜서 보고 «반드시» 끈다 — 관측 성공 경로', async () => {
    let stopped = 0;
    const report = await launchAndVerifyGoalDeliverable('goal.md', '/repo', {
      launch: async () => ({ ok: true, command: 'bun run start', handle: handle('http://127.0.0.1:39100', 'confirmed', () => { stopped += 1; }) }),
      verify: async () => ({ ok: true, url: 'http://127.0.0.1:39100', findings: [] }),
    } as never);
    expect(report.status).toBe('observed');
    expect(report.target).toBe('http://127.0.0.1:39100');
    expect(report.attribution).toBe('confirmed');
    expect(stopped).toBe(1);
  });

  test('눈이 throw 해도 «끄고» 못 잼으로 남긴다 — 관측 계약을 따른다', async () => {
    let stopped = 0;
    const report = await launchAndVerifyGoalDeliverable('goal.md', '/repo', {
      launch: async () => ({ ok: true, command: 'c', handle: handle('http://127.0.0.1:39101', 'unverified', () => { stopped += 1; }) }),
      verify: async () => { throw new Error('observer exploded'); },
    } as never);
    expect(stopped).toBe(1);                                   // ⭐ 정리는 «반드시» 난다
    expect(report.status).toBe('observed');
    expect(report.observation?.unmeasured.length).toBeGreaterThan(0);   // ⛔ 「이상 없음」으로 접히지 않는다
  });

  test('관측이 «거부»해도 끈다 — 정리는 finally 가 덮는다', async () => {
    let stopped = 0;
    await expect(launchAndVerifyGoalDeliverable('goal.md', '/repo', {
      launch: async () => ({ ok: true, command: 'c', handle: handle('http://127.0.0.1:39104', 'unverified', () => { stopped += 1; }) }),
      // ⭐ 관측 «계층»을 통째로 거부시킨다 — 눈의 예외를 흡수하는 계약보다 «위»의 실패다
      observe: async () => { throw new Error('observation layer rejected'); },
    } as never)).rejects.toThrow('observation layer rejected');
    expect(stopped).toBe(1);
  });

  test('못 켜면 launch-failed 이고 그 사유를 값으로 낸다', async () => {
    const report = await launchAndVerifyGoalDeliverable('goal.md', '/repo', {
      launch: async () => ({ ok: false, reason: 'port-timeout', detail: 'port 39102 did not respond' }),
    } as never);
    expect(report.status).toBe('launch-failed');
    expect(report.launchFailure).toBe('port-timeout');
    expect(renderDeliverableVerifyReport(report).join('\n')).toContain('launch-failure: port-timeout');
  });

  test('귀속이 unverified 면 산출에 그대로 보인다 — confirmed 로 올리지 않는다', async () => {
    const report = await launchAndVerifyGoalDeliverable('goal.md', '/repo', {
      launch: async () => ({ ok: true, command: 'c', handle: handle('http://127.0.0.1:39103', 'unverified', () => {}) }),
      verify: async () => ({ ok: true, url: 'http://127.0.0.1:39103', findings: [] }),
    } as never);
    expect(report.attribution).toBe('unverified');
    expect(renderDeliverableVerifyReport(report).join('\n')).toContain('attribution: unverified');
  });
});


describe('--launch 기본 경로가 «귀속 확인»을 실제로 꽂는가(9차)', () => {
  test('심을 안 주면 기본 portOwnerPid 가 기동기로 «전달»된다 — 기본 경로가 언제나 unverified 이면 안 된다', async () => {
    let sawPortOwnerPid = false;
    await launchAndVerifyGoalDeliverable('goal.md', '/repo', {
      launch: async (_goalPath: string, launchDeps: { portOwnerPid?: unknown; repositoryRoot?: string }) => {
        sawPortOwnerPid = typeof launchDeps.portOwnerPid === 'function';
        return { ok: false, reason: 'port-timeout' };
      },
    } as never);
    expect(sawPortOwnerPid).toBe(true);
  });

  test('저장소 뿌리를 «인자로» 받아 기동기에 그대로 넘긴다 — cwd 를 읽지 않는다', async () => {
    let seenRoot: string | undefined;
    await launchAndVerifyGoalDeliverable('goal.md', '/explicit/root', {
      launch: async (_goalPath: string, launchDeps: { portOwnerPid?: unknown; repositoryRoot?: string }) => {
        seenRoot = launchDeps.repositoryRoot;
        return { ok: false, reason: 'port-timeout' };
      },
    } as never);
    expect(seenRoot).toBe('/explicit/root');
  });

  test('기본 포트 소유 조회는 도구가 없거나 실패하면 undefined 다 — 「없다」로 접지 않는다', () => {
    // 아무도 안 듣는 포트를 물으면 undefined 여야 한다(lsof 가 없어도 undefined).
    expect(defaultPortOwnerPid(59_999)).toBeUndefined();
  });
});
