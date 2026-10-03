import type { Command } from 'commander';
import { startHookReceiver } from '../hooks/receiver.js';
import { HookQueue } from '../hooks/queue.js';
import { closeIngressAndExposure, hookExposurePlan, hookExposureStatus, startPublicHookIngress, turnHookExposureOff, turnHookExposureOn, type HookExposureDeps } from '../hooks/expose.js';
import { getSecretAsync, setSecretAsync } from '../nexus/config/secrets/index.js';
import { getUserConfig } from '../user-config.js';

export function asanaEnabled(raw: unknown = getUserConfig().raw): boolean {
  const tox = (raw as { tox?: { external?: { asana?: { enabled?: unknown } } } } | undefined)?.tox;
  return tox?.external?.asana?.enabled === true;
}

export function registerHooksCommands(program: Command, exposureDeps: HookExposureDeps = {}): void {
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
        github: await getSecretAsync('hooks.github'),
        // 첫 핸드셰이크의 비밀을 저장하는 것은 «먼저 온 사람이 이긴다» — Asana 를 켠 설치에서만 연다.
        ...(asanaEnabled() ? { saveAsana: (value: string) => setSecretAsync('hooks.asana', value) } : {}),
      };
      const server = startHookReceiver({ host: opts.host, port, secrets });
      let ingress: ReturnType<typeof startPublicHookIngress> | undefined;
      try { if (opts.host === '127.0.0.1' && port === 31480) ingress = startPublicHookIngress(server.url); }
      catch (error) { server.stop(); throw error; }
      console.log(`hooks listening ${new URL(server.url).host}`);
      await new Promise<void>(resolve => {
        const stop = () => {
          process.removeListener('SIGINT', stop);
          process.removeListener('SIGTERM', stop);
          void closeIngressAndExposure(ingress, exposureDeps).finally(() => { server.stop(); resolve(); });
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });
  const expose = hooks.command('expose').description('결정 원장에 묶인 웹훅 공개 진입');
  expose.command('plan').description('공개 경로와 tailscale 명령만 표시').action(() => console.log(JSON.stringify(hookExposurePlan())));
  expose.command('on').description('결정 뒤 공개 진입 켜기').option('--decision <D-id>')
    .action(async (opts: { decision?: string }) => console.log(JSON.stringify(await turnHookExposureOn(opts.decision, exposureDeps))));
  expose.command('off').description('이 도구가 켠 공개 진입 끄기(결정 불필요)').option('--force', '기록·대상 확인 없이 8443 Funnel 을 끈다')
    .action(async (opts: { force?: boolean }) => {
      const result = await turnHookExposureOff(exposureDeps, { force: opts.force });
      console.log(result.changed ? `hooks exposure off (${result.reason})` : 'hooks exposure: nothing of ours to turn off (8443 Funnel is not recorded and does not target the hook ingress; --force to turn it off anyway)');
    });
  expose.command('status').description('기록된 공개 경로·결정·시각').action(() => console.log(JSON.stringify(hookExposureStatus(exposureDeps))));
  hooks.command('status').description('대기 중인 웹훅 수와 마지막 전달 시각')
    .action(() => {
      const queue = new HookQueue();
      console.log(JSON.stringify({ queued: queue.count(), lastDelivered: queue.lastDelivered() }));
    });
}
