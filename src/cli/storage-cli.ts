import type { Command } from 'commander';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import type { CliBinDeps } from '../storage/cli-bin.js';
import {
  createObjectStore,
  readRawConfig,
  resolveBucket,
  resolveStorageConfig,
  type ObjectStore,
  type RunFn,
  type StorageConfig,
  type StorageProvider,
} from '../storage/object-store.js';
import {
  detectStorageProviders,
  type StorageCommandResult,
  type StorageDetectDeps,
  type StorageProviderDetect,
} from '../storage/storage-detect.js';

export interface StorageDetectOptions {
  json?: boolean;
}

export interface StorageDetectCliDeps {
  detect?: (deps: StorageDetectDeps) => Promise<StorageProviderDetect[]>;
  currentProvider?: () => string;
  output?: (line: string) => void;
  /** 테스트가 가짜 run 을 주입한다. 없으면 실제 자식 프로세스. */
  run?: StorageDetectDeps['run'];
  which?: StorageDetectDeps['which'];
  platform?: NodeJS.Platform;
  home?: string;
  localWritable?: boolean;
}

export interface StorageDetectCliResult {
  providers: StorageProviderDetect[];
  current: string;
}

const DETECT_TIMEOUT_MS = 8000;

/** 자식 프로세스 한 번. 시간 초과·실행 불가는 timedOut — 로그인 안 됨이 아니다. */
export function execStorageCommand(bin: string, args: string[], opts: { timeoutMs: number }): Promise<StorageCommandResult> {
  return new Promise((resolve) => {
    execFile(bin, args, {
      timeout: opts.timeoutMs || DETECT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const errno = (error as NodeJS.ErrnoException | null)?.code;
      const timedOut = errno === 'ETIMEDOUT' || /timed out/i.test(error?.message ?? '');
      const status = (error as (NodeJS.ErrnoException & { status?: number }) | null)?.status;
      const code = typeof status === 'number' ? status : error ? (timedOut ? 124 : 1) : 0;
      resolve({
        code,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        ...(timedOut || errno === 'ENOENT' ? { timedOut: true } : {}),
      });
    });
  });
}

function readCurrentProvider(): string {
  try {
    const raw = JSON.parse(readFileSync(join(getElanousConfigDir(), 'config.json'), 'utf8')) as {
      storage?: { provider?: unknown };
    };
    const value = raw?.storage?.provider;
    return typeof value === 'string' && value.trim() ? value.trim() : 'local';
  } catch {
    return 'local';
  }
}

function mark(row: StorageProviderDetect): string {
  if (row.provider !== 'local' && row.cli.path === null) return '✖';
  if (row.signedIn === true) return '✅';
  return '⚪';
}

function statusWords(row: StorageProviderDetect): string {
  if (row.provider === 'local') return row.signedIn === true ? '사용 가능' : '확인 불가';
  if (row.cli.path === null) return '없음';
  if (row.signedIn === true) return '로그인됨';
  if (row.signedIn === false) return '설치됨·로그인 안 됨';
  return '설치됨·로그인 모름';
}

export function formatStorageDetectLine(row: StorageProviderDetect): string {
  const account = row.account ? ` · ${row.account}` : '';
  const project = row.project ? ` · ${row.project}` : '';
  const buckets = row.bucketCount !== null ? ` · buckets ${row.bucketCount}` : '';
  const hint = row.hint ? ` · ${row.hint}` : '';
  return `${mark(row)} ${row.provider}  ${statusWords(row)}${account}${project}${buckets}${hint}`;
}

export async function runStorageDetect(
  options: StorageDetectOptions = {},
  deps: StorageDetectCliDeps = {},
): Promise<StorageDetectCliResult> {
  const output = deps.output ?? console.log;
  const detect = deps.detect ?? detectStorageProviders;
  const providers = await detect({
    run: deps.run ?? execStorageCommand,
    ...(deps.which ? { which: deps.which } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.localWritable !== undefined ? { localWritable: deps.localWritable } : {}),
  });
  const current = (deps.currentProvider ?? readCurrentProvider)();
  const result: StorageDetectCliResult = { providers, current };
  if (options.json) {
    output(JSON.stringify(result));
    return result;
  }
  for (const row of providers) output(formatStorageDetectLine(row));
  output(`지금 설정: storage.provider = ${current}`);
  return result;
}

