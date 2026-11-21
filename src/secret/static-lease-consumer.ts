/**
 * HQ-VAULT V3 — 정적 키 임대의 «소비자 쪽» 집행 (HQ-CREDENTIAL-VAULT.md §3.2 «resolver 가 집행한다» · §3.7).
 *
 * 받는 쪽(호스트 또는 격리 config-dir)에는 임대 사본과 메타가 놓인다.
 *   <root>/secrets-lease/meta/<cacheName>.json   — 0600 · 값 0 · {leaseId, kind:'static', id, expiresAt, revokedAt?, copyPath}
 *   사본 = config-dir 대상이면 <root>/secrets-lease/copies/<cacheName> · 호스트 대상이면 ~/.cache/<cacheName>(과도기 호환 덮어쓰기)
 *
 * 키를 읽는 길(`src/config.ts` 의 키 캐시 해석기)은 이 모듈을 먼저 부른다.
 *   - 살아 있는 임대 → 사본 값을 돌려준다.
 *   - 만료·회수·사본 없음·메타 깨짐 → `StaticLeaseExpiredError` 를 «던진다» ⊕ `secret.lease.expired` 사건 1회.
 *     ⛔ «없음»으로 접어 env·옛 캐시로 조용히 넘어가지 않는다(TC CRED-PUSH 리뷰 2번 · 설계 §3.7).
 *   - 임대 메타가 없으면 `null` — 종전 키 캐시 규약 그대로.
 *
 * 이 모듈은 node 내장만 쓴다(config.ts 가 부팅 초기에 부른다). 값은 반환값 밖 어디에도 싣지 않는다.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { prodInstanceRoot } from '../instance/resolve.js';

export const STATIC_LEASE_AREA_DIR = 'secrets-lease';
export const STATIC_LEASE_META_DIR = 'meta';
export const STATIC_LEASE_COPIES_DIR = 'copies';
export const STATIC_LEASE_COPY_FORMAT = 'elanous-static-lease-copy/v1';

/** 키 캐시 파일 이름 규약(`XAI_API_KEY` → `xai_api_key`)과 같은 꼴만 받는다 — 경로 탈출 0. */
export const CACHE_NAME_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;

export type StaticLeaseFailureReason = 'expired' | 'revoked' | 'copy-missing' | 'invalid';

/** 받는 쪽 메타(값 0). 호스트 쪽 설치 스크립트가 같은 칸을 쓴다(`static-lease.ts` REMOTE_*). */
export interface StaticLeaseCopyMeta {
  format: typeof STATIC_LEASE_COPY_FORMAT;
  leaseId: string;
  kind: 'static';
  id: string;
  cacheName: string;
  target: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  copyPath: string;
}

export interface ActiveStaticLease {
  leaseId: string;
  id: string;
  cacheName: string;
  expiresAtMs: number;
  root: string;
}

/** 시끄러운 실패 — 호출부가 `instanceof` 로 «자격 없음 · 임대 만료»를 «키 없음»과 가른다. 메시지에 값 0. */
export class StaticLeaseExpiredError extends Error {
  readonly code = 'ELANOUS_STATIC_LEASE_EXPIRED' as const;
  constructor(
    readonly reason: StaticLeaseFailureReason,
    readonly cacheName: string,
    readonly leaseId: string | undefined,
    readonly expiresAt: string | undefined,
  ) {
    super(`자격 없음 · 정적 키 임대 ${reason === 'revoked' ? '회수됨' : reason === 'expired' ? '만료' : reason === 'copy-missing' ? '사본 없음' : '메타 손상'}`
      + ` · ${cacheName}${leaseId ? ` · lease ${leaseId}` : ''}${expiresAt ? ` · expiresAt ${expiresAt}` : ''}`
      + ' · 조용한 폴백 없음 — 금고 호스트에서 `eln secret lease <id> --to <대상> --renew` 로 다시 임대하라');
    this.name = 'StaticLeaseExpiredError';
  }
}

