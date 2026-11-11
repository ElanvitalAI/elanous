import { isAbsolute, join } from 'node:path';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createLeaseHolderView } from '../control-plane/lease-holder.js';
import { resolveMachineName } from '../roles/machine-name.js';
import { readRoleLeaseAsync } from '../roles/role-lease-read.js';
import type { RoleLeaseRead } from '../roles/role-lease.js';
import { resolveRoleBucket } from './role-cli.js';
import { Option, type Command } from 'commander';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { DEFAULT_CONTROL_PORT, ensureControlTokens, startControlServer } from '../control-plane/server.js';
import { readPrimaryJoin, resolvePrimary } from '../control-plane/primary.js';
import { selectRemotePrimary, validateRemotePrimaryCandidates, type RemotePrimaryCandidate } from '../control-plane/remote-primary-candidates.js';
import { runLightMember, type LightResource } from '../control-plane/light-member.js';
import { RESOURCE_KINDS, type ResourceKind } from '../control-plane/ledger.js';
import { runControlJoin, type ControlJoinOptions } from './control-join-cli.js';
import type { ResourceView } from '../control-plane/ledger.js';
import { issueMemberToken, issueMemberTokenToFile, revokeMemberToken, listMemberTokens } from '../control-plane/member-tokens.js';
import { collectControlStatus, readControlHqLease } from '../control/control-status.js';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config/reader.js';
import { registerResourceLedgerCommands } from './resource-ledger-cli.js';
import { registerTrainThroughputCommands } from './train-throughput.js';

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

/** Doctor's read-only live source. One malformed Nexus machine row invalidates the whole
 *  reading: doctor reports unmeasured rather than treating a partial registry as complete. */
