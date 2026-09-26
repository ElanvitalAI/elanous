/** 클러스터 안 읽기 전용 참조 거울에 «무엇이 들어갈 수 있나»를 코드가 막는다 (P25a).
 *
 *  자격 URL · 금지 경로 · 출처 없는 항목은 refused. 레지스트리 내보내기·Pod 배치는 이 모듈 밖이다.
 */
import { debug } from '../debug/log.js';

export interface MirrorManifestEntry {
  readonly id: string;
  readonly upstream?: string;
  readonly localOnly?: boolean;
  readonly path?: string;
}

export interface MirrorAccepted {
  readonly id: string;
  readonly upstream?: string;
  readonly localOnly?: boolean;
}

export interface MirrorRefused {
  readonly id: string;
  readonly reason: string;
}

export interface MirrorManifestResult {
  readonly accepted: MirrorAccepted[];
  readonly refused: MirrorRefused[];
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** 홈 아래 이 디렉터리 전체는 거울에 올리지 않는다. */
const FORBIDDEN_HOME_DIRS = ['.elanous', '.monad', '.codex', '.grok', '.ssh', '.config'] as const;

/** 이름·경로 어디에든 이 토큰이 있으면 거부한다. */
const FORBIDDEN_TOKENS = ['vault', 'obsidian', 'yt-vault', '.db', 'secrets', 'credentials'] as const;

function ipv4Octets(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    octets.push(n);
  }
  return octets;
}

function hex16(text: string): number | undefined {
  if (!/^[0-9a-f]{1,4}$/.test(text)) return undefined;
  return Number.parseInt(text, 16);
}

/** `::ffff:7f00:1` · `::ffff:127.0.0.1` 을 그 IPv4 로 환산한다. 매핑이 아니면 undefined. */
function ipv4MappedOctets(host: string): number[] | undefined {
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1]) return ipv4Octets(dotted[1]);
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex?.[1] || !hex[2]) return undefined;
  const hi = hex16(hex[1]);
  const lo = hex16(hex[2]);
  if (hi === undefined || lo === undefined) return undefined;
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

/** 루프백·사설·링크-로컬·문서용·멀티캐스트 대역. 공개 git 호스트가 아니다. */
function isNonPublicIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets;
  if (a === undefined || b === undefined) return true;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

/** `::` 압축을 푼 8개의 16비트 그룹. 파싱 불가면 undefined. */
function expandIpv6(host: string): number[] | undefined {
  const lower = host.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(lower) || !lower.includes(':')) return undefined;
  const halves = lower.split('::');
  if (halves.length > 2) return undefined;
  const parseSide = (side: string): number[] | undefined => {
    if (side === '') return [];
    const groups: number[] = [];
    for (const part of side.split(':')) {
      const value = hex16(part);
      if (value === undefined) return undefined;
      groups.push(value);
    }
    return groups;
  };
  const head = parseSide(halves[0] ?? '');
  if (head === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const tail = parseSide(halves[1] ?? '');
  if (tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

/** 공개 유니캐스트 IPv6 만 통과. 미지정·루프백·ULA·링크-로컬·매핑·문서용은 거부. */
function isNonPublicIpv6(groups: readonly number[]): boolean {
  if (groups.length !== 8 || groups.some((g) => g === undefined)) return true;
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  const head = groups[0] ?? 0;
  if ((head & 0xfe00) === 0xfc00) return true;
  if ((head & 0xffc0) === 0xfe80) return true;
  if ((head & 0xff00) === 0xff00) return true;
  if (groups[0] === 0x2001 && groups[1] === 0xdb8) return true;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const mapped = ipv4FromMappedGroups(groups);
    return mapped ? isNonPublicIpv4(mapped) : true;
  }
  if ((head & 0xe000) !== 0x2000) return true;
  return false;
}

function ipv4FromMappedGroups(groups: readonly number[]): number[] | undefined {
  const hi = groups[6];
  const lo = groups[7];
  if (hi === undefined || lo === undefined) return undefined;
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

/** 공개 DNS 이름(라벨 둘 이상) 또는 공개 유니캐스트 IP 만 통과. */
function isNonPublicHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const mapped = ipv4MappedOctets(host);
  if (mapped) return isNonPublicIpv4(mapped);
  const v4 = ipv4Octets(host);
  if (v4) return isNonPublicIpv4(v4);
  const v6 = expandIpv6(host);
  if (v6) return isNonPublicIpv6(v6);
  const labels = host.split('.');
  if (labels.length < 2) return true;
  if (labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return true;
  }
  return false;
}

/** 파싱 가능한 https URL 이고, 자격·토큰 쿼리·비공개 호스트가 없을 때만 undefined. */
function publicHttpsReason(upstream: string): string | undefined {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    return 'upstream-not-https';
  }
  if (url.protocol !== 'https:' || !url.hostname) return 'upstream-not-https';
  if (url.username !== '' || url.password !== '') return 'credential-url';
  if (isNonPublicHost(url.hostname)) return 'upstream-not-public';
  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  for (const part of query.split('&')) {
    if (!part) continue;
    let key: string;
    try {
      key = decodeURIComponent(part.split('=')[0] ?? '').toLowerCase();
    } catch {
      return 'token-query';
    }
    if (key === 'token' || key === 'access_token' || key.endsWith('_token')) return 'token-query';
  }
  return undefined;
}

