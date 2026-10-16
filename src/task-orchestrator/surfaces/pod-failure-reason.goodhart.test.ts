import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyPodExit, podTerminalRow } from './pod-failure-reason.js';

/**
 * GOODHART 방어 — 주입한 결과 행이 아니라 «실제 진입점» 이 만든 거절로 원장 행을 검사한다.
 *
 * `bin/elanous.mjs --test harness ask <ask 문서> --json` 를 실제 프로세스로 띄운다(self-implement Pod 자식이
 * 쓰는 것과 같은 진입점). 프리로드는 LLM 골 저작자(goal-author-cli)만 가짜로 바꾼다 — 발사 흐름,
 * decideAskPreflight, 그리고 마지막 JSON 결과 행 방출은 전부 실제 코드가 한다. 거절은 저작된 골 문서의
 * TRACED PATHS 가 실재하지 않는 경로를 가리켜 «실제로» 발생한다.
 */
describe('GOODHART: 실제 --json 진입점의 프리플라이트 거절 → 원장 행', () => {
  test('harness ask --json 거절이 중첩 자식 결과 행을 남기고 원장은 사유 코드·검사 이름·잘리지 않은 경로를 보존한다', () => {
    const dir = mkdtempSync(join(import.meta.dir, '.goodhart-tmp-'));
    try {
      const askPath = join(dir, 'ask.md');
      writeFileSync(askPath, '원장 증명용 ask — 저작된 골이 실재하지 않는 traced path 를 대상으로 선언한다.\n');

      // 240자를 훌쩍 넘는 경로 — 원장의 error 텍스트는 240자에서 잘리지만 targetPath 구조 필드는 온전해야 한다.
      const missingPath = join(dir, 'x'.repeat(90), 'y'.repeat(90), 'z'.repeat(90), 'missing-evidence.md');
      expect(missingPath.length).toBeGreaterThan(240);

      const goalPath = join(dir, 'GOAL-goodhart.md');
      const goalDocument = `# 원장 증명 골\n\n## TRACED PATHS\n\n- ${missingPath}\n`;

      const goalAuthorModule = new URL('../../self-implement/goal-author-cli.ts', import.meta.url).pathname;
      const preload = join(dir, 'preload.ts');
      writeFileSync(preload, [
        "import { mock } from 'bun:test';",
        `const goalAuthorModule = ${JSON.stringify(goalAuthorModule)};`,
        'const original = await import(goalAuthorModule);',
        "const { writeFileSync } = await import('node:fs');",
        'mock.module(goalAuthorModule, () => ({',
        '  ...original,',
        `  runGoalAuthorCli: async () => { writeFileSync(${JSON.stringify(goalPath)}, ${JSON.stringify(goalDocument)}); return { path: ${JSON.stringify(goalPath)}, authored: { document: ${JSON.stringify(goalDocument)} } }; },`,
        '}));',
        '',
      ].join('\n'));

      const bin = new URL('../../../bin/elanous.mjs', import.meta.url).pathname;
      const run = spawnSync(
        process.execPath,
        ['--preload', preload, bin, '--test', 'harness', 'ask', askPath, '--json', '--no-queue'],
        { encoding: 'utf8', timeout: 180_000 },
      );

      // ⛔ 거절된 harness ask 는 exit(1) 로 죽는다 — 방출은 stdout 의 마지막 JSON 행으로 확인한다.
      expect(run.status).toBe(1);

      const emitted = (run.stdout ?? '').split('\n').filter((line) => line.trim().length > 0).at(-1);
      expect(emitted).toBeDefined();
      const row = JSON.parse(emitted!) as { ok: boolean; kind: string; result: { stage: string; ok: boolean; blockers: Array<{ reasonCode?: string; checkName?: string; targetPath?: string }> } };
      // 실제 자식 결과의 «중첩» 봉투 — {ok, kind, result:{stage, …}} — must-fix #1 의 그 형식이다.
      expect(row.ok).toBe(false);
      expect(row.kind).toBe('self');
      expect(row.result.stage).toBe('preflight-blocked');
      expect(row.result.ok).toBe(false);
      const blocker = row.result.blockers.find((candidate) => candidate.reasonCode === 'missing-traced-path');
      expect(blocker).toBeDefined();
      expect(blocker!.checkName).toBe('missing');
      expect(blocker!.targetPath).toBe(missingPath);

      // 원장 행 — 주입이 아니라 «실제 방출 행» 을 실제 분류기에 통과시켜 생성한다.
      const terminal = podTerminalRow(row);
      expect(terminal).toMatchObject({ stage: 'preflight-blocked', ok: false, reasonCode: 'missing-traced-path', checkName: 'missing', targetPath: missingPath });

      const ledger = classifyPodExit({ logs: run.stdout ?? '' });
      expect(ledger.class).toBe('child-unconverged');
      expect(ledger.reasonCode).toBe('missing-traced-path');
      expect(ledger.checkName).toBe('missing');
      expect(ledger.targetPath).toBe(missingPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
