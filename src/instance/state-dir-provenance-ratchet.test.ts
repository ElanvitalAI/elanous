import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { addHarnessQueue, harnessQueueReceiptPath, tickHarnessQueue, type HarnessQueueDeps } from '../harness/harness-queue.js';
import { stateDirSourceForChild } from '../agent/identity-env.js';

/**
 * ⛔⭐⭐⭐ **정적 래칫 — `ELANOUS_STATE_DIR` 을 자식 env 에 세우는 자리엔 «출처»가 같이 있어야 한다.**
 *
 * 🚨 왜 있나(2026-08-19) — 같은 결함을 ***세 번*** 밟았다:
 *   1차 `buildPtyEnv` 합성 분기만 고쳤다      ⇒ 그 분기는 하니스 경로에서 «안 돈다»
 *   2차 전파 allowlist 를 고쳤다              ⇒ 딱지가 애초에 «안 붙어» 있었다
 *   3차 실제 세우는 자리가 ***넷***이었다      ⇒ 하나씩 찾아 붙였다
 * ⇒ 🔑 ***사람이 「전부 찾았나」를 기억하는 대신 이 테스트가 «전수»를 센다.***
 *
 * ⛔ 예외를 넣고 싶으면 «이유»를 여기 적어라 — 조용히 목록에서 빼지 마라.
 */
const REPO_ROOT = resolve(import.meta.dir, '../..');

/** 자식 env 를 «만드는» 자리가 아닌 것 — 자기 프로세스에 세우거나(테스트 러너·격리 플래그) 읽기만 한다. */
const EXEMPT = new Set([
  'src/cli/test-state-dir-flag.ts',   // 자기 프로세스에 세운다(자식 env 아님)
  'src/discord-test-runner.ts',       // 테스트 러너 — 자기 프로세스
  'src/telegram-test-runner.ts',      // 테스트 러너 — 자기 프로세스
  'src/index.ts',                     // 텔레그램 테스트 진입 — 자기 프로세스
  'src/agent/identity-env.ts',        // 여기가 «딱지를 만드는» 자리다(allowlist ⊕ 자기치유)
]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) yield full;
  }
}

