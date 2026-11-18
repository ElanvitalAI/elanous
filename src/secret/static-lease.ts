/**
 * HQ-VAULT V3 — 정적 API 키 임대 (`eln secret lease <id> --to <host|config-dir>`).
 * 🔗 설계 = 내부 문서 `HQ-CREDENTIAL-VAULT` §3.2(정적 키 임대) · §3.7(실패 시 행동) · §6(cred-push.sh 흡수) · §8 D1(수명).
 *
 * 흐름(금고 호스트 = 이 프로세스):
 *   ① 항목 해석 — 카탈로그 `api-key` 줄(또는 ZAI 같은 확인된 소비자 이름)만. OAuth·구독·CLI·다중 칸은 거부.
 *   ② 대상 확인 — 호스트: 허용 목록(allowedHosts) ⊕ tailnet 피어 신원 · config-dir: 알려진 뿌리 아래 실재 디렉터리.
 *   ③ 값 원천 — 이 호스트의 비밀 저장소 → 키 캐시 파일(임대 사본은 원천이 될 수 없다 · env 는 원천 아님).
 *   ④ 사본 쓰기 — 0600 · 임시 파일 → rename · 메타 {leaseId, kind:'static', id, target, issuedAt, expiresAt}.
 *      호스트 대상은 tailnet MagicDNS 이름으로 ssh 하고 값은 stdin 에만 싣는다(argv·셸 문자열 0).
 *   ⑤ 원장 — `<config>/secret-lease-ledger/static/<leaseId>.json` · 값 0(지문 sha256 앞 8자만).
 *   ⑥ 사건 — 범주 `secret` · `secret.lease.issued|renewed|revoked|expired|refused` ⊕ `kind:'static'` (V2 OAuth 임대와 같은 이름).
 *
 * 받는 쪽 집행(만료 → 시끄러운 오류)은 `static-lease-consumer.ts` ⊕ `src/config.ts` 키 캐시 해석기.
 * 새 상주 프로세스 0 — 갱신은 한 번(`--renew`) 또는 끝나는 until 고리(`--renew --until`)뿐.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { prodInstanceRoot } from '../instance/resolve.js';
import { dirname, join, resolve, sep } from 'node:path';
import { SERVICE_KEY_CATALOG } from '../setup/service-key-catalog.js';
import {
  CACHE_NAME_PATTERN, STATIC_LEASE_AREA_DIR, STATIC_LEASE_COPIES_DIR, STATIC_LEASE_COPY_FORMAT, STATIC_LEASE_META_DIR,
  resolveStaticLeaseCopy, staticLeaseCopyPath, staticLeaseMetaPath, type StaticLeaseCopyMeta,
} from './static-lease-consumer.js';

// ── 수명 ─────────────────────────────────────────────────────────────────────

/** 정적 임대 기본 수명 24시간 — 출처: HQ-CREDENTIAL-VAULT.md §8 열린 결정 D1 제안(«24시간 · 50% 갱신»).
 *  대표/OP 가 D1 을 확정하면 이 상수만 바꾼다(회전·수명 정책 변경 = 사람 승인 · 설계 §4-3). */
export const STATIC_LEASE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** 갱신 시점 = 수명의 50% (같은 D1 제안). */
export const STATIC_LEASE_RENEW_FRACTION = 0.5;
/** 수명 상한 — 손으로 넣은 `--ttl` 이 «짧은 수명» 계약을 깨지 않게 한다. */
export const STATIC_LEASE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const STATIC_LEASE_MIN_TTL_MS = 60 * 1000;

export const STATIC_LEASE_RECORD_FORMAT = 'elanous-secret-lease/v1';
export const STATIC_LEASE_LEDGER_DIR = join('secret-lease-ledger', 'static');
export const STATIC_LEASE_POLICY_FILE = 'secret-lease-policy.json';

// ── 형 ──────────────────────────────────────────────────────────────────────

export type StaticLeaseTargetType = 'host' | 'config-dir';

/** 임대 원장 한 줄 — 값 0. V2(OAuth) 레코드와 공통 칸: {leaseId, kind, provider|id, target, issuedAt, expiresAt, revokedAt?}. */
export interface StaticLeaseRecord {
  format: typeof STATIC_LEASE_RECORD_FORMAT;
  leaseId: string;
  kind: 'static';
  id: string;
  envName: string;
  cacheName: string;
  target: string;
  targetType: StaticLeaseTargetType;
  issuedAt: string;
  expiresAt: string;
  ttlMs: number;
  renewedAt?: string;
  revokedAt?: string;
  revokePending?: boolean;
  /** sha256(값) 앞 8자 — 회전 대조용(설계 §3.5). 값 자체는 없다. */
  fingerprint8: string;
  targetIdentity?: { tailnetName: string; nodeKeyFingerprint8?: string };
}

export type StaticLeaseRefusalReason =
  | 'unknown-item' | 'not-static' | 'ambiguous-item' | 'invalid-target'
  | 'not-allowlisted' | 'not-tailnet' | 'tailnet-unmeasured'
  | 'config-dir-outside-roots' | 'config-dir-missing'
  | 'source-missing' | 'source-is-lease' | 'invalid-ttl' | 'transport-failed' | 'write-failed' | 'not-found'
  | 'revoked' | 'expired';

