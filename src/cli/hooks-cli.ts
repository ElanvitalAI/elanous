import type { Command } from 'commander';
import { startHookReceiver } from '../hooks/receiver.js';
import { HookQueue } from '../hooks/queue.js';
import { getSecretAsync, setSecretAsync } from '../nexus/config/secrets/index.js';
import { getUserConfig } from '../user-config.js';

export function asanaEnabled(raw: unknown = getUserConfig().raw): boolean {
  const tox = (raw as { tox?: { external?: { asana?: { enabled?: unknown } } } } | undefined)?.tox;
  return tox?.external?.asana?.enabled === true;
}

export function registerHooksCommands(program: Command): void {
  const hooks = program.command('hooks').description('외부 웹훅 수신·재전송');
  hooks.command('serve').description('웹훅 수신기를 포그라운드에서 실행')
    .option('--host <host>', '리스닝 주소', '127.0.0.1')
    .option('--port <port>', '리스닝 포트', '31480')
    .action(async (opts: { host: string; port: string }) => {
      const port = Number(opts.port);
      if (!/^\d+$/.test(opts.port) || !Number.isSafeInteger(port) || port < 1 || port > 65535)
        throw new Error('invalid hooks port');
      const secrets = {
        linear: await getSecretAsync('hooks.linear'), asana: await getSecretAsync('hooks.asana'),
        // 첫 핸드셰이크의 비밀을 저장하는 것은 «먼저 온 사람이 이긴다» — Asana 를 켠 설치에서만 연다.
        ...(asanaEnabled() ? { saveAsana: (value: string) => setSecretAsync('hooks.asana', value) } : {}),
      };
      const server = startHookReceiver({ host: opts.host, port, secrets });
      console.log(`hooks listening ${new URL(server.url).host}`);
      await new Promise<void>(resolve => {
        const stop = () => {
          process.removeListener('SIGINT', stop);
          process.removeListener('SIGTERM', stop);
          server.stop();
          resolve();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });
  hooks.command('status').description('대기 중인 웹훅 수와 마지막 전달 시각')
    .action(() => {
      const queue = new HookQueue();
      console.log(JSON.stringify({ queued: queue.count(), lastDelivered: queue.lastDelivered() }));
    });
}
