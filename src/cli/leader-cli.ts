// Retired command: preserve an actionable diagnostic without granting source-tree authority.
import type { Command } from 'commander';

export interface LeaderCliDeps {
  out?: { log: (s: string) => void; error: (s: string) => void };
}

export function registerLeaderCommands(program: Command, deps: LeaderCliDeps = {}): void {
  const out = deps.out ?? { log: (s: string) => console.log(s), error: (s: string) => console.error(s) };
  const message = '리더 트리 지정은 폐기되었습니다. 운영 명령은 전역 elanous 로 실행하세요.';
  const cmd = program.command('leader').description('은퇴한 리더 트리 명령');
  cmd.command('status', { isDefault: true })
    .description('리더 권위 폐기 안내 (READ-ONLY)')
    .option('--json', 'JSON 출력')
    .action((o: { json?: boolean }) => out.log(o.json ? JSON.stringify({ retired: true, message }) : message));
  cmd.command('claim')
    .description('은퇴한 리더 승격 명령')
    .option('--yes', 'legacy option (ignored)')
    .option('--reason <text>', 'legacy option (ignored)')
    .action(() => out.error(message));
}
