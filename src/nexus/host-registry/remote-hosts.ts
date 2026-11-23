/**
 * NEXUS-REMOTE-HOST-REGISTRY(P2-1) — 원격 머신 정본(remote-hosts.json).
 *
 * 정본 = nexus 루트의 remote-hosts.json: 원격 머신 각각의 ssh(별칭/주소)·금고·relay·tailnet.
 * 읽기 규칙(완료선): 파일 부재·스키마 위반 → 명시적 throw(조용한 빈표 아님 · 러드(loud) 실패).
 * 별칭 조회: 실제 머신명(예: MacStudioB1) → 레지스트리 키(예: node-b). 미등록 원격지 → 명시적 오류.
 * 금고 정의(값의 뜻): 본부 넥서스(mshq) 안 eln secret 백엔드 — 출처 OP ASK-HQ-CREDENTIAL-VAULT-1117.
 * 출처: ROSTER-0334 P2-1 · OP #134157 착수 점검.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nexusRootDir } from '../paths.js';

export type RemoteRelay = 'tailscale' | 'ssh' | 'wss';

/** Ssh 접속 정의. alias = ssh config 별칭(예: node-b), hostName = 실제 주소(tailnet IP or MagicDNS). */
export interface RemoteSshSpec {
  alias: string;
  hostName: string;
  port?: number;
  user?: string;
}

export interface RemoteHostRecord {
  /** Registry key (filled from the map key on read — the file need not repeat it). */
  host: string;
  /** Other names this machine goes by (e.g. «MacStudioB1» for the key «node-b»). */
  aliases?: string[];
  ssh: RemoteSshSpec;
  /** Vault item this host consumes credentials from (정본 금고 = mshq eln secret). */
  vault?: string;
  relay?: RemoteRelay;
  /** Tailnet address (tailscale IP or MagicDNS name). */
  tailnet: string;
}

export interface RemoteHostsFile {
  version: 1;
  hosts: Record<string, RemoteHostRecord>;
}

export class RemoteHostsError extends Error {}

/** Null-prototype map so host keys like __proto__ / constructor stay ordinary own keys. */
function toRemoteHostMap(entries: Iterable<[string, RemoteHostRecord]>): Record<string, RemoteHostRecord> {
  const m: Record<string, RemoteHostRecord> = Object.create(null);
  for (const [k, v] of entries) Object.defineProperty(m, k, { value: v, enumerable: true, writable: true, configurable: true });
  return m;
}

const RELAYS = new Set<RemoteRelay>(['tailscale', 'ssh', 'wss']);

function isRemoteSshSpec(v: unknown): v is RemoteSshSpec {
  const s = v as Partial<RemoteSshSpec> | null;
  return !!s && typeof s === 'object' && typeof s.alias === 'string' && s.alias.trim() !== ''
    && typeof s.hostName === 'string' && s.hostName.trim() !== ''
    && (s.port === undefined || (typeof s.port === 'number' && Number.isInteger(s.port) && s.port > 0))
    && (s.user === undefined || typeof s.user === 'string');
}

/** Strict read — 부재·위반 모두 throw. undefined 반환 없음(러드 실패 원칙). */
export function readRemoteHosts(path: string = remoteHostsPath()): Record<string, RemoteHostRecord> {
  if (!existsSync(path)) throw new RemoteHostsError(`remote-hosts.json is absent at ${path} — 원격 머신 정본 파일이 없습니다 (조용한 빈표 금지)`);
  let parsed: Partial<RemoteHostsFile>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RemoteHostsFile>;
  } catch (e) {
    throw new RemoteHostsError(`remote-hosts.json is corrupt (${path}): ${(e as Error).message}`);
  }
  if (parsed?.version !== 1 || typeof parsed.hosts !== 'object' || parsed.hosts === null || Array.isArray(parsed.hosts)) {
    throw new RemoteHostsError(`remote-hosts.json has unsupported version/shape (${path})`);
  }
  const entries: [string, RemoteHostRecord][] = [];
  for (const [key, raw] of Object.entries(parsed.hosts)) {
    const r = raw as Partial<RemoteHostRecord> | null;
    if (!r || typeof r !== 'object' || !isRemoteSshSpec(r.ssh) || typeof r.tailnet !== 'string' || r.tailnet.trim() === '') {
      throw new RemoteHostsError(`remote-hosts.json entry «${key}» is malformed (${path}): ssh(alias·hostName)·tailnet 필수`);
    }
    if (r.relay !== undefined && !RELAYS.has(r.relay)) {
      throw new RemoteHostsError(`remote-hosts.json entry «${key}» has unknown relay «${String(r.relay)}» (${path})`);
    }
    if (r.aliases !== undefined && !(Array.isArray(r.aliases) && r.aliases.every((a) => typeof a === 'string' && a.trim() !== ''))) {
      throw new RemoteHostsError(`remote-hosts.json entry «${key}» has malformed aliases (${path})`);
    }
    entries.push([key, { ...r, host: key } as RemoteHostRecord]);
  }
  return toRemoteHostMap(entries);
}

/** 정본 파일 기본 경로: nexus 루트의 remote-hosts.json. */
export function remoteHostsPath(): string {
  return join(nexusRootDir(), 'remote-hosts.json');
}

/** 이름(키 또는 별칭)으로 원격 머신을 찾는다. 미등록 → 명시적 throw(undefined 반환 아님). */
export function resolveRemoteHost(path: string, name: string): RemoteHostRecord {
  const hosts = readRemoteHosts(path);
  const direct = hosts[name];
  if (direct) return direct;
  for (const record of Object.values(hosts)) {
    if (record.aliases?.some((a) => a === name)) return record;
  }
  throw new RemoteHostsError(`unknown remote host «${name}» — remote-hosts.json에 등록되지 않았습니다 (${path})`);
}