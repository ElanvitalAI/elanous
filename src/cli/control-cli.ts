import { join } from 'node:path';
import { createLeaseHolderView } from '../control-plane/lease-holder.js';
import { resolveMachineName } from '../roles/machine-name.js';
import { readRoleLeaseAsync } from '../roles/role-lease-read.js';
import type { RoleLeaseRead } from '../roles/role-lease.js';
import { resolveRoleBucket } from './role-cli.js';
import { Option, type Command } from 'commander';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { DEFAULT_CONTROL_PORT, ensureControlTokens, startControlServer } from '../control-plane/server.js';
import { resolvePrimary } from '../control-plane/primary.js';
import { runLightMember, type LightResource } from '../control-plane/light-member.js';
import { RESOURCE_KINDS, type ResourceKind } from '../control-plane/ledger.js';
import { runControlJoin, type ControlJoinOptions } from './control-join-cli.js';
import type { ResourceView } from '../control-plane/ledger.js';
import { issueMemberToken, revokeMemberToken, listMemberTokens } from '../control-plane/member-tokens.js';
import { collectControlStatus } from '../control/control-status.js';

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
    const primary = await resolvePrimary({
      role: 'query',
      config: { url: options.primaryUrl, tokens: options.queryToken ? { query: options.queryToken } : undefined },
      ...(portOverride !== undefined ? { port: Number(portOverride) } : {}),
    });
    base = primary.url;
    token = primary.token;
    if (!token && primary.source === 'local') token = ensureControlTokens().query;
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
    else for (const row of selected) console.log(`${row.kind} · ${row.name} · ${row.machine} · ${row.endpoint ?? '-'} · ${row.ageMs}ms · ${row.expired}${typeof row.attrs?.bind === 'string' ? ` · ${row.attrs.bind}` : ''}`.replaceAll(token, '[redacted]'));
    return 0;
  } catch (error) {
    console.error(`관제부에 닿지 못함(${base}/v1/resources · ${reasonFor(error, token)})`);
    return 2;
  }
}

export async function runControlServe(options: { port?: string; host?: string; followLease?: boolean; bucket?: string;
  read?: (bucket: string) => RoleLeaseRead | Promise<RoleLeaseRead>; machine?: string;
  /** 시험 seam — 이 신호로 멈춘다. ⛔ 시험이 `process.emit('SIGTERM')` 로 멈추면 같은 프로세스의 다른 SIGTERM 처리기
   *  (로그 저장소가 «남은 처리기가 없으면 자기에게 진짜 SIGTERM 을 다시 보낸다»)가 깨어 **시험 러너가 죽었다**
   *  (📏 09-27 0.2.3 게이트: 전체 한 프로세스면 이 시험 자리에서 rc 143 · 조각으로 나누면 완주). */
  signal?: AbortSignal;
}): Promise<void> {
  let port: number;
  let bucket: string | undefined;
  try {
    port = controlPort(options.port);
    if (options.followLease) bucket = resolveRoleBucket(options.bucket);
  } catch (error) { console.error(reasonFor(error)); process.exitCode = 2; return; }
  const machine = resolveMachineName({ option: options.machine }).machine;
  const leaseView = bucket === undefined ? undefined : createLeaseHolderView({
    machine, read: () => (options.read ?? readRoleLeaseAsync)(bucket),
  });
  let server: ReturnType<typeof startControlServer>;
  try { server = startControlServer({ port, hostname: options.host, ...(leaseView ? { leaseView, requireKnownLeaseForWrites: true } : {}) }); }
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
    if (options.signal) {
      if (options.signal.aborted) { stop(); return; }
      options.signal.addEventListener('abort', stop, { once: true });
    }
    console.log(`관제부 ${new URL(server.url).host} · 토큰 ${join(effectiveInstanceRoot(), 'control', 'tokens.json')}${bucket === undefined ? '' : ` · 임대 따름 · ${bucket} · 나=${machine}`}`);
  });
}