export interface StaticLeaseConsumerDeps {
  /** 살펴볼 임대 뿌리(앞이 우선). 보통 [현재 config-dir, ~/.elanous]. */
  roots: readonly string[];
  /** 이 프로세스가 임대 메타가 없을 때 읽었을 키 캐시 파일(절대 경로). 호스트 사본은 이 경로와 같을 때만 적용된다. */
  cacheFilePath: string;
  now?: () => number;
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
  log?: (category: string, event: string, data: Record<string, unknown>, level: 'error') => void;
}

function privateRegularFile(st: Stats): boolean {
  return st.isFile() && (process.platform === 'win32' || (st.mode & 0o777) === 0o600)
    && (typeof process.getuid !== 'function' || st.uid === process.getuid());
}

/** Keep the checked inode open while reading; a concurrent symlink swap cannot redirect the copy. */
function readPrivateFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!privateRegularFile(fstatSync(fd))) throw new Error('ELANOUS_STATIC_LEASE_FILE_UNSAFE');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

const loggedFailures = new Set<string>();

/** 시험 seam — 같은 임대·이유의 경보 1회 묶음을 비운다. */
export function _resetStaticLeaseConsumerForTests(): void { loggedFailures.clear(); }

function defaultLog(category: string, event: string, data: Record<string, unknown>, level: 'error'): void {
  try {
    const { debug } = require('../debug/log.js') as { debug: { log: (c: string, e: string, d: unknown, o?: { level?: 'error' }) => void } };
    debug.log(category, event, data, { level });
  } catch { /* 관측 실패가 집행(던짐)을 바꾸지 않는다 */ }
}

export function staticLeaseMetaPath(root: string, cacheName: string): string {
  return join(root, STATIC_LEASE_AREA_DIR, STATIC_LEASE_META_DIR, `${cacheName}.json`);
}

export function staticLeaseCopyPath(root: string, cacheName: string): string {
  return join(root, STATIC_LEASE_AREA_DIR, STATIC_LEASE_COPIES_DIR, cacheName);
}

function parseMeta(raw: string, cacheName: string): StaticLeaseCopyMeta | null {
  try {
    const m = JSON.parse(raw) as Partial<StaticLeaseCopyMeta>;
    if (!m || typeof m !== 'object' || m.format !== STATIC_LEASE_COPY_FORMAT || m.kind !== 'static') return null;
    if (typeof m.leaseId !== 'string' || !m.leaseId || typeof m.id !== 'string' || m.cacheName !== cacheName) return null;
    if (typeof m.expiresAt !== 'string' || !Number.isFinite(Date.parse(m.expiresAt))) return null;
    if (typeof m.copyPath !== 'string' || !m.copyPath.startsWith('/')) return null;
    if (m.revokedAt !== undefined && typeof m.revokedAt !== 'string') return null;
    return m as StaticLeaseCopyMeta;
  } catch { return null; }
}

/**
 * 임대 사본 해석. 임대가 없으면 `null`, 살아 있으면 값 ⊕ 임대 요약, 죽었으면 `StaticLeaseExpiredError` 를 던진다.
 * ⛔ 값은 반환값으로만 나간다 — 사건·오류 메시지에는 이름·leaseId·시각만.
 */
