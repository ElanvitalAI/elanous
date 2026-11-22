// 저장소 한 벌 — local(기본) · gcs · azure · s3 · r2 를 같은 인터페이스로.
// RFC 저장소 공급자 S1. 설정이 비면 원격 CLI 를 부르지 않는다.
// 자격·서명 URL 은 관측에 싣지 않는다.

import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { resolveCliBin, type CliBinDeps, type CliBinName } from './cli-bin.js';
import { isPublicKey } from './s3.js';

export type StorageProvider = 'local' | 'gcs' | 'azure' | 's3' | 'r2';

export interface StorageConfig {
  provider: StorageProvider;
  localDir: string;
  bucket: string;
  publicBucket: string;
  prefix: string;
  /** Shared SQLite path used to coordinate app quota reservations across remote-store writers. */
  quotaLedgerPath?: string;
  gcs?: { project: string };
  azure?: { account: string };
  s3?: { region?: string; profile?: string };
  r2?: { accountId: string; profile?: string };
}

export interface ObjectHead {
  exists: boolean;
  bytes?: number;
  /**
   * 불변 객체 버전(WIRE ① OBJECTHEAD-GENERATION · OP #128878/#128835). 같은 경로를 교체해도
   * 값이 바뀐다 — 회원 공유 링크가 발급 때의 버전에만 결속되게 하는 원료다.
   *  - local: `${dev}:${ino}:${mtimeNs}` (put 은 tmp+rename 이라 inode·mtimeNs 이 매번 바뀐다)
   *  - gcs: objects describe 의 `generation`
   *  - s3/r2: head-object 의 `VersionId` — 버전 미활성 버킷은 CLI 가 주지 않으므로 미포함.
   *    세대가 없으면 generation 을 못 믿는다(발급 계층에서 거부).
   *  - azure: 미제공(blob 버전 정책 계약 밖 — 소비 계층은 undefined 를 «세대 결속 불가» 로 다룬다).
   */
  generation?: string;
}

export interface PutOptions {
  contentType?: string;
  /** CLI `--public`. 키의 공개 기능 여부와 무관하게 공개 버킷. */
  public?: boolean;
  /** JUD hold(14:57) ⑦차 ① — gcs 업로드 자격 결속: ADC 파생 접근 토큰 파일 경로.
   *  gcloud storage cp 는 이 토큰으로만 서명한다(--access-token-file · 앰비언트 gcloud 자격 사용 안 함). */
  gcsAccessTokenFile?: string;
}

export interface GetOptions {
  /**
   * 발급 시점의 불변 객체 버전(ObjectHead.generation) — jud-39564-e5edf3206d3b(보안 HOLD 수리):
   * 공유 링크 읽기는 «소유자 확인 + 읽을 객체 버전 결속» 계약이다. generation 을 주면 그 세대의
   * 바이트만 내린다 — head 확인 직후 같은 경로가 교체돼도 «최신» 객체를 반환하지 않는다
   * (불일치·소실 = 거부 · fail-closed). 소유자 확인은 발급·폐기·검증 계층 계약
   * (member-share-link · jud-39544-1868e6b6c4)이고 이 계층은 읽을 객체의 버전 결속을 담당한다.
   * azure 는 head 가 generation 을 내지 않는다 — 결속 요청 자체를 거부한다(세대 없음 = 결속 불가).
   */
  generation?: string;
}

export interface ObjectStore {
  provider: StorageProvider;
  put(key: string, body: string | Uint8Array, opts?: PutOptions): void;
  delete(key: string): void;
  get(key: string, localPath: string, opts?: GetOptions): void;
  head(key: string): ObjectHead;
  list(prefix: string): string[];
  publicUrl(key: string): string | null;
}

