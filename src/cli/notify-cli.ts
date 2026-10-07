import type { Command } from 'commander';
import { inQuietHours, sendOutbound, userRecentlyActive } from '../domains/outbound-alert.js';
import { isTradingKind } from '../domains/telegram-kind-route.js';

export type NotifyPlan = { ok: true; kind: string } | { ok: false; exitCode: 2; message: string };

export function planNotify({ kind = 'op-report', text }: { kind?: string; text: string }): NotifyPlan {
  if (isTradingKind(kind)) {
    return { ok: false, exitCode: 2, message: `매매 kind(${kind})는 운영 보고에 쓸 수 없습니다 — op-report 또는 ops-alert 를 쓰세요` };
  }
  if (!kind.trim() || /[\r\n]/.test(kind)) {
    return { ok: false, exitCode: 2, message: 'kind 가 비었거나 줄바꿈을 포함합니다 — op-report 또는 ops-alert 를 쓰세요' };
  }
  if (!text.trim()) return { ok: false, exitCode: 2, message: '본문이 비었습니다 — elanous notify <text...> 또는 --stdin' };
  return { ok: true, kind };
}

export interface NotifyCliDeps {
  send?: (text: string, kind: string) => boolean | Promise<boolean>;
  quiet?: () => boolean;
  readStdin?: () => Promise<string>;
  output?: (line: string) => void;
  error?: (line: string) => void;
  setExitCode?: (code: number) => void;
}

export function registerNotifyCommand(program: Command, deps: NotifyCliDeps = {}): void {
  const send = deps.send ?? sendOutbound;
  const quiet = deps.quiet ?? (() => inQuietHours() && !userRecentlyActive());
  const readStdin = deps.readStdin ?? (async () => {
    if (process.stdin.isTTY) throw new Error('--stdin requires redirected input');
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  });
  const output = deps.output ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });

  program.command('notify [text...]')
    .description('대표에게 운영 보고를 발송한다 (기본 kind: op-report)')
    .option('--kind <kind>', '운영 알림 kind (매매 report|alert|digest 거부)')
    .option('--stdin', '본문을 표준 입력에서 읽는다')
    .option('--json', '결과를 JSON 한 줄로 출력한다')
    .action(async (parts: string[], opts: { kind?: string; stdin?: boolean; json?: boolean }) => {
      const kind = opts.kind ?? 'op-report';
      if (opts.stdin && parts.length) {
        if (opts.json) output(JSON.stringify({ ok: false, kind, chars: 0, deferred: false }));
        else error('--stdin 과 본문 인자는 함께 쓸 수 없습니다');
        setExitCode(2);
        return;
      }
      try {
        const text = opts.stdin ? await readStdin() : parts.join(' ');
        const plan = planNotify({ kind, text });
        if (!plan.ok) {
          if (opts.json) output(JSON.stringify({ ok: false, kind, chars: [...text].length, deferred: false }));
          else error(plan.message);
          setExitCode(plan.exitCode);
          return;
        }
        const deferred = quiet();
        const ok = await send(text, plan.kind);
        const chars = [...text].length;
        if (opts.json) output(JSON.stringify({ ok, kind: plan.kind, chars, deferred: ok && deferred }));
        else if (ok) output(`${deferred ? '보류됨' : '보냄'}(${plan.kind}) · ${chars}자`);
        else error(`못 보냄(${plan.kind}) — elanous logs --category outbound.send 로 확인`);
        setExitCode(ok ? 0 : 1);
      } catch {
        if (opts.json) output(JSON.stringify({ ok: false, kind, chars: 0, deferred: false }));
        else error(`못 보냄(${kind}) — elanous logs --category outbound.send 로 확인`);
        setExitCode(1);
      }
    });
}