export function registerStorageDetectCommand(program: Command): void {
  const storage = program.command('storage').description('저장소 공급자');
  storage.command('detect')
    .description('이 기계의 클라우드 CLI 와 로그인 계정·기본 프로젝트를 값 노출 없이 보여 준다')
    .option('--json', 'JSON 출력')
    .action(async (opts: StorageDetectOptions) => {
      await runStorageDetect(opts);
    });
  storage.command('put')
    .description('파일 하나를 올리거나 로컬 폴더에 놓는다')
    .argument('<file>', '올릴 파일')
    .option('--key <key>', '객체 키')
    .option('--public', '공개 버킷에 올린다')
    .option('--local-dir <dir>', 'local 일 때 복사할 폴더')
    .option('--json', 'JSON 출력')
    .action(async (file: string, opts: StoragePutOptions) => {
      const code = await runStoragePut(file, opts);
      if (code !== 0) process.exitCode = code;
    });
}

export interface StoragePutOptions {
  key?: string;
  public?: boolean;
  localDir?: string;
  json?: boolean;
}

export type StoragePutResult =
  | { kind: 'path'; path: string; provider: StorageProvider }
  | { kind: 'url'; url: string; provider: StorageProvider }
  | { kind: 'object'; uri: string; provider: StorageProvider };

export interface StoragePutCliDeps {
  configDir?: string;
  readConfig?: (configDir: string) => StorageConfig;
  store?: ObjectStore;
  /** store 를 안 줄 때 createObjectStore 에 넘긴다. 가짜 CLI 경로. */
  cliBin?: CliBinDeps;
  run?: RunFn;
  output?: (line: string) => void;
  error?: (line: string) => void;
  now?: () => Date;
  copyFile?: (src: string, dest: string) => void;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => Buffer;
  mkdir?: (path: string) => void;
}

function defaultReadConfig(configDir: string): StorageConfig {
  return resolveStorageConfig(readRawConfig(join(configDir, 'config.json')));
}

function ymd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function safeName(file: string): string {
  const name = basename(file).replace(/[/\\]/g, '');
  return name.length > 0 ? name : 'file';
}

/** 같은 이름이 있고 내용이 다르면 -1, -2 … 를 붙인다. 같으면 그 경로. */
export function uniqueCopyName(
  dir: string,
  fileName: string,
  sourceBytes: Buffer,
  exists: (path: string) => boolean,
  readFile: (path: string) => Buffer,
): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  const candidate = (n: number) => (n === 0 ? fileName : `${stem}-${n}${ext}`);
  for (let n = 0; n < 10_000; n += 1) {
    const path = join(dir, candidate(n));
    if (!exists(path)) return path;
    try {
      if (readFile(path).equals(sourceBytes)) return path;
    } catch { /* 읽기 실패면 다음 번호 */ }
  }
  throw new Error('이름 충돌을 풀 수 없다');
}

/** `--public` 은 공개 버킷 URL. 키의 공개 기능 여부와 무관하다(버킷이 공개다). */
function publicUrlFor(cfg: StorageConfig, key: string): string {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  const bucket = cfg.publicBucket;
  if (cfg.provider === 's3') return `https://${bucket}.s3.amazonaws.com/${encoded}`;
  if (cfg.provider === 'r2') return `https://${bucket}.${cfg.r2?.accountId ?? ''}.r2.cloudflarestorage.com/${encoded}`;
  if (cfg.provider === 'gcs') return `https://storage.googleapis.com/${bucket}/${encoded}`;
  if (cfg.provider === 'azure') return `https://${cfg.azure?.account ?? ''}.blob.core.windows.net/${bucket}/${encoded}`;
  return encoded;
}