export type StaticLeaseResult =
  | { ok: true; action: 'issued' | 'renewed' | 'fresh'; record: StaticLeaseRecord }
  | { ok: false; reason: StaticLeaseRefusalReason; id: string; target: string; detail: string };

export interface StaticLeaseItem { id: string; envName: string; cacheName: string; sourceIds: readonly string[] }

export interface StaticLeasePolicy { allowedHosts: readonly string[] }

export interface TailnetPeerIdentity { hostName: string; dnsName: string; ips: readonly string[]; nodeKey?: string; online?: boolean }

export interface TransportResult { status: number | null; stderr?: string }

/** 원격 쓰기 이음매 — 값은 `stdin` 으로만 간다. `script` 는 고정 문자열(값 0). 시험은 가짜를 넣는다. */
export type StaticLeaseSshRunner = (dest: string, script: string, stdin: string, timeoutMs: number) => TransportResult;

export interface StaticLeaseDeps {
  /** 금고 호스트의 config 뿌리(원장·정책 파일). 기본 = 현재 config-dir. */
  configDir?: () => string;
  now?: () => number;
  newLeaseId?: () => string;
  /** 원천 값 읽기. 기본 = 비밀 저장소 → 키 캐시 파일(임대 사본 제외). */
  readSourceValue?: (item: StaticLeaseItem) => Promise<string | undefined | { refused: 'source-is-lease' }>;
  /** 항목별 허용 호스트. 기본 = `<config>/secret-lease-policy.json` (V1 메타 `allowHosts` 가 오면 그쪽으로 바꾼다). */
  policy?: (itemId: string) => StaticLeasePolicy;
  /** `tailscale status --json` 의 산출(JSON 파싱 전 문자열 또는 객체) · 못 물었으면 null. */
  tailnetStatus?: () => unknown;
  ssh?: StaticLeaseSshRunner;
  /** config-dir 대상이 들어가도 되는 뿌리. 기본 = ~/.elanous · ~/.elanous-* · ~/elanous-hq. */
  knownConfigRoots?: () => readonly string[];
  log?: (category: string, event: string, data: Record<string, unknown>, level: 'info' | 'warn' | 'error') => void;
  sleep?: (ms: number) => Promise<void>;
}

// ── 항목 ────────────────────────────────────────────────────────────────────

/** 카탈로그 밖이지만 소비자가 확인된 정적 키 — `src/llm/zai-coding-plan.ts:68` 가 `keyFromCacheOrEnv('ZAI_API_KEY')` 로 읽는다. */
const STATIC_LEASE_EXTRA_ITEMS: readonly { id: string; envName: string }[] = [{ id: 'zai', envName: 'ZAI_API_KEY' }];

/** `<id>` = 카탈로그 id · 환경 변수 이름 · `cred:` 슬롯 ID 중 하나. 결과는 키 캐시 파일 하나로 떨어져야 한다. */
export function resolveStaticLeaseItem(raw: string): StaticLeaseItem | { refused: StaticLeaseRefusalReason; detail: string } {
  const token = raw.trim();
  for (const extra of STATIC_LEASE_EXTRA_ITEMS) {
    if (token === extra.id || token === extra.envName) {
      return { id: extra.id, envName: extra.envName, cacheName: extra.envName.toLowerCase(), sourceIds: [extra.envName, extra.id] };
    }
  }
  const entry = SERVICE_KEY_CATALOG.find((e) => e.id === token || e.envNames.includes(token) || (e.storeIds ?? []).includes(token));
  if (!entry) return { refused: 'unknown-item', detail: '카탈로그 밖 이름은 임대하지 않는다(설계 §3.2 거부 목록)' };
  if (entry.kind !== 'api-key') return { refused: 'not-static', detail: `${entry.id} 는 ${entry.kind} — 정적 키가 아니다(OAuth 는 mirror lease · V2)` };
  const envName = entry.envNames.includes(token) ? token : entry.envNames.length === 1 ? entry.envNames[0]! : undefined;
  if (!envName) return { refused: 'ambiguous-item', detail: `${entry.id} 는 키 캐시 이름이 하나로 정해지지 않는다 — 환경 변수 이름으로 지정하라` };
  const cacheName = envName.toLowerCase();
  if (!CACHE_NAME_PATTERN.test(cacheName)) return { refused: 'unknown-item', detail: 'invalid cache name' };
  // 저장소 ID 는 칸이 하나인 항목에서만 원천으로 본다(다중 칸 항목의 슬롯을 다른 칸 값으로 잘못 짝짓지 않는다).
  const sourceIds = entry.envNames.length === 1 ? [...(entry.storeIds ?? []), envName, entry.id] : [envName];
  return { id: entry.id, envName, cacheName, sourceIds };
}

// ── 대상 ────────────────────────────────────────────────────────────────────

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;