export function resolveStaticLeaseCopy(
  cacheName: string,
  deps: StaticLeaseConsumerDeps,
): { value: string; lease: ActiveStaticLease } | null {
  if (!CACHE_NAME_PATTERN.test(cacheName)) return null;
  const now = deps.now ?? Date.now;
  const readFile = deps.readFile ?? readPrivateFile;
  const log = deps.log ?? defaultLog;
  const cacheFile = resolve(deps.cacheFilePath);
  const seen = new Set<string>();
  for (const rawRoot of deps.roots) {
    const root = resolve(rawRoot);
    if (seen.has(root)) continue;
    seen.add(root);
    const metaPath = staticLeaseMetaPath(root, cacheName);
    const fail = (reason: StaticLeaseFailureReason, meta: StaticLeaseCopyMeta | null): never => {
      const key = `${root}:${cacheName}:${meta?.leaseId ?? '-'}:${reason}`;
      if (!loggedFailures.has(key)) {
        loggedFailures.add(key);
        log('secret', 'secret.lease.expired', {
          kind: 'static', id: meta?.id, cacheName, leaseId: meta?.leaseId, expiresAt: meta?.expiresAt,
          revokedAt: meta?.revokedAt, reason, root,
        }, 'error');
      }
      throw new StaticLeaseExpiredError(reason, cacheName, meta?.leaseId, meta?.expiresAt);
    };
    if (deps.exists) {
      try { if (!deps.exists(metaPath)) continue; } catch { return fail('invalid', null); }
    }
    let metaStat: Stats;
    try { metaStat = lstatSync(metaPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return fail('invalid', null);
    }
    if (!privateRegularFile(metaStat)) return fail('invalid', null);
    let meta: StaticLeaseCopyMeta | null;
    try { meta = parseMeta(readFile(metaPath), cacheName); } catch { meta = null; }
    if (!meta) return fail('invalid', null);
    // 인스턴스 사본은 메타의 바로 그 root 에 결속한다. realpath 는
    // macOS /tmp→/private/tmp 별칭을 수용하면서 다른 인스턴스와 디렉터리 링크를 거부한다.
    let ownCopy = false;
    try {
      ownCopy = basename(meta.copyPath) === cacheName
        && realpathSync(dirname(meta.copyPath)) === join(realpathSync(root), STATIC_LEASE_AREA_DIR, STATIC_LEASE_COPIES_DIR);
    } catch { /* 존재하지 않거나 읽을 수 없는 복사 디렉터리는 아래에서 거부 */ }
    // 호스트 사본은 이 root 가 실제 운영 HOME 의 .elanous 일 때만 허용한다.
    // 격리 캐시를 보는 프로세스에서는 운영 집의 별개 임대를 건너뛴다.
    const operatingRoot = resolve(prodInstanceRoot());
    let operatingRootMatches = false;
    try { operatingRootMatches = realpathSync(root) === realpathSync(operatingRoot); } catch { /* 운영 root 없음 = 호스트 예외 없음 */ }
    const hostCopy = operatingRootMatches
      ? resolve(dirname(operatingRoot), '.cache', cacheName) : undefined;
    if (!ownCopy && hostCopy && resolve(meta.copyPath) === hostCopy && cacheFile !== hostCopy) continue;
    if (!ownCopy && !(hostCopy && resolve(meta.copyPath) === hostCopy && cacheFile === hostCopy)) return fail('invalid', meta);
    if (meta.revokedAt) return fail('revoked', meta);
    const expiresAtMs = Date.parse(meta.expiresAt);
    if (now() >= expiresAtMs) return fail('expired', meta);
    let copyStat: Stats;
    try { copyStat = lstatSync(meta.copyPath); }
    catch (error) {
      return fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'copy-missing' : 'invalid', meta);
    }
    if (!privateRegularFile(copyStat)) return fail('invalid', meta);
    let value = '';
    try { value = readFile(meta.copyPath).trim().replace(/^["']|["']$/g, ''); } catch { return fail('invalid', meta); }
    if (!value) return fail('copy-missing', meta);
    // The issuer replaces metadata atomically on renewal/revoke. Re-read after
    // the copy so a cancellation or expiry during I/O cannot release a stale key.
    let latest: StaticLeaseCopyMeta | null;
    try { latest = parseMeta(readFile(metaPath), cacheName); } catch { latest = null; }
    if (!latest) return fail('invalid', meta);
    if (latest.revokedAt) return fail('revoked', latest);
    if (latest.leaseId !== meta.leaseId || latest.id !== meta.id
      || latest.copyPath !== meta.copyPath || latest.expiresAt !== meta.expiresAt) return fail('invalid', latest);
    if (now() >= expiresAtMs) return fail('expired', latest);
    return { value, lease: { leaseId: meta.leaseId, id: meta.id, cacheName, expiresAtMs, root } };
  }
  return null;
}
