import type { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { captureAgentEnv } from '../agent-env/profile.js';

export function registerAgentEnvCommands(program: Command): void {
  const agentEnv = program.command('agent-env').description('에이전트 CLI 환경의 비밀 없는 프로필');
  agentEnv.command('capture').description('로컬 Claude · Codex · Grok 설정을 읽기 전용으로 캡처')
    .option('--agent <agent>', 'claude|codex|grok')
    .option('--out <file>', '프로필을 저장할 파일')
    .option('--json', 'JSON 출력')
    .action((opts: { agent?: string; out?: string; json?: boolean }) => {
      if (opts.agent && !['claude', 'codex', 'grok'].includes(opts.agent)) {
        throw new Error('--agent must be claude, codex or grok');
      }
      const profile = captureAgentEnv({ agent: opts.agent as 'claude' | 'codex' | 'grok' | undefined });
      const text = JSON.stringify(profile, null, 2) + '\n';
      if (opts.out) writeFileSync(opts.out, text, { encoding: 'utf8', mode: 0o600 });
      if (opts.json || !opts.out) process.stdout.write(text);
      else console.log(`agent-env capture · ${opts.out}`);
    });
}