export function parseStaticLeaseTarget(raw: string): { type: StaticLeaseTargetType; value: string } | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith('/') || t.startsWith('~') || t.startsWith('.')) {
    const expanded = t === '~' ? homedir() : t.startsWith('~/') ? join(homedir(), t.slice(2)) : t;
    return { type: 'config-dir', value: resolve(expanded) };
  }
  if (!HOST_PATTERN.test(t)) return null;
  return { type: 'host', value: t.toLowerCase() };
}

export function defaultKnownConfigRoots(): string[] {
  const home = homedir();
  const roots = [prodInstanceRoot(home), join(home, 'elanous-hq')];
  try {
    for (const name of readdirSync(home)) if (name.startsWith('.elanous-')) roots.push(join(home, name));
  } catch { /* HOME 못 읽음 — 기본 둘만 */ }
  return roots;
}

function within(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** 알려진 뿌리 아래 «실재하는» 디렉터리인가. 링크는 풀어서 다시 잰다(링크로 뿌리 밖 탈출 거부). */
export function checkConfigDirTarget(path: string, roots: readonly string[]): { ok: true; path: string } | { ok: false; reason: 'config-dir-outside-roots' | 'config-dir-missing' } {
  const abs = resolve(path);
  const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
  const realRoots = roots.map(real);
  if (!roots.some((r) => within(abs, resolve(r))) && !realRoots.some((r) => within(abs, r))) return { ok: false, reason: 'config-dir-outside-roots' };
  let st;
  try { st = statSync(abs); } catch { return { ok: false, reason: 'config-dir-missing' }; }
  if (!st.isDirectory()) return { ok: false, reason: 'config-dir-missing' };
  const realAbs = real(abs);
  if (!realRoots.some((r) => within(realAbs, r))) return { ok: false, reason: 'config-dir-outside-roots' };
  return { ok: true, path: realAbs };
}

/** `tailscale status --json` → 피어 신원들. 못 물었으면 null(빈 배열 = 물었는데 피어 0 — 서로 다르다). */
export function parseTailnetIdentities(status: unknown): TailnetPeerIdentity[] | null {
  let parsed = status;
  if (typeof status === 'string') { try { parsed = JSON.parse(status); } catch { return null; } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  if (!('Peer' in root) && !('Self' in root) && !('BackendState' in root)) return null;
  if (typeof root.BackendState === 'string' && root.BackendState !== 'Running') return null;
  const peers = root.Peer;
  if (peers === null || peers === undefined) return [];
  if (typeof peers !== 'object' || Array.isArray(peers)) return null;
  return Object.values(peers as Record<string, unknown>).map((v) => {
    const p = (v ?? {}) as { HostName?: unknown; DNSName?: unknown; TailscaleIPs?: unknown; PublicKey?: unknown; Online?: unknown };
    return {
      hostName: typeof p.HostName === 'string' ? p.HostName : '',
      dnsName: typeof p.DNSName === 'string' ? p.DNSName.replace(/\.$/, '') : '',
      ips: Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string') : [],
      ...(typeof p.PublicKey === 'string' ? { nodeKey: p.PublicKey } : {}),
      ...(typeof p.Online === 'boolean' ? { online: p.Online } : {}),
    };
  });
}

/** 이름이 같은 tailnet 피어 — HostName 또는 MagicDNS 첫 마디. ⛔ IP·ssh 별칭만으로는 신원이 아니다(check-same-origin.ts:33). */
export function findTailnetPeer(host: string, peers: readonly TailnetPeerIdentity[]): TailnetPeerIdentity | undefined {
  const want = host.toLowerCase();
  return peers.find((p) => p.hostName.toLowerCase() === want || p.dnsName.toLowerCase().split('.')[0] === want);
}

// ── 기본 의존 ───────────────────────────────────────────────────────────────

function sha8(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 8); }

function defaultConfigDir(): string {
  const { getElanousConfigDir } = require('../elanous-config-dir.js') as typeof import('../elanous-config-dir.js');
  return getElanousConfigDir();
}

function defaultLog(category: string, event: string, data: Record<string, unknown>, level: 'info' | 'warn' | 'error'): void {
  try {
    const { debug } = require('../debug/log.js') as { debug: { log: (c: string, e: string, d: unknown, o?: { level?: string }) => void } };
    debug.log(category, event, data, { level });
  } catch { /* 관측 실패는 임대 결과를 바꾸지 않는다 */ }
}

function defaultPolicy(configDir: string): (itemId: string) => StaticLeasePolicy {
  return (itemId) => {
    try {
      const raw = JSON.parse(readFileSync(join(configDir, STATIC_LEASE_POLICY_FILE), 'utf8')) as { items?: Record<string, { allowedHosts?: unknown }> };
      const hosts = raw.items?.[itemId]?.allowedHosts;
      return { allowedHosts: Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string').map((h) => h.toLowerCase()) : [] };
    } catch { return { allowedHosts: [] }; }   // 정책 없음 = 기본 거부
  };
}

function defaultTailnetStatus(): unknown {
  const r = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? r.stdout : null;
}

export const defaultStaticLeaseSsh: StaticLeaseSshRunner = (dest, script, stdin, timeoutMs) => {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ControlPath=none', dest, script], {
    encoding: 'utf8', timeout: timeoutMs, input: stdin, maxBuffer: 1024 * 1024,
  });
  return { status: r.status, stderr: (r.stderr ?? '').slice(-300) };
};

