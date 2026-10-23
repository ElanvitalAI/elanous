import type { Command } from 'commander';

import { CliUserError } from './cli-user-error.js';
import { herdrPrompt, type HerdrPromptDeps } from '../pty-shell/herdr-prompt.js';

/**
 * `eln herdr prompt <대상> <문장> [--wait] [--timeout MS]` — herdr pane 의 elanous TUI 에 한 턴을 넣는다.
 * herdr `agent prompt` 는 custom 신고 agent 를 거부하므로(herdr-prompt.ts 머리말) 같은 의미를 여기서 낸다.
 * 출력 = 결과 JSON 한 줄(stdout) · 성공 rc0 · 실패 rc1 · 인자 오류 rc2(CliUserError).
 */
export function registerHerdrCommands(program: Command, deps: HerdrPromptDeps = {}): void {
  const herdr = program.command('herdr').description('herdr 연동 — herdr pane 의 elanous TUI 를 밖에서 다룬다');
  herdr.command('prompt <target> <text>')
    .description('herdr pane 의 elanous TUI 에 문장 하나를 턴으로 넣는다(herdr agent prompt 의 elanous 판)')
    .option('--wait', '제출 뒤 working 관측 → idle/done/blocked 정착까지 기다린다')
    .option('--timeout <ms>', '호출자 timeout(제출 포함 · ms)')
    .action(async (target: string, text: string, opts: { wait?: boolean; timeout?: string }) => {
      let timeoutMs: number | undefined;
      if (opts.timeout !== undefined) {
        const n = Number(opts.timeout);
        if (!/^\d+$/.test(opts.timeout.trim()) || !Number.isSafeInteger(n) || n <= 0) {
          throw new CliUserError(`잘못된 --timeout: ${opts.timeout}`, '1 이상의 정수 ms');
        }
        timeoutMs = n;
      }
      // 한 번 도는 CLI 는 debug.log 를 logs.db 에 잇는 싱크가 없다 — `pty.herdr prompt` 관측이 조회되게 연다(fail-soft).
      if (deps.log === undefined) {
        try { await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('herdr'); } catch { /* 관측은 fail-soft */ }
      }
      const result = await herdrPrompt({ target, text, wait: opts.wait === true, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, deps);
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    });
}
