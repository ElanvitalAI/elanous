// 저장소 한 벌 — local(기본) · gcs · azure · s3 · r2 를 같은 인터페이스로.
// RFC 저장소 공급자 S1. 설정이 비면 원격 CLI 를 부르지 않는다.
// 자격·서명 URL 은 관측에 싣지 않는다.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
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
  gcs?: { project: string };
  azure?: { account: string };
  s3?: { region?: string; profile?: string };
  r2?: { accountId: string; profile?: string };
}

export interface ObjectHead {
  exists: boolean;
  bytes?: number;
}

export interface PutOptions {
  contentType?: string;
  /** CLI `--public`. 키의 공개 기능 여부와 무관하게 공개 버킷. */
  public?: boolean;
}

export interface ObjectStore {
  provider: StorageProvider;
  put(key: string, body: string | Uint8Array, opts?: PutOptions): void;
  get(key: string, localPath: string): void;
  head(key: string): ObjectHead;
  list(prefix: string): string[];
  publicUrl(key: string): string | null;
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

function logOp(event: 'put' | 'get' | 'failed', data: { provider: StorageProvider; bucketKind: BucketKind; key: string; ms: number }): void {
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

  function timed<T>(event: 'put' | 'get', kind: BucketKind, key: string, fn: () => T): T {
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
      if (fileBody) {
        run(bin, ['storage', 'cp', body, uri, ...ct], { timeoutMs: 60_000 });
      } else {
        run(bin, ['storage', 'cp', '-', uri, ...ct], { input: asBytes(body), timeoutMs: 60_000 });
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
    get(key, localPath) {
      const { kind, bucket } = resolveBucket(config, key);
      timed('get', kind, key, () => {
        mkdirSync(dirname(localPath), { recursive: true });
        if (config.provider === 'local') {
          const src = localObjectPath(config, bucket, key);
          if (!existsSync(src)) throw new Error(`객체가 없다: ${key}`);
          copyFileSync(src, localPath);
          return;
        }
        if (config.provider === 's3' || config.provider === 'r2') {
          const bin = which('aws');
          run(bin, ['s3', 'cp', `s3://${bucket}/${key}`, localPath, '--quiet', ...awsExtra(config)], { timeoutMs: 30_000 });
          return;
        }
        if (config.provider === 'gcs') {
          run(which('gcloud'), ['storage', 'cp', `gs://${bucket}/${key}`, localPath], { timeoutMs: 30_000 });
          return;
        }
        if (config.provider === 'azure') {
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
          const st = statSync(p);
          return { exists: true, bytes: st.size };
        } catch {
          return { exists: false };
        }
      }
      try {
        if (config.provider === 's3' || config.provider === 'r2') {
          const out = run(which('aws'), ['s3api', 'head-object', '--bucket', bucket, '--key', key, ...awsExtra(config)], { timeoutMs: 30_000 });
          let bytes: number | undefined;
          try { const j = JSON.parse(out.stdout) as { ContentLength?: number }; if (typeof j.ContentLength === 'number') bytes = j.ContentLength; } catch { /* 크기 없으면 생략 */ }
          return { exists: true, ...(bytes !== undefined ? { bytes } : {}) };
        }
        if (config.provider === 'gcs') {
          const out = run(which('gcloud'), ['storage', 'objects', 'describe', `gs://${bucket}/${key}`, '--format=json'], { timeoutMs: 30_000 });
          let bytes: number | undefined;
          try {
            const j = JSON.parse(out.stdout) as { size?: string | number };
            if (j.size !== undefined) bytes = Number(j.size);
          } catch { /* 크기 없으면 생략 */ }
          return { exists: true, ...(bytes !== undefined && Number.isFinite(bytes) ? { bytes } : {}) };
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
          return [];
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
