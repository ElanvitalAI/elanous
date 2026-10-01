import { describe, expect, test } from 'bun:test';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { autoApproveConfirmChannel, assertThrowawayTarget, formatHarnessDogfoodReport, HARNESS_DOGFOOD_DEPRECATION_NOTICE, HARNESS_DOGFOOD_REPLACEMENT_FROM_GOAL_FILE, HARNESS_DOGFOOD_REPLACEMENT_FROM_SENTENCE, HARNESS_DOGFOOD_REPLACEMENT, refuseHarnessDogfoodCli, runHarnessDogfood } from './dogfood.js';

const THROWAWAY = join(tmpdir(), 'dogfood-target');   // 시스템 temp 하위 = 허용

describe('harness dogfood adapter', () => {
  test('uses an explicit always-yes confirmation channel', async () => {
    const channel = autoApproveConfirmChannel();
    expect(channel.name).toBe('harness-dogfood-auto-approve');
    expect(await channel.request({ prompt: 'apply staged change?' })).toBe(true);
  });

  test('delegates the full lifecycle to RunDevHarness with auto_drive on and reports target observability', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    let receivedCtx: { surfaceHitlChannels?: Array<{ request: (request: { prompt: string }) => Promise<boolean | null> }> } | undefined;
    const result = await runHarnessDogfood({
      target: THROWAWAY,
      objective: 'update the isolated target',
      configDir: join(tmpdir(), 'isolated-elanous'),
      dispatch: async (args, ctx) => {
        receivedArgs = args;
        receivedCtx = ctx as typeof receivedCtx;
        return { output: 'RunDevHarness ✅ 실위치 적용 완료 — 백업: /tmp/backup' };
      },
    });

    expect(receivedArgs).toEqual({
      target: THROWAWAY,
      objective: 'update the isolated target',
      auto_drive: 'on',
    });
    expect(await receivedCtx?.surfaceHitlChannels?.[0]?.request({ prompt: 'confirm' })).toBe(true);
    expect(result.observability).toEqual(['harness.target:dogfood.start', 'harness.target:dogfood.done']);

    const report = formatHarnessDogfoodReport(result);
    expect(report).toContain('| auto_drive | on |');
    expect(report).toContain('harness.target:dogfood.start');
    expect(report).toContain('실위치 적용 완료');
  });

  test('rejects missing target or objective before dispatch', async () => {
    await expect(runHarnessDogfood({ target: '', objective: 'x', dispatch: async () => ({ output: 'unexpected' }) }))
      .rejects.toThrow('target required');
    await expect(runHarnessDogfood({ target: THROWAWAY, objective: '', dispatch: async () => ({ output: 'unexpected' }) }))
      .rejects.toThrow('objective required');
  });
});

describe('assertThrowawayTarget — C 안전 가드(auto-approve 우회 방지)', () => {
  test('시스템 temp 하위 → 허용(throw 안 함)', () => {
    expect(() => assertThrowawayTarget(join(tmpdir(), 'x/y'))).not.toThrow();
    expect(() => assertThrowawayTarget(tmpdir())).not.toThrow();
  });

  test('★ 실경로(홈·repo·시스템) → refuse with current CLI guidance', () => {
    const refused = () => assertThrowawayTarget(homedir());
    expect(refused).toThrow('throwaway');
    expect(refused).toThrow('CLI path');
    expect(refused).toThrow('tools.runDevHarness.modelSurface');
    expect(refused).not.toThrow('use RunDevHarness');
    expect(() => assertThrowawayTarget(join(homedir(), 'source/repo'))).toThrow('throwaway');
    expect(() => assertThrowawayTarget('/etc/zshrc')).toThrow('throwaway');
    expect(() => assertThrowawayTarget(process.cwd())).toThrow('throwaway');
  });

  test('접두 오탐 방지 — `<tmp>-evil` 은 refuse(하위 아님)', () => {
    expect(() => assertThrowawayTarget(`${tmpdir()}-evil/x`)).toThrow('throwaway');
  });

  test('runHarnessDogfood 도 실경로 target 을 current CLI guidance와 함께 refuse', async () => {
    const refuse = () => runHarnessDogfood({ target: homedir(), objective: 'x', dispatch: async () => ({ output: 'unexpected' }) });
    await expect(refuse()).rejects.toThrow('throwaway');
    await expect(refuse()).rejects.toThrow('CLI path');
    await expect(refuse()).rejects.toThrow('tools.runDevHarness.modelSurface');
  });
});

describe('harness dogfood CLI entrance — refuse, do not dispatch', () => {
  test('names the existing replacement and ends non-zero without calling the adapter', () => {
    expect(HARNESS_DOGFOOD_REPLACEMENT).toBe('elanous harness ask <골문서>');
    const notices: string[] = [];
    const outcome = refuseHarnessDogfoodCli({ onDeprecationNotice: (notice) => notices.push(notice) });
    expect(outcome).toEqual({ ok: false, message: HARNESS_DOGFOOD_DEPRECATION_NOTICE, exitCode: 1 });
    expect(outcome.exitCode).not.toBe(0);
    expect(notices).toEqual([
      '[ask] ⚠️ 이 발사 입구는 은퇴했다: cli-harness-dogfood',
      HARNESS_DOGFOOD_DEPRECATION_NOTICE,
    ]);
    expect(HARNESS_DOGFOOD_DEPRECATION_NOTICE).toContain(HARNESS_DOGFOOD_REPLACEMENT);
  });

  // ⭐ 2026-09-02 · 🅣 136차 — 옛 문은 «문장»(`dogfood <target> <objective...>`)을 받았는데
  //   안내가 «골 문서»만 가리켰다 ⇒ 문장을 든 사람에게 갈 곳이 없었다. 두 갈래를 «둘 다» 문다.
  //   ⛔ 이 시험이 못 보는 것: 저 두 명령이 «실제로 도는지»는 안 잰다(문면 계약만).
  test('the notice routes both input kinds — a sentence and an already-authored goal file', () => {
    expect(HARNESS_DOGFOOD_REPLACEMENT_FROM_SENTENCE).toContain('harness say');
    expect(HARNESS_DOGFOOD_REPLACEMENT_FROM_GOAL_FILE).toContain('harness ask');
    expect(HARNESS_DOGFOOD_DEPRECATION_NOTICE).toContain(HARNESS_DOGFOOD_REPLACEMENT_FROM_SENTENCE);
    expect(HARNESS_DOGFOOD_DEPRECATION_NOTICE).toContain(HARNESS_DOGFOOD_REPLACEMENT_FROM_GOAL_FILE);
  });

  test('retired harness dogfood command emits the new destination and exits non-zero', () => {
    const cli = join(import.meta.dir, '../../bin/elanous.mjs');
    const result = spawnSync('bun', [cli, '--test', 'harness', 'dogfood', join(tmpdir(), 'throwaway'), 'objective'], {
      cwd: join(import.meta.dir, '../..'), encoding: 'utf8', timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('elanous harness ask <골문서>');
  }, 35_000);
});