describe('래칫 — 자식 env 에 뿌리를 세우면 «출처»도 세운다', () => {
  test('ELANOUS_STATE_DIR 을 쓰는 파일은 ELANOUS_STATE_DIR_SOURCE 도 쓴다', () => {
    const offenders: string[] = [];
    for (const file of walk(join(REPO_ROOT, 'src'))) {
      const rel = file.slice(REPO_ROOT.length + 1);
      if (EXEMPT.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      // 「자식 env 객체에 키로 세우는」 형태만 본다 — 읽기(process.env.X)는 대상이 아니다.
      if (!/ELANOUS_STATE_DIR:\s*(?!process\.env\.)[A-Za-z_$'"`]/.test(text)) continue;
      if (!text.includes('ELANOUS_STATE_DIR_SOURCE')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('queue and immediate CLI launchers stamp the provenance of the same child root', () => {
    for (const rel of ['src/harness/harness-queue.ts', 'src/harness/harness-cli-command.ts']) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(text).toMatch(/env:\s*\{\s*\.\.\.process\.env,\s*ELANOUS_STATE_DIR:\s*root,\s*ELANOUS_STATE_DIR_SOURCE:\s*stateDirSourceForChild\(root\)/);
    }
  });

  test('scheduled queue launch passes the actual root and its source to the child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-provenance-'));
    const root = join(dir, 'state');
    const stub = join(dir, 'child.ts');
    mkdirSync(join(root, 'harness'), { recursive: true });
    writeFileSync(stub, "console.log('SOURCE ' + JSON.stringify({ root: process.env.ELANOUS_STATE_DIR, source: process.env.ELANOUS_STATE_DIR_SOURCE }));\n");
    const deps: HarnessQueueDeps = { root, launchCommand: stub, pool: () => ({ running: 0, pending: 0, reserved: 0, limit: 2 }),
      cap: () => 2, processes: () => [], authorShadow: () => {}, idleRequest: () => {}, log: () => {} };
    try {
      const row = await addHarnessQueue({ seat: 'TC', say: 'provenance probe' }, deps);
      const tick = await tickHarnessQueue(deps, row.id);
      expect(tick.outcome).toBe('launched');
      const receipt = harnessQueueReceiptPath(root, tick.item!.launchId!);
      for (let i = 0; i < 200; i++) {
        if (existsSync(receipt) && JSON.parse(readFileSync(receipt, 'utf8')).state === 'finished') break;
        await Bun.sleep(50);
      }
      expect(JSON.parse(readFileSync(receipt, 'utf8')).state).toBe('finished');
      const line = readFileSync(join(root, 'harness', `${row.id}.log`), 'utf8').split('\n').find((entry) => entry.startsWith('SOURCE '));
      expect(line).toBeDefined();
      expect(JSON.parse(line!.slice('SOURCE '.length))).toEqual({ root, source: stateDirSourceForChild(root) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  test('immediate CLI say passes the actual root and its source to the child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-provenance-'));
    const root = join(dir, 'state');
    const stub = join(dir, 'child.ts');
    mkdirSync(join(root, 'harness'), { recursive: true });
    writeFileSync(stub, "console.log('SOURCE ' + JSON.stringify({ root: process.env.ELANOUS_STATE_DIR, source: process.env.ELANOUS_STATE_DIR_SOURCE }));\n");
    const driver = join(dir, 'driver.ts');
    writeFileSync(driver, [
      `import { Command } from ${JSON.stringify(join(REPO_ROOT, 'node_modules', 'commander', 'index.js'))};`,
      `import { installHarnessCliCommand } from ${JSON.stringify(join(REPO_ROOT, 'src/harness/harness-cli-command.ts'))};`,
      `const program = new Command().exitOverride();`,
      `installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness',`,
      `  say: async () => { throw new Error('direct dispatch must not run'); },`,
      `  queue: { root: ${JSON.stringify(root)}, launchCommand: ${JSON.stringify(stub)}, authorShadow: () => {}, idleRequest: () => {},`,
      `    processes: () => [], cap: () => 4, log: () => {}, pool: () => ({ running: 0, pending: 0, reserved: 0, limit: 8 }) } });`,
      `await program.parseAsync(['node', 'elanous', 'harness', 'say', 'source probe', '--seat', 'TC', '--substrate', 'local']);`,
    ].join('\n'));
    try {
      const run = Bun.spawnSync([process.execPath, driver], { cwd: REPO_ROOT,
        env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_STATE_DIR_SOURCE: 'explicit',
          ELANOUS_HARNESS_QUEUE_DIRECT_SAY: '1', ELANOUS_HARNESS_QUEUE_LAUNCH: undefined }, stdout: 'pipe', stderr: 'pipe' });
      expect(run.stderr.toString()).toBe('');
      expect(run.exitCode).toBe(0);
      const line = run.stdout.toString().split('\n').find((entry) => entry.startsWith('SOURCE '));
      expect(line).toBeDefined();
      // The driver's own root was stamped 'explicit'; the child must inherit that same origin (not the runner's env).
      expect(JSON.parse(line!.slice('SOURCE '.length))).toEqual({ root, source: 'explicit' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);

  test('child-source resolver preserves matching origin and rejects a mismatched parent root', () => {
    const root = join(REPO_ROOT, '.elanous-test');
    const explicit = join(REPO_ROOT, 'explicit-instance');
    expect(stateDirSourceForChild(root, { ELANOUS_STATE_DIR: root, ELANOUS_STATE_DIR_SOURCE: 'explicit' })).toBe('explicit');
    expect(stateDirSourceForChild(root, { ELANOUS_STATE_DIR: explicit, ELANOUS_STATE_DIR_SOURCE: 'explicit' })).toBe('derived');
    expect(stateDirSourceForChild(explicit, { ELANOUS_STATE_DIR: root, ELANOUS_STATE_DIR_SOURCE: 'derived' })).toBe('explicit');
  });

  test('⛔ 래칫이 «아무것도 안 보고» 통과하지 않는다 — 대상 파일이 실제로 있다', () => {
    let seen = 0;
    for (const file of walk(join(REPO_ROOT, 'src'))) {
      const rel = file.slice(REPO_ROOT.length + 1);
      if (EXEMPT.has(rel)) continue;
      if (/ELANOUS_STATE_DIR:\s*(?!process\.env\.)[A-Za-z_$'"`]/.test(readFileSync(file, 'utf8'))) seen++;
    }
    // 실측 2026-08-19: seams · headless-elanous-driver · elanous-tui-spawn · pty-drive-cli
    expect(seen).toBeGreaterThanOrEqual(3);
  });
});