export async function listMachineResources(options: { primaryUrl?: string; queryToken?: string; port?: string; root?: string; fetch?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response> } = {}): Promise<ResourceView[]> {
  const portOverride = options.port ?? (process.env.ELANOUS_CONTROL_PORT?.trim() || undefined);
  const primary = await resolvePrimary({
    role: 'query',
    ...(options.root ? { root: options.root } : {}),
    config: { url: options.primaryUrl, tokens: options.queryToken ? { query: options.queryToken } : undefined },
    ...(portOverride !== undefined ? { port: Number(portOverride) } : {}),
  });
  const token = primary.token;
  if (!token) throw new Error('control query token unavailable');
  const url = new URL('/v1/resources', primary.url);
  url.searchParams.set('kind', 'machine');
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`control HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('resources' in body) || !Array.isArray(body.resources) ||
      body.resources.some((row: unknown) => !row || typeof row !== 'object' ||
        (row as ResourceView).kind !== 'machine' || typeof (row as ResourceView).machine !== 'string' ||
        typeof (row as ResourceView).name !== 'string' || typeof (row as ResourceView).expired !== 'boolean' ||
        !((row as ResourceView).attrs && typeof (row as ResourceView).attrs === 'object'))) {
    throw new Error('invalid machine resource response');
  }
  return body.resources as ResourceView[];
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

function remotePrimaryUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '::1', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('원격 primary URL은 HTTPS여야 함 (로컬 루프백 제외)');
  return url.origin;
}

function primaryTokenFromFile(path: string): string {
  if (!isAbsolute(path)) throw new Error('primary token file path must be absolute');
  const info = lstatSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('primary token file must be a private regular file (0600)');
  const token = readFileSync(path, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid primary token file');
  return token;
}

function primaryCandidatesFromFile(path: string): RemotePrimaryCandidate[] {
  if (!isAbsolute(path)) throw new Error('primary candidates file path must be absolute');
  const info = lstatSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('primary candidates file must be a private regular file (0600)');
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error('primary candidates file must contain an array');
  return validateRemotePrimaryCandidates(value as RemotePrimaryCandidate[]);
}

function primaryGenerationFloor(root: string): number {
  const path = join(root, 'control', 'primary-generation.json');
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('primary generation floor file must be private');
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('invalid primary generation floor');
  return value as number;
}

function advancePrimaryGeneration(root: string, generation: number): void {
  if (generation <= primaryGenerationFloor(root)) return;
  const dir = join(root, 'control');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'primary-generation.json');
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(generation), { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally { rmSync(temp, { force: true }); }
}

async function readRemotePrimary(url: string, token: string): Promise<RoleLeaseRead> {
  try {
    const response = await fetch(`${url}/v1/primary/authorized`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { kind: 'unmeasured', why: `HQ primary HTTP ${response.status}` };
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'unmeasured', why: 'invalid HQ primary response' };
    const value = body as Record<string, unknown>;
    if (value.known !== true) return { kind: 'unmeasured', why: 'HQ primary unknown or expired' };
    if (value.serving !== true) return { kind: 'unmeasured', why: 'HQ control is not the primary holder' };
    if (typeof value.holder !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value.holder) ||
        !Number.isSafeInteger(value.generation) || (value.generation as number) < 1) {
      return { kind: 'unmeasured', why: 'invalid HQ primary holder or generation' };
    }
    return { kind: 'present', doc: { holder: value.holder, generation: value.generation as number, state: 'held', renewedAt: Date.now() } };
  } catch (error) { return { kind: 'unmeasured', why: reasonFor(error) }; }
}

export async function runControlServe(options: { port?: string; host?: string; allowClusterBind?: boolean; followLease?: boolean; followHqLease?: boolean; bucket?: string;
  followRemotePrimary?: string; primaryTokenFile?: string; primaryCandidatesFile?: string; fetchPrimary?: typeof fetch;
  read?: (bucket: string) => RoleLeaseRead | Promise<RoleLeaseRead>; machine?: string;
  readHq?: typeof readControlHqLease; hqHostName?: string;
  /** 시험 seam — 이 신호로 멈춘다. ⛔ 시험이 `process.emit('SIGTERM')` 로 멈추면 같은 프로세스의 다른 SIGTERM 처리기
   *  (로그 저장소가 «남은 처리기가 없으면 자기에게 진짜 SIGTERM 을 다시 보낸다»)가 깨어 **시험 러너가 죽었다**
   *  (📏 09-27 0.2.3 게이트: 전체 한 프로세스면 이 시험 자리에서 rc 143 · 조각으로 나누면 완주). */
  signal?: AbortSignal;
}): Promise<void> {
  let port: number;
  let bucket: string | undefined;
  let remoteUrl: string | undefined;
  let remoteToken: string | undefined;
  let remoteCandidates: readonly RemotePrimaryCandidate[] | undefined;
  try {
    port = controlPort(options.port);
    const roles = getUserConfig().raw.roles;
    const configuredBucket = roles && typeof roles === 'object' && !Array.isArray(roles)
      ? (roles as { bucket?: unknown }).bucket : undefined;
    const hasRoleBucket = options.bucket !== undefined || process.env.ELANOUS_BACKUP_BUCKET !== undefined || configuredBucket !== undefined;
    remoteCandidates = options.primaryCandidatesFile ? primaryCandidatesFromFile(options.primaryCandidatesFile) : undefined;
    const joined = !options.followRemotePrimary && !remoteCandidates && !hasRoleBucket && options.followLease !== false && !options.followHqLease
      ? readPrimaryJoin() : undefined;
    remoteUrl = options.followRemotePrimary ?? joined?.url;
    if (remoteUrl) {
      remoteUrl = remotePrimaryUrl(remoteUrl);
      remoteToken = options.primaryTokenFile ? primaryTokenFromFile(options.primaryTokenFile) : joined?.tokens.member;
      if (!remoteToken) throw new Error('원격 primary member 토큰 파일이 필요함 (--primary-token-file)');
    }
    const followLease = options.followLease ?? (hasRoleBucket && !options.followHqLease && !remoteUrl && !remoteCandidates);
    if ([followLease, options.followHqLease, !!remoteUrl, !!remoteCandidates].filter(Boolean).length > 1) throw new Error('primary 임대 소스는 하나만 선택 가능');
    if (followLease) bucket = resolveRoleBucket(options.bucket);
  } catch (error) { console.error(reasonFor(error)); process.exitCode = 2; return; }
  const machine = options.followHqLease ? '' : resolveMachineName({ option: options.machine }).machine;
  // HQ's holder identity is hq.hostName. A caller-controlled role machine alias cannot grant primary writes.
  let hqHostName: string | undefined;
  if (options.followHqLease) {
    try { hqHostName = options.hqHostName ?? getUserConfig().hq?.hostName; }
    catch { /* Unknown local identity must remain fail closed at the write boundary. */ }
  }
  let lastLeaseState: string | undefined;
  const observeLease = async (source: 'gcs' | 'remote' | 'hq', read: () => Promise<RoleLeaseRead> | RoleLeaseRead): Promise<RoleLeaseRead> => {
      let result: RoleLeaseRead;
      try { result = await read(); }
      catch (error) { result = { kind: 'unmeasured', why: reasonFor(error) }; }
      const state = result.kind === 'present' ? `present:${result.doc.holder}:${result.doc.generation}`
        : result.kind === 'unmeasured' ? `unmeasured:${result.why}` : 'absent';
      if (state !== lastLeaseState) {
        debug.log('control.primary', 'lease-observed', {
          source, bucket: bucket ?? null, url: remoteUrl ?? null, machine: source === 'hq' ? hqHostName ?? null : machine, kind: result.kind,
          holder: result.kind === 'present' ? result.doc.holder : null,
          generation: result.kind === 'present' ? result.doc.generation : null,
          reason: result.kind === 'unmeasured' ? result.why : null,
        });
        if (result.kind === 'unmeasured') console.error(`관제부 primary 임대 미측정: ${result.why}`);
        lastLeaseState = state;
      }
      return result;
  };
  const remoteLeaseView = (remoteUrl && remoteToken || remoteCandidates) ? createLeaseHolderView({
    ttlMs: 0, // A revoked HQ token or lost primary must fence the next worker write immediately.
    machine, read: () => observeLease('remote', async () => {
      if (remoteCandidates) {
        const root = effectiveInstanceRoot();
        const selected = await selectRemotePrimary(options.primaryCandidatesFile
          ? primaryCandidatesFromFile(options.primaryCandidatesFile) : remoteCandidates, options.fetchPrimary, primaryGenerationFloor(root));
        if (selected.kind === 'unmeasured') return { kind: 'unmeasured' as const, why: selected.why };
        advancePrimaryGeneration(root, selected.generation);
        // A newer concurrent request may have raised the floor while this request awaited its candidates.
        if (selected.generation < primaryGenerationFloor(root))
          return { kind: 'unmeasured' as const, why: 'HQ primary generation 회귀' };
        return { kind: 'present' as const, doc: { holder: selected.holder, generation: selected.generation, state: 'held' as const, renewedAt: Date.now() } };
      }
      return readRemotePrimary(remoteUrl!, options.primaryTokenFile ? primaryTokenFromFile(options.primaryTokenFile) : remoteToken!);
    }),
  }) : undefined;
  const leaseView = bucket !== undefined ? createLeaseHolderView({
    ttlMs: 0, // Every write must observe the current storage lease, including non-worker mutations.
    machine, read: () => observeLease('gcs', () => (options.read ?? readRoleLeaseAsync)(bucket)),
  }) : remoteLeaseView ? { get: async () => {
    const snapshot = await remoteLeaseView.get({ fresh: true });
    // The authenticated HQ holder owns the cluster lease. A worker host may write its local ledger
    // while that HQ is serving; comparing the HQ machine name to this worker would deny every host.
    return { ...snapshot, iAmHolder: snapshot.known };
  } } : options.followHqLease ? createLeaseHolderView({
    ttlMs: 0, // HQ lease expiry or handoff must fence the next write, not the next cache interval.
    machine: hqHostName ?? '', read: () => observeLease('hq', () => {
      const { record, expired } = (options.readHq ?? readControlHqLease)();
      return hqHostName && record && expired === false
        ? { kind: 'present' as const, doc: { holder: record.holder, generation: record.generation, state: 'held' as const, renewedAt: record.renewedAt } }
        : { kind: 'unmeasured' as const, why: 'HQ lease missing or expired' };
    }),
  }) : undefined;
  let server: ReturnType<typeof startControlServer>;
  if (options.allowClusterBind && options.host === '0.0.0.0') {
    debug.log('control-plane', 'cluster-bind-enabled', { hostname: options.host, port, exposure: 'operator-restricted-cluster-service' });
  }
  try { server = startControlServer({ port, hostname: options.host, allowClusterBind: options.allowClusterBind,
    authoritativePrimary: !remoteUrl && !remoteCandidates, ...(leaseView ? { leaseView, requireKnownLeaseForWrites: true } : {}) }); }
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
    console.log(`관제부 ${new URL(server.url).host} · 토큰 ${join(effectiveInstanceRoot(), 'control', 'tokens.json')}${bucket !== undefined ? ` · 임대 따름 · ${bucket} · 나=${machine}` : remoteCandidates ? ` · HQ endpoint 광고 따름 · 나=${machine}` : remoteUrl ? ` · 원격 primary 따름 · ${remoteUrl} · 나=${machine}` : options.followHqLease ? ` · HQ 임대 따름 · 나=${hqHostName ?? '미확인'}` : ''}`);
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
    .option('--allow-cluster-bind', '클러스터 내부 Service용 0.0.0.0 바인드를 명시 허용')
    .option('--follow-lease', '임대 보유자일 때만 쓰기(버킷 설정 시 기본)')
    .option('--no-follow-lease', '역할 임대 추적을 명시적으로 끄기')
    .option('--follow-hq-lease', 'HQ 임대 보유자일 때만 쓰기')
    .option('--follow-remote-primary <url>', 'HQ control 의 primary 를 원격으로 따르기')
    .option('--primary-candidates-file <path>', '현재 HQ 임대 보유자를 찾을 private endpoint 광고 JSON')
    .option('--primary-token-file <path>', 'HQ member 토큰의 0600 파일')
    .option('--bucket <bucket>', 'GCS 임대 버킷')
    .action((options: { port?: string; host?: string; allowClusterBind?: boolean; followLease?: boolean; followHqLease?: boolean; bucket?: string; followRemotePrimary?: string; primaryTokenFile?: string; primaryCandidatesFile?: string }) => runControlServe(options));
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
    .option('--token-file <path>', '토큰을 새 0600 파일로만 쓰고 stdout에 출력하지 않음')
    .action((machine: string, options: { tokenFile?: string }) => {
      try {
        if (options.tokenFile) issueMemberTokenToFile(machine, options.tokenFile);
        else console.log(issueMemberToken(machine));
      }
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
  registerResourceLedgerCommands(resources);
  const train = program.command('train').description('열차 관측');
  registerTrainThroughputCommands(train);
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