export async function runControlMember(options: { resource?: string[]; interval?: string; once?: boolean; json?: boolean }): Promise<number> {
  const primary = resolvePrimary({ role: 'member' });
  if (primary.source !== 'join' || !primary.machine || !primary.token) {
    console.error('먼저 `elanous control join` 을 치세요');
    return 2;
  }
  try {
    const resources: LightResource[] = (options.resource ?? []).map(value => {
      const match = /^([^:]+):([^=]+)=(.+)$/.exec(value);
      if (!match || !RESOURCE_KINDS.includes(match[1] as ResourceKind)) throw new Error('invalid resource declaration');
      return { kind: match[1] as ResourceKind, name: match[2]!, url: match[3]! };
    });
    const seconds = options.interval === undefined ? undefined : Number(options.interval);
    if (options.interval !== undefined && (!/^\d+(?:\.\d+)?$/.test(options.interval) || !Number.isFinite(seconds) || seconds! <= 0 || seconds! > 300)) {
      throw new Error('invalid member interval');
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (!options.once) {
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
    try {
      const result = await runLightMember({ resources, ...(seconds === undefined ? {} : { intervalMs: seconds * 1000 }),
        once: options.once, signal: controller.signal });
      if (options.once) {
        if (options.json) console.log(JSON.stringify(result).replaceAll(primary.token, '[redacted]'));
        else {
          console.log(`machine · ${result.machine}`.replaceAll(primary.token, '[redacted]'));
          for (const resource of result.resources) console.log(`${resource.kind} · ${resource.name} · ${resource.url} · ${resource.bind} · ${resource.reachable}`.replaceAll(primary.token, '[redacted]'));
        }
      }
      return 0;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } catch (error) {
    const safe = error instanceof Error && ['invalid resource declaration', 'invalid member interval', 'invalid member resource',
      'invalid resource URL', 'duplicate member resource', 'invalid member heartbeat interval', 'network-or-timeout'].includes(error.message)
      ? error.message : error instanceof Error && /^http-\d+$/.test(error.message) ? error.message : 'member failed';
    console.error(`멤버 등록 실패: ${safe}`);
    return 2;
  }
}

export function registerControlCommands(program: Command): void {
  const control = program.command('control').description('독립 관제부');
  control.command('status').description('집 하나의 읽기 전용 관제 현황')
    .option('--json', '일곱 줄을 JSON으로 출력')
    .action(async (options: { json?: boolean }) => {
      const rows = await collectControlStatus();
      if (options.json) console.log(JSON.stringify({ rows }));
      else for (const { row, state, text, reason } of rows) {
        const label = state === 'ok' ? '정상' : state === 'warn' ? '주의' : '못 쟀다';
        console.log(`${row} · ${label} · ${text}${reason ? ` — ${reason}` : ''}`
          .replace(/\r/g, '\\r').replace(/\n/g, '\\n')
          // Other C0/C1 controls (ESC, backspace, ...) and line separators must not repaint the terminal table.
          .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`));
      }
    });
  control.command('serve').description('관제부를 포그라운드에서 실행')
    .option('--port <n>', '리스닝 포트(0=임시 포트)')
    .option('--host <addr>', '루프백 또는 tailnet 바인드 주소')
    .option('--follow-lease', '임대 보유자일 때만 쓰기')
    .option('--bucket <bucket>', 'GCS 임대 버킷')
    .action((options: { port?: string; host?: string; followLease?: boolean; bucket?: string }) => runControlServe(options));
  control.command('member').description('합류 기계의 자원을 포그라운드에서 등록·심박')
    .option('--resource <kind:name=url>', '등록할 자원', (value: string, previous: string[]) => [...previous, value], [] as string[])
    .option('--interval <seconds>', '심박 간격(초)')
    .option('--once', '한 번만 등록하고 종료')
    .option('--json', '한 번 등록 결과를 JSON으로 출력')
    .action(async (options: { resource?: string[]; interval?: string; once?: boolean; json?: boolean }) => {
      process.exitCode = await runControlMember(options);
    });
  control.command('join').description('Primary 관제부 주소와 기계 범위 토큰으로 합류')
    .option('--url <url>', 'Primary 주소')
    .option('--machine <name>', '기계 이름')
    .option('--token-file <path>', '파일에서 기계 범위 토큰 읽기')
    .option('--token-stdin', '표준입력에서 기계 범위 토큰 읽기')
    .addOption(new Option('--admin-token <token>').hideHelp())
    .addOption(new Option('--member-token <token>').hideHelp())
    .addOption(new Option('--query-token <token>').hideHelp())
    .action(async (options: ControlJoinOptions & { adminToken?: string; memberToken?: string; queryToken?: string }) => {
      if (options.adminToken !== undefined || options.memberToken !== undefined || options.queryToken !== undefined) {
        console.error('토큰은 인자로 받지 않습니다 — `--token-file` 또는 `--token-stdin`');
        process.exitCode = 2;
        return;
      }
      process.exitCode = await runControlJoin(options);
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
      process.exitCode = await runResourcesQuery({ where, port: options.port, primaryUrl: options.primaryUrl, queryToken: options.queryToken, json: options.json });
    });
  resources.command('list').description('자원 목록')
    .option('--kind <k>', 'kind 로 필터')
    .option('--primary-url <url>', 'Primary 주소')
    .option('--query-token <token>', 'query 토큰')
    .option('--port <n>', '관제부 포트')
    .option('--json', '마지막 줄 JSON')
    .action(async (options: { kind?: string; port?: string; primaryUrl?: string; queryToken?: string; json?: boolean }) => {
      process.exitCode = await runResourcesQuery({ kind: options.kind, port: options.port, primaryUrl: options.primaryUrl, queryToken: options.queryToken, json: options.json });
    });
}
