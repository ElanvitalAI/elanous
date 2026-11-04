import { lstatSync, readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { configureLogFederation, disconnectLogFederation, readLogFederationStatus } from '../mss/logging/log-federation.js';

export function registerLogFederationCommands(logs: Command): void {
  const federation = logs.command('federate').description('옵트인 원격 로그 연합 설정·상태·철회');
  federation.command('connect <instance> <hq-url> <token-file>')
    .description('명시 동의 후 원격 logs.db 를 HQ 로 주기 전송 (HQ에서 발급한 mode 0600 제한 토큰 파일 필요)')
    .option('--consent', '이 설치본의 로그를 지정한 HQ에 보내는 데 동의')
    .action((instance: string, endpoint: string, tokenFile: string, opts: { consent?: boolean }) => {
      try {
        const stat = lstatSync(tokenFile);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('token file must be a private regular file (mode 0600)');
        configureLogFederation({ instance, endpoint, token: readFileSync(tokenFile, 'utf8'), consent: opts.consent === true });
        process.stdout.write(`log federation enabled: ${instance} → ${new URL(endpoint).origin} (consent recorded)\n`);
      } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    });
  federation.command('status').description('현재 연합 전송 설정 (토큰은 표시하지 않음)').option('--json').action((opts: { json?: boolean }) => {
    const status = readLogFederationStatus();
    if (opts.json) process.stdout.write(`${JSON.stringify(status ?? { enabled: false })}\n`);
    else process.stdout.write(status ? `${status.enabled ? 'enabled' : 'paused/revoke-pending'} · ${status.instance} → ${status.endpoint} · afterId=${status.afterId}\n` : 'disabled\n');
  });
  federation.command('disconnect').description('HQ에서 이 토큰을 철회하고 로컬 전송을 중지').action(async () => {
    try {
      const instance = await disconnectLogFederation();
      process.stdout.write(instance ? `revoked and disconnected: ${instance}\n` : 'log federation already disabled\n');
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  });
}
