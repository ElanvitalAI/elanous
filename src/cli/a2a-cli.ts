import type { Command } from 'commander';
import { createAgentCard } from '../a2a/agent-card.js';
// ⛔ `../a2a/server.js` pulls `@a2a-js/sdk` — import it lazily. `src/index.ts` registers this module on every CLI start,
//    so a static import made every elanous command fail where that dependency was not installed yet
//    (2026-09-28 05:00–05:10: the ops checkout synced the source before `bun install` · `Cannot find module '@a2a-js/sdk/server'`).
const loadServer = () => import('../a2a/server.js');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = '31490';

function parsePort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('invalid A2A port');
  }
  return port;
}

export function registerA2ACommands(program: Command): void {
  const a2a = program.command('a2a').description('A2A 에이전트 서버와 공개 카드');
  a2a.command('serve').description('A2A JSON-RPC 서버를 포그라운드에서 실행')
    .option('--host <host>', '리스닝 주소', DEFAULT_HOST)
    .option('--port <port>', '리스닝 포트', DEFAULT_PORT)
    .option('--public-url <url>', '외부에 공개할 /a2a RPC URL')
    .requiredOption('--tool-cwd <directory>', '도구 실행용 절대 작업 디렉터리')
    .action(async (opts: { host: string; port: string; publicUrl?: string; toolCwd: string }) => {
      const { startA2AServer } = await loadServer();
      const server = startA2AServer({ host: opts.host, port: parsePort(opts.port), publicUrl: opts.publicUrl, toolCwd: opts.toolCwd });
      console.log(`a2a listening ${new URL(server.url).host}`);
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
  a2a.command('card').description('A2A 카드 JSON과 Gemini 원격 에이전트 설정 예시 출력')
    .option('--host <host>', '카드에 사용할 주소', DEFAULT_HOST)
    .option('--port <port>', '카드에 사용할 포트', DEFAULT_PORT)
    .option('--public-url <url>', '외부에 공개할 /a2a RPC URL')
    .action(async (opts: { host: string; port: string; publicUrl?: string }) => {
      const { advertisedRpcUrl } = await loadServer();
      const rpcUrl = advertisedRpcUrl(opts.publicUrl, opts.host, parsePort(opts.port));
      const agentCardUrl = new URL('/.well-known/agent-card.json', rpcUrl).href;
      console.log(JSON.stringify(createAgentCard(rpcUrl), null, 2));
      console.log(`gemini:\n${JSON.stringify({ kind: 'remote', agent_card_url: agentCardUrl }, null, 2)}`);
    });
}