function objectUri(cfg: StorageConfig, bucket: string, key: string): string {
  if (cfg.provider === 'gcs') return `gs://${bucket}/${key}`;
  if (cfg.provider === 's3' || cfg.provider === 'r2') return `s3://${bucket}/${key}`;
  if (cfg.provider === 'azure') {
    const account = cfg.azure?.account ?? '';
    return `https://${account}.blob.core.windows.net/${bucket}/${key}`;
  }
  return `${bucket}/${key}`;
}

function failLine(message: string): string {
  return message.replace(/[A-Za-z0-9+/]{20,}={0,2}/g, '[redacted]');
}

/** 파일 하나를 올리거나 놓는다. 0 = 성공 · 1 = 실패 · 2 = 공개 버킷 없음. 빈 설정은 원격 CLI 를 부르지 않는다. */
export async function runStoragePut(
  file: string,
  options: StoragePutOptions = {},
  deps: StoragePutCliDeps = {},
): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path));
  const copyFile = deps.copyFile ?? ((src: string, dest: string) => { copyFileSync(src, dest); });
  const mkdir = deps.mkdir ?? ((path: string) => { mkdirSync(path, { recursive: true }); });
  const now = deps.now ?? (() => new Date());

  if (!exists(file)) {
    error(`파일이 없다: ${file}`);
    return 1;
  }

  let cfg: StorageConfig;
  try {
    cfg = deps.readConfig
      ? deps.readConfig(deps.configDir ?? getElanousConfigDir())
      : defaultReadConfig(deps.configDir ?? getElanousConfigDir());
  } catch (e) {
    error(failLine(e instanceof Error ? e.message : String(e)));
    return 1;
  }

  const name = safeName(file);
  const explicitKey = options.key?.replace(/^\/+|\/+$/g, '') ?? '';
  const publicFlag = options.public === true;

  if (cfg.provider === 'local') {
    let dest: string;
    if (options.localDir) {
      try {
        mkdir(options.localDir);
        dest = uniqueCopyName(options.localDir, name, readFile(file), exists, readFile);
        copyFile(file, dest);
      } catch (e) {
        error(failLine(e instanceof Error ? e.message : String(e)));
        return 1;
      }
    } else {
      const key = explicitKey || name;
      const store = deps.store ?? createObjectStore(cfg, {
        ...(deps.run ? { run: deps.run } : {}),
        ...(deps.cliBin ? { cliBin: deps.cliBin } : {}),
      });
      try {
        store.put(key, file);
      } catch (e) {
        error(failLine(e instanceof Error ? e.message : String(e)));
        return 1;
      }
      const { bucket } = resolveBucket(cfg, key);
      const clean = key.split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
      dest = join(cfg.localDir, bucket, clean);
    }
    const result: StoragePutResult = { kind: 'path', path: dest, provider: 'local' };
    output(options.json ? JSON.stringify(result) : dest);
    return 0;
  }

  if (publicFlag && !cfg.publicBucket) {
    error('storage.publicBucket 이 설정되지 않았다');
    return 2;
  }

  const key = explicitKey || `${cfg.prefix || 'monad'}/uploads/${ymd(now())}/${name}`;
  const store = deps.store ?? createObjectStore(cfg, {
    ...(deps.run ? { run: deps.run } : {}),
    ...(deps.cliBin ? { cliBin: deps.cliBin } : {}),
  });
  try {
    store.put(key, file, publicFlag ? { public: true } : undefined);
  } catch (e) {
    error(failLine(e instanceof Error ? e.message : String(e)));
    return 1;
  }

  if (publicFlag) {
    const url = publicUrlFor(cfg, key);
    const result: StoragePutResult = { kind: 'url', url, provider: cfg.provider };
    output(options.json ? JSON.stringify(result) : url);
    return 0;
  }

  const { bucket } = resolveBucket(cfg, key);
  const uri = objectUri(cfg, bucket, key);
  const result: StoragePutResult = { kind: 'object', uri, provider: cfg.provider };
  output(options.json ? JSON.stringify(result) : uri);
  return 0;
}