/** Build a validated app-scoped key without accepting a caller supplied prefix. */
export function appObjectKey(appSlug: string, key: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(appSlug)
    || !key || key.startsWith('/') || key.includes('\\') || key.includes('\0') || key.startsWith('apps/')) {
    throw new Error('invalid app slug or app-relative object key');
  }
  const parts = key.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))) {
    throw new Error('invalid app slug or app-relative object key');
  }
  return `apps/${appSlug}/${parts.join('/')}`;
}

/** 주입 가능한 CLI 실행. 기본은 execFileSync. 올리기 60초 · 내리기 30초. */
export type RunFn = (bin: string, args: string[], opts?: { input?: Uint8Array | string; timeoutMs?: number }) => { stdout: string; stderr: string };

export interface ObjectStoreDeps {
  run?: RunFn;
  which?: (name: string) => string;
  now?: () => number;
  /** CLI 경로 해석. 없으면 resolveCliBin. */
  cliBin?: CliBinDeps;
}

interface RawStorage {
  provider?: unknown;
  bucket?: unknown;
  publicBucket?: unknown;
  prefix?: unknown;
  localDir?: unknown;
  quotaLedgerPath?: unknown;
  gcs?: { project?: unknown };
  azure?: { account?: unknown };
  s3?: { bucket?: unknown; publicBucket?: unknown; region?: unknown; profile?: unknown };
  r2?: { accountId?: unknown; profile?: unknown };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

const DEFAULT_PREFIX = 'monad';

/** 설정 해석. provider 명시 > 옛 s3 버킷(env 포함) > local. ELANOUS_S3_DISABLED=1 이면 원격도 local. */
/** 로컬 저장 기본 뿌리 — 우주(운영/격리)를 따르는 상태 루트 아래 `storage/`.
 *  ⛔ `~/.elanous` 를 박지 않는다: 격리 시험이 운영 폴더에 쓰게 된다(격리 관문 · PLAN §0).
 *  문자열 `'~/.elanous/storage'` 도 같은 누수다 — 관문은 `join(homedir…)` 모양만 잡아 그것을 못 봤다. */
export function defaultLocalStorageDir(): string {
  return join(elanousStateRoot(), 'storage');
}

export function resolveStorageConfig(
  raw?: { storage?: RawStorage } | null,
  env: NodeJS.ProcessEnv = process.env,
): StorageConfig {
  const storage = raw?.storage ?? {};
  const s3 = storage.s3 ?? {};
  const envBucket = str(env.AWS_S3_BUCKET);
  const envPublic = str(env.AWS_S3_PUBLIC_BUCKET);
  const bucket = str(storage.bucket) || str(s3.bucket) || envBucket;
  const publicBucket = str(storage.publicBucket) || str(s3.publicBucket) || envPublic;
  const prefix = str(storage.prefix) || str(env.AWS_S3_ELANOUS_PREFIX) || DEFAULT_PREFIX;
  const localDir = str(storage.localDir) ? expandHome(str(storage.localDir)) : defaultLocalStorageDir();

  let provider: StorageProvider = 'local';
  const named = str(storage.provider).toLowerCase();
  if (named === 'local' || named === 'gcs' || named === 'azure' || named === 's3' || named === 'r2') {
    provider = named;
  } else if (bucket) {
    provider = 's3';
  }
  if (env.ELANOUS_S3_DISABLED === '1') provider = 'local';

  const cfg: StorageConfig = { provider, localDir, bucket, publicBucket, prefix };
  if (str(storage.quotaLedgerPath)) cfg.quotaLedgerPath = expandHome(str(storage.quotaLedgerPath));
  const project = str(storage.gcs?.project);
  if (project) cfg.gcs = { project };
  const account = str(storage.azure?.account);
  if (account) cfg.azure = { account };
  const region = str(s3.region);
  const profile = str(s3.profile);
  if (region || profile) cfg.s3 = { ...(region ? { region } : {}), ...(profile ? { profile } : {}) };
  const accountId = str(storage.r2?.accountId);
  const r2Profile = str(storage.r2?.profile);
  if (accountId || r2Profile) cfg.r2 = { accountId, ...(r2Profile ? { profile: r2Profile } : {}) };
  return cfg;
}

function defaultRun(bin: string, args: string[], opts?: { input?: Uint8Array | string; timeoutMs?: number }): { stdout: string; stderr: string } {
  const stdout = execFileSync(bin, args, {
    timeout: opts?.timeoutMs ?? 60_000,
    input: opts?.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { stdout: typeof stdout === 'string' ? stdout : '', stderr: '' };
}

const CLI_BIN_NAMES = new Set<string>(['gcloud', 'aws', 'az', 'wrangler']);

/** 찾으면 그 경로. 못 찾으면 이름 그대로(호출자가 PATH 에 맡긴다). */
function defaultWhich(name: string, cliBin?: CliBinDeps): string {
  if (!CLI_BIN_NAMES.has(name)) return name;
  return resolveCliBin(name as CliBinName, cliBin) ?? name;
}

export type BucketKind = 'private' | 'public';

export function bucketKindForKey(key: string): BucketKind {
  return isPublicKey(key) ? 'public' : 'private';
}

/** 키가 갈 버킷. 공개 기능인데 publicBucket 이 비면 거부. local 은 칸 이름(private|public)을 쓴다.
 *  `forcePublic` 은 CLI `--public` — 키 조각과 무관하게 공개 버킷. */
export function resolveBucket(cfg: StorageConfig, key: string, forcePublic = false): { kind: BucketKind; bucket: string } {
  const kind: BucketKind = forcePublic ? 'public' : bucketKindForKey(key);
  if (cfg.provider === 'local') {
    const named = kind === 'public' ? cfg.publicBucket : cfg.bucket;
    return { kind, bucket: named || kind };
  }
  const bucket = kind === 'public' ? cfg.publicBucket : cfg.bucket;
  if (!bucket) {
    const which = kind === 'public' ? 'storage.publicBucket' : 'storage.bucket';
    throw new Error(`저장소 버킷이 설정되지 않았다: ${which}`);
  }
  return { kind, bucket };
}

function logOp(event: 'put' | 'get' | 'delete' | 'failed', data: { provider: StorageProvider; bucketKind: BucketKind; key: string; ms: number }): void {
  try { debug.log('storage.object', event, data); } catch { /* 관측 실패가 흐름을 막지 않는다 */ }
}

function asBytes(body: string | Uint8Array): Uint8Array {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return body;
}

function localObjectPath(cfg: StorageConfig, bucket: string, key: string): string {
  const clean = key.split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
  return join(cfg.localDir, bucket, clean);
}

function walkFiles(dir: string, prefixRel: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const abs = join(dir, name);
    const rel = prefixRel ? `${prefixRel}/${name}` : name;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walkFiles(abs, rel, out);
    else out.push(rel);
  }
}

function awsExtra(cfg: StorageConfig): string[] {
  const extra: string[] = [];
  if (cfg.provider === 'r2') {
    const id = cfg.r2?.accountId ?? '';
    if (!id) throw new Error('r2.accountId 가 설정되지 않았다');
    extra.push('--endpoint-url', `https://${id}.r2.cloudflarestorage.com`);
    if (cfg.r2?.profile) extra.push('--profile', cfg.r2.profile);
    return extra;
  }
  if (cfg.s3?.profile) extra.push('--profile', cfg.s3.profile);
  if (cfg.s3?.region) extra.push('--region', cfg.s3.region);
  return extra;
}

function contentTypeArgs(provider: StorageProvider, contentType: string | undefined): string[] {
  if (!contentType) return [];
  if (provider === 's3' || provider === 'r2') return ['--content-type', contentType];
  if (provider === 'gcs') return ['--content-type', contentType];
  if (provider === 'azure') return ['--content-type', contentType];
  return [];
}

export function createObjectStore(config: StorageConfig, deps: ObjectStoreDeps = {}): ObjectStore {
  const run = deps.run ?? defaultRun;
  const which = deps.which ?? ((name: string) => defaultWhich(name, deps.cliBin));
  const now = deps.now ?? Date.now;

  function timed<T>(event: 'put' | 'get' | 'delete', kind: BucketKind, key: string, fn: () => T): T {
    const t0 = now();
    try {
      const out = fn();
      logOp(event, { provider: config.provider, bucketKind: kind, key, ms: now() - t0 });
      return out;
    } catch (e) {
      logOp('failed', { provider: config.provider, bucketKind: kind, key, ms: now() - t0 });
      throw e;
    }
  }

  function putLocal(key: string, body: string | Uint8Array, opts?: PutOptions): void {
    const { bucket } = resolveBucket(config, key, opts?.public === true);
    const dest = localObjectPath(config, bucket, key);
    mkdirSync(dirname(dest), { recursive: true });
    if (typeof body === 'string' && existsSync(body) && statSync(body).isFile()) {
      copyFileSync(body, dest);
      return;
    }
    writeFileSync(dest, asBytes(body));
  }

  function putRemote(key: string, body: string | Uint8Array, opts?: PutOptions): void {
    const { bucket } = resolveBucket(config, key, opts?.public === true);
    const provider = config.provider;
    const ct = contentTypeArgs(provider, opts?.contentType);
    const fileBody = typeof body === 'string' && existsSync(body) && statSync(body).isFile();

    if (provider === 's3' || provider === 'r2') {
      const bin = which('aws');
      const extra = awsExtra(config);
      const uri = `s3://${bucket}/${key}`;
      if (fileBody) {
        run(bin, ['s3', 'cp', body, uri, '--quiet', ...ct, ...extra], { timeoutMs: 60_000 });
      } else {
        run(bin, ['s3', 'cp', '-', uri, '--quiet', ...ct, ...extra], { input: asBytes(body), timeoutMs: 60_000 });
      }
      return;
    }
    if (provider === 'gcs') {
      const bin = which('gcloud');
      const uri = `gs://${bucket}/${key}`;
      // JUD hold(14:57) ⑦차 ① — 결속된 ADC 파생 토큰 파일이 있으면 그 자격으로만 서명한다(신원 해석과 같은 출처).
      const boundToken = typeof opts?.gcsAccessTokenFile === 'string' && opts.gcsAccessTokenFile
        ? ['--access-token-file', opts.gcsAccessTokenFile] : [];
      if (fileBody) {
        run(bin, ['storage', 'cp', body, uri, ...boundToken, ...ct], { timeoutMs: 60_000 });
      } else {
        run(bin, ['storage', 'cp', '-', uri, ...boundToken, ...ct], { input: asBytes(body), timeoutMs: 60_000 });
      }
      return;
    }
    if (provider === 'azure') {
      const account = config.azure?.account ?? '';
      if (!account) throw new Error('azure.account 가 설정되지 않았다');
      const bin = which('az');
      const args = [
        'storage', 'blob', 'upload',
        '--account-name', account,
        '--container-name', bucket,
        '--name', key,
        '--auth-mode', 'login',
        '--overwrite',
        ...ct,
      ];
      if (fileBody) args.push('--file', body);
      else args.push('--data', typeof body === 'string' ? body : new TextDecoder().decode(body));
      run(bin, args, { timeoutMs: 60_000 });
      return;
    }
    putLocal(key, body);
  }

  return {
    provider: config.provider,
    put(key, body, opts) {
      const { kind } = resolveBucket(config, key, opts?.public === true);
      timed('put', kind, key, () => {
        if (config.provider === 'local') putLocal(key, body, opts);
        else putRemote(key, body, opts);
      });
    },
    delete(key) {
      const { kind, bucket } = resolveBucket(config, key);
      timed('delete', kind, key, () => {
        if (config.provider === 'local') {
          rmSync(localObjectPath(config, bucket, key), { force: true });
          return;
        }
        if (config.provider === 's3' || config.provider === 'r2') {
          run(which('aws'), ['s3', 'rm', 's3://' + bucket + '/' + key, '--only-show-errors', ...awsExtra(config)], { timeoutMs: 30_000 });
          return;
        }
        if (config.provider === 'gcs') {
          run(which('gcloud'), ['storage', 'rm', 'gs://' + bucket + '/' + key], { timeoutMs: 30_000 });
          return;
        }
        if (config.provider === 'azure') {
          const account = config.azure?.account ?? '';
          if (!account) throw new Error('azure.account 가 설정되지 않았다');
          run(which('az'), [
            'storage', 'blob', 'delete', '--account-name', account, '--container-name', bucket,
            '--name', key, '--auth-mode', 'login',
          ], { timeoutMs: 30_000 });
        }
      });
    },
    get(key, localPath, opts) {
      const { kind, bucket } = resolveBucket(config, key);
      // jud-39564-e5edf3206d3b — 세대 결속 읽기: 발급 때의 generation 과 다르면 최신 객체를 내주지 않는다.
      const pin = opts?.generation;
      if (pin !== undefined && pin === '') {
        throw new Error(`고정 읽기 generation 이 빈 문자열이다 — 결속 불능(발급 계층 결함)이라 거부한다: ${key}`);
      }
      timed('get', kind, key, () => {
        mkdirSync(dirname(localPath), { recursive: true });
        if (config.provider === 'local') {
          const src = localObjectPath(config, bucket, key);
          if (!existsSync(src)) throw new Error(`객체가 없다: ${key}`);
          if (pin === undefined) {
            copyFileSync(src, localPath);
            return;
          }
          // fd 를 열어 원본 inode 를 고정한 뒤 fstat 세대를 대조한다 — 경로가 교체돼도 열린 fd 는
          // 발급 때의 원본을 계속 가리킨다. 세대 불일치는 «거부»다: 교체본(최신)을 내주면
          // 옛 링크가 새 바이트를 가리킨다(jud-39564 HOLD 사유 그대로).
          const fd = openSync(src, 'r');
          try {
            const st = fstatSync(fd, { bigint: true });
            const gen = `${st.dev}:${st.ino}:${st.mtimeNs}`;
            if (gen !== pin) {
              throw new Error(`object generation mismatch — 발급 때 세대와 달라 교체·이동되었다, 최신 객체를 내주지 않는다 (jud-39564): ${key}`);
            }
            const size = Number(st.size);
            const buf = Buffer.alloc(size);
            let off = 0;
            while (off < size) {
              // position null = 현재 파일 위치에서 순차 읽기(fd 는 발급 때 inode 에 고정).
              const n = readSync(fd, buf, off, size - off, null);
              if (n <= 0) break;
              off += n;
            }
            if (off !== size) throw new Error(`고정 세대 읽기가 객체 크기에 못 미친다 — 원본 보존 거부 (jud-39564): ${key}`);
            const st2 = fstatSync(fd, { bigint: true });
            if (`${st2.dev}:${st2.ino}:${st2.mtimeNs}` !== pin) {
              throw new Error(`object generation changed during read — 읽기 도중 세대가 바뀌었다, 내주지 않는다 (jud-39564): ${key}`);
            }
            writeFileSync(localPath, buf);
            return;
          } finally {
            closeSync(fd);
          }
        }
        if (config.provider === 's3' || config.provider === 'r2') {
          if (pin === undefined) {
            run(which('aws'), ['s3', 'cp', `s3://${bucket}/${key}`, localPath, '--quiet', ...awsExtra(config)], { timeoutMs: 30_000 });
            return;
          }
          // s3api get-object --version-id 는 그 세대의 불변 바이트만 내린다 — 세대 소실·권한 오류는 그대로 전파(fail-closed).
          run(which('aws'), ['s3api', 'get-object', '--bucket', bucket, '--key', key, '--version-id', pin, ...awsExtra(config), localPath], { timeoutMs: 30_000 });
          return;
        }
        if (config.provider === 'gcs') {
          if (pin === undefined) {
            run(which('gcloud'), ['storage', 'cp', `gs://${bucket}/${key}`, localPath], { timeoutMs: 30_000 });
            return;
          }
          // gcloud storage 세대 문법: gs://bucket/key#<generation> 이 그 세대의 불변 바이트를 지목한다.
          run(which('gcloud'), ['storage', 'cp', `gs://${bucket}/${key}#${pin}`, localPath], { timeoutMs: 30_000 });
          return;
        }
        if (config.provider === 'azure') {
          if (pin !== undefined) {
            throw new Error(`azure 공급자는 불변 세대를 제공하지 않는다(head.generation 없음) — 고정 읽기를 거부한다 (jud-39564 fail-closed): ${key}`);
          }
          const account = config.azure?.account ?? '';
          if (!account) throw new Error('azure.account 가 설정되지 않았다');
          run(which('az'), [
            'storage', 'blob', 'download',
            '--account-name', account,
            '--container-name', bucket,
            '--name', key,
            '--file', localPath,
            '--auth-mode', 'login',
          ], { timeoutMs: 30_000 });
        }
      });
    },
    head(key) {
      const { bucket } = resolveBucket(config, key);
      if (config.provider === 'local') {
        const p = localObjectPath(config, bucket, key);
        if (!existsSync(p)) return { exists: false };
        try {
          const st = statSync(p, { bigint: true });
          return { exists: true, bytes: Number(st.size), generation: `${st.dev}:${st.ino}:${st.mtimeNs}` };
        } catch {
          return { exists: false };
        }
      }
      try {
        if (config.provider === 's3' || config.provider === 'r2') {
          const out = run(which('aws'), ['s3api', 'head-object', '--bucket', bucket, '--key', key, ...awsExtra(config)], { timeoutMs: 30_000 });
          let bytes: number | undefined;
          let generation: string | undefined;
          try {
            const j = JSON.parse(out.stdout) as { ContentLength?: number; VersionId?: string };
            if (typeof j.ContentLength === 'number') bytes = j.ContentLength;
            if (typeof j.VersionId === 'string' && j.VersionId !== '' && j.VersionId !== 'null') generation = j.VersionId; // 버전 미활성이면 없음 · "null"(중단 버킷 널 버전)은 덮어써지므로 결속 불가 — 어느 쪽이든 생략해 소비층에서 거부 (terra mustFix ①)
          } catch { /* 크기 없으면 생략 */ }
          return { exists: true, ...(bytes !== undefined ? { bytes } : {}), ...(generation !== undefined ? { generation } : {}) };
        }
        if (config.provider === 'gcs') {
          const out = run(which('gcloud'), ['storage', 'objects', 'describe', `gs://${bucket}/${key}`, '--format=json'], { timeoutMs: 30_000 });
          let bytes: number | undefined;
          let generation: string | undefined;
          try {
            const j = JSON.parse(out.stdout) as { size?: string | number; generation?: string | number };
            if (j.size !== undefined) bytes = Number(j.size);
            // GCS 는 객체마다 항상 세대가 있다. 최상위 generation 만 본다(JSON.parse 는 구조적 — 중첩 필드 오독 없음).
            // number 는 안전 정수(2^53-1) 범위일 때만 문자열화한다 — 범위를 넘으면 double 반올림으로 서로 다른 세대가
            // 한 세대로 합쳐지므로 생략해 소비층에서 결속 거부하게 한다 (terra mustFix ②·r2).
            if (typeof j.generation === 'string' && j.generation !== '') generation = j.generation;
            else if (typeof j.generation === 'number' && Number.isSafeInteger(j.generation)) generation = `${j.generation}`;
            else if (j.generation !== undefined) generation = undefined; // 안전하게 표현 불가 — 생략
          } catch { /* 크기 없으면 생략 */ }
          return { exists: true, ...(bytes !== undefined && Number.isFinite(bytes) ? { bytes } : {}), ...(generation !== undefined ? { generation } : {}) };
        }
        if (config.provider === 'azure') {
          const account = config.azure?.account ?? '';
          if (!account) throw new Error('azure.account 가 설정되지 않았다');
          const out = run(which('az'), [
            'storage', 'blob', 'show',
            '--account-name', account,
            '--container-name', bucket,
            '--name', key,
            '--auth-mode', 'login',
          ], { timeoutMs: 30_000 });
          let bytes: number | undefined;
          try {
            const j = JSON.parse(out.stdout) as { properties?: { contentLength?: number } };
            if (typeof j.properties?.contentLength === 'number') bytes = j.properties.contentLength;
          } catch { /* 크기 없으면 생략 */ }
          return { exists: true, ...(bytes !== undefined ? { bytes } : {}) };
        }
      } catch {
        return { exists: false };
      }
      return { exists: false };
    },
    list(prefix) {
      const { bucket } = resolveBucket(config, prefix || 'x');
      if (config.provider === 'local') {
        const root = join(config.localDir, bucket);
        const all: string[] = [];
        walkFiles(root, '', all);
        const p = prefix.replace(/^\/+|\/+$/g, '');
        return all.filter((k) => !p || k === p || k.startsWith(`${p}/`) || k.startsWith(p));
      }
      if (config.provider === 's3' || config.provider === 'r2') {
        const out = run(which('aws'), ['s3', 'ls', `s3://${bucket}/${prefix}`, '--recursive', ...awsExtra(config)], { timeoutMs: 30_000 });
        return out.stdout.split('\n').map((line) => {
          const m = line.trim().match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\d+\s+(.+)$/);
          return m ? m[1]! : '';
        }).filter(Boolean);
      }
      if (config.provider === 'gcs') {
        const out = run(which('gcloud'), ['storage', 'ls', `gs://${bucket}/${prefix}`], { timeoutMs: 30_000 });
        const base = `gs://${bucket}/`;
        return out.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.startsWith(base) ? l.slice(base.length) : l);
      }
      if (config.provider === 'azure') {
        const account = config.azure?.account ?? '';
        if (!account) throw new Error('azure.account 가 설정되지 않았다');
        const out = run(which('az'), [
          'storage', 'blob', 'list',
          '--account-name', account,
          '--container-name', bucket,
          '--prefix', prefix,
          '--auth-mode', 'login',
        ], { timeoutMs: 30_000 });
        try {
          const arr = JSON.parse(out.stdout) as Array<{ name?: string }>;
          return arr.map((o) => o.name ?? '').filter(Boolean);
        } catch {
          throw new Error('azure storage blob list returned invalid JSON');
        }
      }
      return [];
    },
    publicUrl(key) {
      if (!isPublicKey(key)) return null;
      if (!config.publicBucket) return null;
      const encoded = key.split('/').map(encodeURIComponent).join('/');
      if (config.provider === 's3') return `https://${config.publicBucket}.s3.amazonaws.com/${encoded}`;
      if (config.provider === 'r2') {
        const id = config.r2?.accountId;
        if (!id) return null;
        return `https://${config.publicBucket}.${id}.r2.cloudflarestorage.com/${encoded}`;
      }
      if (config.provider === 'gcs') return `https://storage.googleapis.com/${config.publicBucket}/${encoded}`;
      if (config.provider === 'azure') {
        const account = config.azure?.account;
        if (!account) return null;
        return `https://${account}.blob.core.windows.net/${config.publicBucket}/${encoded}`;
      }
      return null;
    },
  };
}

/** 테스트·진단용. 설정 파일이 없으면 빈 설정(= local). */
export function readRawConfig(configPath: string): { storage?: RawStorage } | null {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as { storage?: RawStorage };
  } catch {
    return null;
  }
}