/** `..` · `.` · 중복 슬래시를 접는다. `~` 는 홈 표식으로 남긴다. */
function normalizeMirrorPath(path: string): string {
  const slash = path.replaceAll('\\', '/');
  const home = slash.startsWith('~/') || slash === '~';
  const body = home ? slash.slice(1) : slash;
  const absolute = body.startsWith('/');
  const out: string[] = [];
  for (const part of body.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(part);
  }
  const joined = `${absolute ? '/' : ''}${out.join('/')}`;
  if (home) return joined === '' ? '~' : `~${joined.startsWith('/') ? '' : '/'}${joined}`;
  return joined === '' ? '.' : joined;
}

function forbiddenPathReason(id: string, path: string | undefined): string | undefined {
  const normalized = path === undefined ? undefined : normalizeMirrorPath(path);
  const haystack = `${id}\n${normalized ?? ''}`;
  const lower = haystack.toLowerCase();
  for (const token of FORBIDDEN_TOKENS) {
    if (lower.includes(token)) return `forbidden-path: ${token}`;
  }
  if (normalized) {
    for (const dir of FORBIDDEN_HOME_DIRS) {
      const marker = `~/${dir}`;
      if (normalized === marker || normalized.startsWith(`${marker}/`)) {
        return `forbidden-path: ${marker}`;
      }
    }
  }
  return undefined;
}

function refuseReason(entry: MirrorManifestEntry): string | undefined {
  if (!ID_RE.test(entry.id)) return 'bad-id';
  const banned = forbiddenPathReason(entry.id, entry.path);
  if (banned) return banned;
  const upstream = entry.upstream;
  if (upstream !== undefined) {
    const upstreamReason = publicHttpsReason(upstream);
    if (upstreamReason) return upstreamReason;
  }
  if (upstream === undefined && entry.localOnly !== true) return 'no-source';
  return undefined;
}

export function validateMirrorManifest(entries: MirrorManifestEntry[]): MirrorManifestResult {
  const accepted: MirrorAccepted[] = [];
  const refused: MirrorRefused[] = [];
  for (const entry of entries) {
    const reason = refuseReason(entry);
    if (reason) {
      refused.push({ id: entry.id, reason });
      continue;
    }
    accepted.push({
      id: entry.id,
      ...(entry.upstream !== undefined ? { upstream: entry.upstream } : {}),
      ...(entry.localOnly === true ? { localOnly: true } : {}),
    });
  }
  const result = { accepted, refused };
  debug.log('grounding.mirror', 'manifest-validated', { accepted, refused });
  return result;
}

/** 거울 Pod 가 읽는 줄 목록. upstream 이 있으면 그 URL, 로컬 전용은 `local`. */
export function renderMirrorList(accepted: readonly MirrorAccepted[]): string {
  return accepted
    .map((entry) => `${entry.id} ${entry.upstream ?? 'local'}`)
    .join('\n');
}
