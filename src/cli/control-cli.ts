import { join } from 'node:path';
import type { Command } from 'commander';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { DEFAULT_CONTROL_PORT, ensureControlTokens, startControlServer } from '../control-plane/server.js';
import { resolvePrimary, writePrimaryJoin } from '../control-plane/primary.js';
import type { ResourceView } from '../control-plane/ledger.js';
import { issueMemberToken, revokeMemberToken, listMemberTokens } from '../control-plane/member-tokens.js';

function controlPort(flag?: string): number {
  const raw = flag ?? (process.env.ELANOUS_CONTROL_PORT?.trim() || undefined);
  const port = raw === undefined ? DEFAULT_CONTROL_PORT : Number(raw);
  if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`관제부 포트가 유효하지 않음: ${JSON.stringify(raw)}`);
  }
  return port;
}

function reasonFor(error: unknown, token?: string): string {
  const message = error instanceof Error
    ? (error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message)
    : String(error);
  return token ? message.replaceAll(token, '[redacted]') : message;
}

export async function runResourcesQuery(options: { where?: string; kind?: string; port?: string; primaryUrl?: string; queryToken?: string; json?: boolean }): Promise<number> {
  let base = '';
  let token: string | undefined;
  try {
    const portOverride = options.port ?? (process.env.ELANOUS_CONTROL_PORT?.trim() || undefined);
    const primary = resolvePrimary({ role: 'query', config: { url: options.primaryUrl, tokens: options.queryToken ? { query: options.queryToken } : undefined }, ...(portOverride !== undefined ? { port: Number(portOverride) } : {}) });
    base = primary.url;
    token = primary.token ?? (primary.source === 'local' ? ensureControlTokens().query : undefined);
    if (!token) throw new Error('관제부 query 토큰 없음');
    const url = new URL('/v1/resources', base);
    if (options.kind !== undefined) url.searchParams.set('kind', options.kind);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    // Never render peer-controlled status text: it can echo the Authorization header.
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('resources' in body) || !Array.isArray(body.resources)) {
      throw new Error('잘못된 자원 응답(resources 배열 없음)');
    }
    const rows = body.resources as ResourceView[];
    const selected = options.where === undefined ? rows : rows.filter(row => row.name === options.where || row.kind === options.where);
    if (options.json) console.log(JSON.stringify({ resources: selected }).replaceAll(token, '[redacted]'));
    else for (const row of selected) console.log(`${row.kind} · ${row.name} · ${row.machine} · ${row.endpoint ?? '-'} · ${row.ageMs}ms · ${row.expired}`.replaceAll(token, '[redacted]'));
    return 0;
  } catch (error) {
    console.error(`관제부에 닿지 못함(${base}/v1/resources · ${reasonFor(error, token)})`);
    return 2;
  }
}

export async function runControlServe(options: { port?: string; host?: string }): Promise<void> {
  let port: number;
  try { port = controlPort(options.port); }
  catch (error) { console.error(reasonFor(error)); process.exitCode = 2; return; }
  let server: ReturnType<typeof startControlServer>;
  try { server = startControlServer({ port, hostname: options.host }); }
  catch (error) { console.error(`관제부 시작 실패: ${reasonFor(error)}`); process.exitCode = 2; return; }
  await new Promise<void>(resolve => {
    const stop = () => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      server.stop();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    console.log(`관제부 ${new URL(server.url).host} · 토큰 ${join(effectiveInstanceRoot(), 'control', 'tokens.json')}`);
  });
}

export function registerControlCommands(program: Command): void {
  const control = program.command('control').description('독립 관제부');
  control.command('serve').description('관제부를 포그라운드에서 실행')
    .option('--port <n>', '리스닝 포트(0=임시 포트)')
    .option('--host <addr>', '루프백 또는 tailnet 바인드 주소')
    .action((options: { port?: string; host?: string }) => runControlServe(options));
  control.command('join').description('Primary 관제부 주소와 허용된 범위 토큰을 이 인스턴스에 기록')
    .requiredOption('--url <url>', 'Primary 주소')
    .option('--admin-token <token>', 'admin 토큰')
    .option('--member-token <token>', 'member 토큰')
    .option('--query-token <token>', 'query 토큰')
    .action((options: { url: string; adminToken?: string; memberToken?: string; queryToken?: string }) => {
      writePrimaryJoin({ url: options.url, tokens: {
        ...(options.adminToken ? { admin: options.adminToken } : {}),
        ...(options.memberToken ? { member: options.memberToken } : {}),
        ...(options.queryToken ? { query: options.queryToken } : {}),
      } });
    });
  const token = control.command('token').description('기계별 범위 토큰 관리');
  token.command('issue <machine>').description('기계 토큰 발급 또는 교체')
    .action((machine: string) => {
      try { console.log(issueMemberToken(machine)); }
      catch (error) { console.error(reasonFor(error)); process.exitCode = 2; }
    });
  token.command('revoke <machine>').description('기계 토큰 폐기')
    .action((machine: string) => {
      try { revokeMemberToken(machine); }
      catch (error) { console.error(reasonFor(error)); process.exitCode = 2; }
    });
  token.command('list').description('기계별 발급 시각 조회')
    .action(() => {
      try { for (const { machine, issuedAt } of listMemberTokens()) console.log(`${machine} · ${issuedAt}`); }
      catch (error) { console.error(reasonFor(error)); process.exitCode = 2; }
    });

  const resources = program.command('resources').description('관제부 자원 조회');
  resources.command('where <nameOrKind>').description('이름 또는 kind 로 찾기')
    .option('--primary-url <url>', 'Primary 주소')
    .option('--query-token <token>', 'query 토큰')
    .option('--port <n>', '관제부 포트')
    .option('--json', '마지막 줄 JSON')
    .action(async (where: string, options: { port?: string; primaryUrl?: string; queryToken?: string; json?: boolean }) => {
      process.exitCode = await runResourcesQuery({ where, ...options });
    });
  resources.command('list').description('자원 목록')
    .option('--kind <k>', 'kind 로 필터')
    .option('--primary-url <url>', 'Primary 주소')
    .option('--query-token <token>', 'query 토큰')
    .option('--port <n>', '관제부 포트')
    .option('--json', '마지막 줄 JSON')
    .action(async (options: { kind?: string; port?: string; primaryUrl?: string; queryToken?: string; json?: boolean }) => {
      process.exitCode = await runResourcesQuery(options);
    });
}
