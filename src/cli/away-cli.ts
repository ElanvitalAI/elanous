import type { Command } from 'commander';
import { readPresence, writePresence, type Presence } from '../away/presence.js';
import { releaseNowText, releaseWatchTick, type TickDeps, type TickOutcome } from '../away/release-watch.js';
import { sendOutbound } from '../domains/outbound-alert.js';
import { readReleaseRuns } from '../nexus/api/ops-api.js';

export interface AwayCliDeps {
  read?: () => Presence;
  write?: (away: boolean, by: string) => Presence;
  tick?: (deps?: TickDeps) => TickOutcome;
  now?: () => string;
  send?: (text: string) => boolean;
  output?: (line: string) => void;
  setExitCode?: (code: number) => void;
}

/** AWAY-MODE-1 — `elanous away on|off|status|tick`. 켜고 끄는 순간 텔레그램에 한 줄을 보내 «받는 길이 산다»를 바로 본다. */
export function registerAwayCommand(program: Command, deps: AwayCliDeps = {}): void {
  const read = deps.read ?? (() => readPresence());
  const write = deps.write ?? ((away: boolean, by: string) => writePresence(away, by));
  const tick = deps.tick ?? releaseWatchTick;
  const now = deps.now ?? (() => releaseNowText(readReleaseRuns(null, undefined, { facts: true })));
  const send = deps.send ?? ((text: string) => sendOutbound(text, 'op-report'));
  const output = deps.output ?? ((line: string) => console.log(line));
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });

  const away = program.command('away').description('외출 모드 — 켜면 발행 현황을 텔레그램으로 따라간다(노드 전이 · 막힘 즉시 · 60분 생존 줄)');

  away.command('on')
    .description('외출 모드 켜기 — 지금 발행 현황 한 통을 보내고 그 뒤 전이를 따라간다')
    .action(() => {
      write(true, 'cli');
      const ok = send(`🚶 외출 모드 켬 — 발행 현황을 여기로 보낸다(끄기: /away off)\n${now()}`);
      const result = tick();
      output(`외출 모드 켬 · 확인 한 통 ${ok ? '보냄' : '못 보냄'} · 첫 확인 ${result.outcome}`);
      if (!ok) output('⚠️ 텔레그램 발송 실패 — elanous logs --category outbound.send 로 확인');
      setExitCode(ok ? 0 : 1);
    });

  away.command('off')
    .description('외출 모드 끄기')
    .action(() => {
      write(false, 'cli');
      tick();
      const ok = send('🏠 외출 모드 끔 — 발행 알림은 평소대로');
      output(`외출 모드 끔 · 확인 한 통 ${ok ? '보냄' : '못 보냄'}`);
      setExitCode(ok ? 0 : 1);
    });

  away.command('status')
    .description('지금 외출 모드인가 ⊕ 발행 현황')
    .option('--json', 'JSON 한 줄')
    .action((opts: { json?: boolean }) => {
      const presence = read();
      if (opts.json) { output(JSON.stringify(presence)); return; }
      output(`${presence.away ? '🚶 외출 중' : '🏠 자리에 있음'}${presence.since ? ` · ${presence.since}` : ''}${presence.by ? ` · ${presence.by}` : ''}`);
      output(now());
    });

  away.command('tick')
    .description('발행 현황을 한 번 보고 새 전이만 보낸다(주기 실행용 · 자리에 있으면 아무것도 안 함)')
    .option('--json', 'JSON 한 줄')
    .action((opts: { json?: boolean }) => {
      const result = tick();
      output(opts.json ? JSON.stringify(result) : `away tick: ${result.outcome}`);
      setExitCode(result.outcome === 'send-failed' || result.outcome === 'unavailable' ? 1 : 0);
    });
}