/** 원천 = 비밀 저장소 → 이 호스트의 키 캐시 파일. 키 캐시가 «임대 사본»이면 원천이 아니다(임대의 임대 금지). env 는 보지 않는다. */
async function defaultReadSourceValue(item: StaticLeaseItem): Promise<string | undefined | { refused: 'source-is-lease' }> {
  try {
    const secrets = await import('../nexus/config/secrets/index.js');
    secrets.selectBackendFromConfig();
    for (const id of item.sourceIds) {
      const v = await secrets.getSecretAsync(id);
      if (v && v.trim()) return v.trim();
    }
  } catch { /* 저장소 못 엶 → 키 캐시로 */ }
  const cacheDir = process.env.ELANOUS_KEY_CACHE_DIR?.trim() || join(homedir(), '.cache');
  const cacheFile = join(cacheDir, item.cacheName);
  try {
    const leased = resolveStaticLeaseCopy(item.cacheName, { roots: [defaultConfigDir(), prodInstanceRoot()], cacheFilePath: cacheFile });
    if (leased) return { refused: 'source-is-lease' };
  } catch { return { refused: 'source-is-lease' }; }
  try {
    const v = readFileSync(cacheFile, 'utf8').trim().replace(/^["']|["']$/g, '');
    return v || undefined;
  } catch { return undefined; }
}

function resolveDeps(deps: StaticLeaseDeps) {
  const configDir = (deps.configDir ?? defaultConfigDir)();
  return {
    configDir,
    now: deps.now ?? Date.now,
    newLeaseId: deps.newLeaseId ?? (() => `sl_${randomBytes(8).toString('hex')}`),
    readSourceValue: deps.readSourceValue ?? defaultReadSourceValue,
    policy: deps.policy ?? defaultPolicy(configDir),
    tailnetStatus: deps.tailnetStatus ?? defaultTailnetStatus,
    ssh: deps.ssh ?? defaultStaticLeaseSsh,
    knownConfigRoots: deps.knownConfigRoots ?? defaultKnownConfigRoots,
    log: deps.log ?? defaultLog,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
}
type Resolved = ReturnType<typeof resolveDeps>;

// ── 원장(값 0) ──────────────────────────────────────────────────────────────

function ledgerDir(configDir: string): string { return join(configDir, STATIC_LEASE_LEDGER_DIR); }

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, contents, { mode: 0o600, flag: 'wx' });
    chmodSync(temp, 0o600);
    // rename 은 링크를 «따라가지 않고» 바꿔 끼운다 — 사본 경로에 심은 링크로 밖에 쓰지 않는다.
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function writeStaticLeaseRecord(configDir: string, record: StaticLeaseRecord): void {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(record.leaseId)) throw new Error('invalid leaseId');
  atomicWrite(join(ledgerDir(configDir), `${record.leaseId}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

export function readStaticLeaseRecords(configDir: string): StaticLeaseRecord[] {
  const dir = ledgerDir(configDir);
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out: StaticLeaseRecord[] = [];
  for (const name of names) {
    try {
      const r = JSON.parse(readFileSync(join(dir, name), 'utf8')) as StaticLeaseRecord;
      if (r && r.format === STATIC_LEASE_RECORD_FORMAT && r.kind === 'static') out.push(r);
    } catch { /* 깨진 줄은 건너뛴다 — 목록은 관측일 뿐 */ }
  }
  return out.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
}

export type StaticLeaseStatus = 'active' | 'expired' | 'revoked' | 'revoke-pending';
export function staticLeaseStatus(record: StaticLeaseRecord, nowMs: number): StaticLeaseStatus {
  if (record.revokePending) return 'revoke-pending';
  if (record.revokedAt) return 'revoked';
  return nowMs >= Date.parse(record.expiresAt) ? 'expired' : 'active';
}

// ── 사본 쓰기 · 회수 (로컬 config-dir · 원격 호스트) ─────────────────────────

function copyMeta(record: StaticLeaseRecord, copyPath: string): StaticLeaseCopyMeta {
  return {
    format: STATIC_LEASE_COPY_FORMAT, leaseId: record.leaseId, kind: 'static', id: record.id, cacheName: record.cacheName,
    target: record.target, issuedAt: record.issuedAt, expiresAt: record.expiresAt, copyPath,
  };
}

function ensureLeaseArea(root: string): void {
  for (const dir of [join(root, STATIC_LEASE_AREA_DIR), join(root, STATIC_LEASE_AREA_DIR, STATIC_LEASE_META_DIR), join(root, STATIC_LEASE_AREA_DIR, STATIC_LEASE_COPIES_DIR)]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new Error('lease area is a symlink');
    chmodSync(dir, 0o700);
  }
}

/** config-dir 대상: 사본 → 메타 순서로 쓴다(메타가 새 수명을 말할 때 사본은 이미 새 값이다). */
export function writeLocalStaticLeaseCopy(root: string, record: StaticLeaseRecord, value: string): { copyPath: string; mode: number } {
  ensureLeaseArea(root);
  const copyPath = staticLeaseCopyPath(root, record.cacheName);
  atomicWrite(copyPath, `${value}\n`);
  atomicWrite(staticLeaseMetaPath(root, record.cacheName), `${JSON.stringify(copyMeta(record, copyPath))}\n`);
  return { copyPath, mode: statSync(copyPath).mode & 0o777 };
}

/** 회수: 메타의 leaseId 가 같을 때만(늦은 회수가 새 임대를 지우지 못한다) 사본을 지우고 tombstone 메타를 남긴다. */
export function revokeLocalStaticLeaseCopy(root: string, record: StaticLeaseRecord, revokedAt: string): 'removed' | 'stale' | 'absent' {
  const metaPath = staticLeaseMetaPath(root, record.cacheName);
  let meta: StaticLeaseCopyMeta;
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) as StaticLeaseCopyMeta; } catch { return 'absent'; }
  if (meta.leaseId !== record.leaseId) return 'stale';
  rmSync(staticLeaseCopyPath(root, record.cacheName), { force: true });
  atomicWrite(metaPath, `${JSON.stringify({ ...meta, revokedAt })}\n`);
  return 'removed';
}

/** 원격 설치 스크립트 — 고정 문자열(값 0). 입력은 stdin JSON 하나. 사본 = ~/.cache/<name>(과도기 호환 · 설계 §3.2) · 메타 = ~/.elanous/secrets-lease/meta.
 *  EXPIRES(~/.cache 사본 위치): 소비자 resolver 이주 칸마다 — HQ-CREDENTIAL-VAULT.md §6 «호스트별 ~/.cache/*_api_key» 줄. 이주 뒤 사본은 임대 영역(copies/)으로만. */
/** 원격 메타 영역 — «원격 호스트의 $HOME» 기준 상대 조각(이 프로세스의 집이 아니다 · `CODEX_LEASE_REMOTE_DIR` 과 같은 꼴).
 *  원격 스크립트 문자열 안에 `.elanous` 를 손으로 박지 않고 이 상수 하나에서 짓는다(격리 하드코딩 게이트). */
const STATIC_LEASE_REMOTE_META_SEGMENTS = ['.elanous', 'secrets-lease', 'meta'] as const;
const REMOTE_META_JOIN_ARGS = STATIC_LEASE_REMOTE_META_SEGMENTS.map((segment) => JSON.stringify(segment)).join(',');

export const REMOTE_STATIC_LEASE_SCRIPT = [
  'const fs=require("node:fs"),path=require("node:path"),os=require("node:os");',
  'const p=JSON.parse(fs.readFileSync(0,"utf8"));',
  'if(!p||!/^[a-z0-9][a-z0-9_]{0,63}$/.test(p.cacheName)||!/^[A-Za-z0-9_-]{4,64}$/.test(p.leaseId))process.exit(2);',
  `const home=os.homedir(),cacheDir=path.join(home,".cache"),area=path.join(home,${REMOTE_META_JOIN_ARGS}),copy=path.join(cacheDir,p.cacheName),metaPath=path.join(area,p.cacheName+".json");`,
  'const w=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true,mode:0o700});const t=f+"."+process.pid+".tmp";try{fs.writeFileSync(t,s,{mode:0o600,flag:"wx"});fs.chmodSync(t,0o600);fs.renameSync(t,f)}finally{try{fs.unlinkSync(t)}catch{}}};',
  'fs.mkdirSync(area,{recursive:true,mode:0o700});fs.chmodSync(path.dirname(area),0o700);fs.chmodSync(area,0o700);',
  'if(p.op==="install"){if(typeof p.value!=="string"||!p.value||/[\\r\\n\\0]/.test(p.value)||!p.meta||p.meta.leaseId!==p.leaseId)process.exit(2);',
  'w(copy,p.value+"\\n");w(metaPath,JSON.stringify({...p.meta,copyPath:copy}));if((fs.statSync(copy).mode&0o777)!==0o600)process.exit(5);process.exit(0)}',
  'if(p.op==="revoke"){let m;try{m=JSON.parse(fs.readFileSync(metaPath,"utf8"))}catch{process.exit(0)}if(m.leaseId!==p.leaseId)process.exit(4);',
  'try{fs.unlinkSync(copy)}catch(e){if(e.code!=="ENOENT")throw e}w(metaPath,JSON.stringify({...m,revokedAt:p.revokedAt}));process.exit(0)}',
  'process.exit(2);',
].join('');

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export const REMOTE_STATIC_LEASE_COMMAND = `umask 077; bun -e ${shellQuote(REMOTE_STATIC_LEASE_SCRIPT)}`;

// ── 사건 ────────────────────────────────────────────────────────────────────

function refuse(r: Resolved, id: string, target: string, reason: StaticLeaseRefusalReason, detail: string): StaticLeaseResult {
  r.log('secret', 'secret.lease.refused', { kind: 'static', id, target, reason }, 'warn');
  return { ok: false, reason, id, target, detail };
}

function eventFields(record: StaticLeaseRecord): Record<string, unknown> {
  return {
    kind: 'static', id: record.id, leaseId: record.leaseId, target: record.target, targetType: record.targetType,
    issuedAt: record.issuedAt, expiresAt: record.expiresAt, fingerprint8: record.fingerprint8,
    ...(record.targetIdentity?.nodeKeyFingerprint8 ? { nodeKeyFingerprint8: record.targetIdentity.nodeKeyFingerprint8 } : {}),
  };
}

// ── 발급 · 갱신 ─────────────────────────────────────────────────────────────

export interface StaticLeaseRequest { id: string; to: string; ttlMs?: number }

interface CheckedTarget { type: StaticLeaseTargetType; target: string; root?: string; sshDest?: string; identity?: StaticLeaseRecord['targetIdentity'] }

/** 쓰기 전 확인 — 매 발급·갱신마다 다시 한다(그 사이 허용 목록·tailnet 이 바뀌었을 수 있다). */
async function checkBeforeWrite(r: Resolved, req: StaticLeaseRequest): Promise<{ item: StaticLeaseItem; target: CheckedTarget; ttlMs: number } | StaticLeaseResult> {
  const item = resolveStaticLeaseItem(req.id);
  const parsed = parseStaticLeaseTarget(req.to);
  const targetLabel = parsed?.value ?? req.to;
  if ('refused' in item) return refuse(r, req.id, targetLabel, item.refused, item.detail);
  if (!parsed) return refuse(r, item.id, req.to, 'invalid-target', '대상은 tailnet 호스트 이름 또는 config-dir 절대 경로');
  const ttlMs = req.ttlMs ?? STATIC_LEASE_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < STATIC_LEASE_MIN_TTL_MS || ttlMs > STATIC_LEASE_MAX_TTL_MS) {
    return refuse(r, item.id, targetLabel, 'invalid-ttl', '수명은 1분 이상 7일 이하');
  }
  if (parsed.type === 'config-dir') {
    const checked = checkConfigDirTarget(parsed.value, r.knownConfigRoots());
    if (!checked.ok) return refuse(r, item.id, parsed.value, checked.reason, checked.reason === 'config-dir-missing' ? 'config-dir 이 없다(오타로 새 디렉터리를 만들지 않는다)' : 'config-dir 이 알려진 뿌리 밖이다');
    return { item, ttlMs, target: { type: 'config-dir', target: checked.path, root: checked.path } };
  }
  const allowed = r.policy(item.id).allowedHosts.map((h) => h.toLowerCase());
  if (!allowed.includes(parsed.value)) return refuse(r, item.id, parsed.value, 'not-allowlisted', `${item.id} 의 allowedHosts 에 ${parsed.value} 가 없다(기본 거부)`);
  const peers = parseTailnetIdentities(r.tailnetStatus());
  if (peers === null) return refuse(r, item.id, parsed.value, 'tailnet-unmeasured', 'tailscale status 를 못 물었다 — 신원 미확인이면 쓰지 않는다');
  const peer = findTailnetPeer(parsed.value, peers);
  if (!peer) return refuse(r, item.id, parsed.value, 'not-tailnet', `${parsed.value} 는 tailnet 피어가 아니다`);
  const sshDest = peer.dnsName || peer.ips[0];
  if (!sshDest) return refuse(r, item.id, parsed.value, 'not-tailnet', 'tailnet 피어의 MagicDNS 이름·주소가 비었다');
  return {
    item, ttlMs,
    target: {
      type: 'host', target: parsed.value, sshDest,
      identity: { tailnetName: peer.dnsName || peer.hostName, ...(peer.nodeKey ? { nodeKeyFingerprint8: sha8(peer.nodeKey) } : {}) },
    },
  };
}

async function writeLease(r: Resolved, checked: { item: StaticLeaseItem; target: CheckedTarget; ttlMs: number }, leaseId: string, issuedAtMs: number, prior?: StaticLeaseRecord): Promise<StaticLeaseResult> {
  const { item, target, ttlMs } = checked;
  const source = await r.readSourceValue(item);
  if (source && typeof source === 'object') return refuse(r, item.id, target.target, 'source-is-lease', '이 호스트의 키 캐시는 임대 사본이다 — 임대의 임대 금지');
  if (!source || /[\r\n\0]/.test(source)) return refuse(r, item.id, target.target, 'source-missing', '금고 호스트에 원천 값이 없다');
  const nowMs = r.now();
  const record: StaticLeaseRecord = {
    format: STATIC_LEASE_RECORD_FORMAT, leaseId, kind: 'static', id: item.id, envName: item.envName, cacheName: item.cacheName,
    target: target.target, targetType: target.type,
    issuedAt: new Date(issuedAtMs).toISOString(), expiresAt: new Date(nowMs + ttlMs).toISOString(), ttlMs,
    ...(prior ? { renewedAt: new Date(nowMs).toISOString() } : {}),
    fingerprint8: sha8(source),
    ...(target.identity ? { targetIdentity: target.identity } : {}),
  };
  if (target.type === 'config-dir') {
    try {
      const { mode } = writeLocalStaticLeaseCopy(target.root!, record, source);
      if (mode !== 0o600) return refuse(r, item.id, target.target, 'write-failed', `사본 권한이 0600 이 아니다(${mode.toString(8)})`);
    } catch { return refuse(r, item.id, target.target, 'write-failed', 'config-dir 임대 사본을 못 썼다'); }
  } else {
    const payload = JSON.stringify({ op: 'install', cacheName: record.cacheName, leaseId, value: source, meta: copyMeta(record, '') });
    const res = r.ssh(target.sshDest!, REMOTE_STATIC_LEASE_COMMAND, payload, 20_000);
    if (res.status !== 0) return refuse(r, item.id, target.target, 'transport-failed', `원격 임대 쓰기 실패(ssh rc=${res.status ?? 'unknown'})`);
  }
  writeStaticLeaseRecord(r.configDir, record);
  r.log('secret', prior ? 'secret.lease.renewed' : 'secret.lease.issued', eventFields(record), 'info');
  return { ok: true, action: prior ? 'renewed' : 'issued', record };
}

export async function issueStaticLease(req: StaticLeaseRequest, deps: StaticLeaseDeps = {}): Promise<StaticLeaseResult> {
  const r = resolveDeps(deps);
  const checked = await checkBeforeWrite(r, req);
  if ('ok' in checked) return checked;
  return writeLease(r, checked, r.newLeaseId(), r.now());
}

/** (항목, 대상) 의 가장 최근 원장 줄 — 상태와 무관하게. 회수된 줄도 «최근»이면 그대로 돌려준다(건너뛰지 않는다). */
function latestFor(r: Resolved, itemId: string, target: string): StaticLeaseRecord | undefined {
  return readStaticLeaseRecords(r.configDir).filter((x) => x.id === itemId && x.target === target).pop();
}

/**
 * `--renew` 한 번: 살아 있는 임대가 수명 50% 를 넘겼으면 같은 leaseId 로 다시 쓰고, 아직이면 «fresh».
 * ⛔ 회수(또는 회수 대기)된 임대는 갱신하지 않는다 — 갱신의 부작용으로 새 leaseId 를 만들지 않는다(#38086 리뷰 must-fix).
 *    `leaseId` 를 주면(--until 고리의 두 번째 회차부터) 바로 그 임대만 갱신한다: 없음·회수·만료면 거절.
 *    `leaseId` 없이: 그 (항목, 대상) 에 원장 줄이 «하나도 없을» 때만 첫 발급을 한다(cred-push 이음매).
 *    최근 줄이 회수됐으면 거절, 자연 만료됐으면 거절한다 — 다시 주려면 명시적인 `eln secret lease <id> --to <대상>`.
 */
export async function renewStaticLease(req: StaticLeaseRequest & { leaseId?: string }, deps: StaticLeaseDeps = {}): Promise<StaticLeaseResult> {
  const r = resolveDeps(deps);
  const checked = await checkBeforeWrite(r, req);
  if ('ok' in checked) return checked;
  const target = checked.target.target;
  const current = req.leaseId
    ? readStaticLeaseRecords(r.configDir).find((x) => x.leaseId === req.leaseId && x.id === checked.item.id && x.target === target)
    : latestFor(r, checked.item.id, target);
  if (!current) {
    if (req.leaseId) return refuse(r, checked.item.id, target, 'not-found', `임대 ${req.leaseId} 가 원장에 없다 — 새로 만들지 않는다`);
    return writeLease(r, checked, r.newLeaseId(), r.now());
  }
  const status = staticLeaseStatus(current, r.now());
  if (status === 'revoked' || status === 'revoke-pending') {
    return refuse(r, checked.item.id, target, 'revoked', `임대 ${current.leaseId} 는 ${status === 'revoked' ? '회수됐다' : '회수 대기 중이다'} — 갱신으로 되살리지 않는다`);
  }
  if (status === 'expired') {
    return refuse(r, checked.item.id, target, 'expired', `임대 ${current.leaseId} 는 만료됐다 — 다시 주려면 명시 발급(eln secret lease <id> --to <대상>)`);
  }
  const ttlMs = req.ttlMs ?? current.ttlMs;
  const renewAt = Date.parse(current.expiresAt) - ttlMs * (1 - STATIC_LEASE_RENEW_FRACTION);
  if (r.now() < renewAt) return { ok: true, action: 'fresh', record: current };
  return writeLease(r, { ...checked, ttlMs }, current.leaseId, Date.parse(current.issuedAt), current);
}

/**
 * `--renew --until <t>`: 끝나는 고리. 한 번 갱신 → 다음 갱신 시점(또는 until)까지 잔다 → until 에 나간다.
 * ⛔ 상주 데몬·실 스케줄 아님 — 사람이 정한 끝이 있다. 거절되면 즉시 나간다(시끄럽게).
 */
export async function runStaticLeaseRenewUntil(req: StaticLeaseRequest & { untilMs: number }, deps: StaticLeaseDeps = {}, onRound?: (res: StaticLeaseResult) => void): Promise<StaticLeaseResult> {
  const r = resolveDeps(deps);
  let last: StaticLeaseResult | undefined;
  // 첫 회차에서 정해진 leaseId 만 이후 회차가 갱신한다 — 고리 도중 회수되면 거절하고 나간다(새 임대 0).
  let pinned: string | undefined;
  for (let round = 0; round < 10_000; round++) {
    last = await renewStaticLease({ ...req, ...(pinned ? { leaseId: pinned } : {}) }, { ...deps, configDir: () => r.configDir });
    onRound?.(last);
    if (!last.ok) return last;
    pinned ??= last.record.leaseId;
    const nowMs = r.now();
    if (nowMs >= req.untilMs) return last;
    const rec = last.record;
    const nextRenew = Date.parse(rec.expiresAt) - rec.ttlMs * (1 - STATIC_LEASE_RENEW_FRACTION);
    const wake = Math.min(Math.max(nextRenew, nowMs + 1000), req.untilMs);
    await r.sleep(wake - nowMs);
    if (r.now() >= req.untilMs) return last;
  }
  return last!;
}

// ── 회수 ────────────────────────────────────────────────────────────────────

export type StaticLeaseRevokeResult = { leaseId: string; id: string; target: string; result: 'removed' | 'stale' | 'absent' | 'pending' };

/** `eln secret lease revoke <leaseId>` 또는 `--to X [--id]`. 원격이 닿지 않으면 `revokePending` — 사본은 expiresAt 에 스스로 무효. */
export async function revokeStaticLeases(sel: { leaseId?: string; to?: string; id?: string }, deps: StaticLeaseDeps = {}): Promise<StaticLeaseRevokeResult[] | { ok: false; reason: 'not-found' | 'invalid-target' }> {
  const r = resolveDeps(deps);
  const parsed = sel.to ? parseStaticLeaseTarget(sel.to) : undefined;
  if (sel.to && !parsed) return { ok: false, reason: 'invalid-target' };
  const itemId = sel.id ? resolveStaticLeaseItem(sel.id) : undefined;
  const wantId = itemId && !('refused' in itemId) ? itemId.id : sel.id;
  const targetValue = parsed?.type === 'config-dir' ? (() => { try { return realpathSync(parsed.value); } catch { return parsed.value; } })() : parsed?.value;
  const picked = readStaticLeaseRecords(r.configDir).filter((x) => !x.revokedAt
    && (sel.leaseId ? x.leaseId === sel.leaseId : true)
    && (targetValue ? x.target === targetValue : true)
    && (wantId ? x.id === wantId : true));
  if (!picked.length || (!sel.leaseId && !sel.to)) {
    r.log('secret', 'secret.lease.refused', { kind: 'static', id: sel.id, target: sel.to, leaseId: sel.leaseId, reason: 'not-found', op: 'revoke' }, 'warn');
    return { ok: false, reason: 'not-found' };
  }
  const out: StaticLeaseRevokeResult[] = [];
  for (const record of picked) {
    const revokedAt = new Date(r.now()).toISOString();
    let result: StaticLeaseRevokeResult['result'];
    if (record.targetType === 'config-dir') {
      try { result = revokeLocalStaticLeaseCopy(record.target, record, revokedAt); } catch { result = 'pending'; }
    } else {
      const peers = parseTailnetIdentities(r.tailnetStatus());
      const peer = peers ? findTailnetPeer(record.target, peers) : undefined;
      const dest = peer ? (peer.dnsName || peer.ips[0]) : undefined;
      const res = dest ? r.ssh(dest, REMOTE_STATIC_LEASE_COMMAND, JSON.stringify({ op: 'revoke', cacheName: record.cacheName, leaseId: record.leaseId, revokedAt }), 20_000) : { status: null };
      result = res.status === 0 ? 'removed' : res.status === 4 ? 'stale' : 'pending';
    }
    const next: StaticLeaseRecord = { ...record };
    if (result === 'pending') next.revokePending = true;
    else { next.revokedAt = revokedAt; delete next.revokePending; }
    writeStaticLeaseRecord(r.configDir, next);
    r.log('secret', 'secret.lease.revoked', { ...eventFields(next), result }, result === 'pending' ? 'warn' : 'info');
    out.push({ leaseId: record.leaseId, id: record.id, target: record.target, result });
  }
  return out;
}

// ── cred-push.sh 흡수 이음매 ────────────────────────────────────────────────

/**
 * OP `cred-push.sh`(정적 키 export → 키체인 passphrase 파이프 → ssh → 대상 import → check → 감사) 대신 부르는 함수.
 * 같은 일을 «암호 번들·원격 /tmp 파일·passphrase» 없이 한다:
 *   cred-push.sh --to <host> --keys openrouter,zai   ⇒   eln secret lease openrouter,zai --to <host> --renew
 * 스크립트 쪽 바꿈 = 번들 생성·전송·import 세 줄을 위 명령 한 줄로(rc 0 = 전부 임대 · rc 1 = 하나라도 거절, 이유는 줄마다).
 * 은퇴 단계는 설계 §6 첫 줄(C3 green 뒤 7일 병행 → `EXPIRED` 머리).
 */
export async function leaseStaticKeysForCredPush(req: { to: string; keys: readonly string[]; ttlMs?: number }, deps: StaticLeaseDeps = {}): Promise<StaticLeaseResult[]> {
  const out: StaticLeaseResult[] = [];
  for (const key of req.keys) out.push(await renewStaticLease({ id: key, to: req.to, ...(req.ttlMs !== undefined ? { ttlMs: req.ttlMs } : {}) }, deps));
  return out;
}
