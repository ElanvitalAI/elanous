// ── `eln seat say <자리> --from <자리> "…"` — OP→자리 지시 한 줄 (ELN-SEAT-SAY · A217) ──
//
// 우편 post ⊕ 깨움을 한 줄로. 새 경로는 없다: 같은 `eln msg post` 를 부른다(검사·원장·우체국·깨움·관측 그대로).
// 기본 intent = request 이므로 A217 요청 계약(--due · --done)이 필수다. 받는 쪽 Next TUI 는 그 우편으로 연 턴을
// «⇢ OP · request · due HH:MM · #id» 로 그린다(사람 입력처럼 보이지 않는다). 보낸 쪽은 영수증으로 따라간다.
import { Command } from 'commander';

export interface SeatSayDeps {
  /** Runs `msg post` with these argv words and returns its exit code (0 = stored; default: a fresh `eln msg` command tree). */
  post?: (argv: string[]) => Promise<number>;
  out?: Pick<Console, 'log' | 'error'>;
}

async function defaultPost(argv: string[]): Promise<number> {
  const { registerMsgCommands } = require('./msg-cli.js') as typeof import('./msg-cli.js');
  const cli = new Command();
  let rc = 0;
  // The post's own result (#38249 REVIEW-1 ①) — not the process-wide exitCode, which something else may have set.
  registerMsgCommands(cli, { setExitCode: (code) => { rc = code; process.exitCode = code; } });
  await cli.parseAsync(['msg', 'post', ...argv], { from: 'user' });
  return rc;
}

/** argv for `msg post` — exported for the test (the words are the whole contract). */
export function seatSayPostArgv(target: string, text: string, opts: { from: string; intent?: string; due?: string; done?: string; json?: boolean }): string[] {
  return [
    '--from', opts.from, '--to', target, '--intent', opts.intent ?? 'request',
    ...(opts.due === undefined ? [] : ['--deadline', opts.due]),
    ...(opts.done === undefined ? [] : ['--done', opts.done]),
    ...(opts.json ? ['--json'] : []),
    '--body', text,
  ];
}

export function registerSeatSayCommand(seat: Command, deps: SeatSayDeps = {}): void {
  const out = deps.out ?? console;
  seat.command('say <seat> <text>')
    .description('Tell a seat something as a structured agent message (post ⊕ wake) — shown as «⇢ FROM · intent · due», never as typed input')
    .requiredOption('--from <seat>', 'the sending seat (e.g. OP)')
    .option('--intent <kind>', 'request (default) | decision | info | alert')
    .option('--due <due>', 'request due: HH:MM · +<n>m|h · ISO-8601 (required for request)')
    .option('--done <condition>', 'what «done» means (required for request)')
    .option('--json')
    .action(async (target: string, text: string, opts: { from: string; intent?: string; due?: string; done?: string; json?: boolean }) => {
      const rc = await (deps.post ?? defaultPost)(seatSayPostArgv(target, text, opts));
      // Only a stored message has receipts to follow; a refused post (rc ≠ 0) prints nothing more.
      if (!opts.json && rc === 0) out.log(`follow: eln msg receipts --from ${opts.from} --follow --until seen`);
    });
}
