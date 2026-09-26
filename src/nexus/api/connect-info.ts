// NEXUS · /v1/nexus/connect-info endpoint (Track 4.A · 2026-05-07)
//
// GET /v1/nexus/connect-info
//   response: {
//     acp_url:        ws-url-string,
//     voice_url:      ws-url-string-or-null,
//     token_required: boolean,
//     token_hint:     string,           // human-readable
//     server_label:   string,           // host (NEXUS <ver>)
//     auto_token:     string | null,    // 자동 mint 시 raw bearer
//   }
//
// `auto_token` 정책: 언제나 null (칸은 호환용으로 남긴다).
//   종전엔 «서버 바인드가 루프백이면» 토큰 파일 원문을 실었는데, tailnet 공유(serve → localhost 프록시)에서는
//   tailnet 기기·Pod 가 Origin 없는 GET 한 번으로 관리 토큰을 얻었다(🅣 전수 2026-09-26). 같은 기계의 CLI 는 파일을 직접 읽는다.
//
// `elanous nexus connect <host>` (T4.B) 가 처음 실행할 때 본 endpoint 를
// 호출 → metadata 로 bookmark 만들고 token 을 저장. 이후 일상 사용
// `elanous` (무인자 · T4.C) 가 bookmark 를 read 해서 자동 attach.
//
// PWA `Generate connect token` 카드 (T4.D) 는 별도 POST endpoint 로 5min
// single-use JWT 를 mint. T4.D PR 에서 이 module 에 mint-token 추가 예정.

import { jsonResponse } from './http-server.js';
import { existsSync, readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { homedir } from 'node:os';
import { debug } from '../../debug/log.js';

export interface ConnectInfoCtx {
  /** Hostname the HTTP server bound to (e.g., '127.0.0.1' / '0.0.0.0' / Tailscale name). */
  hostname: string;
  /** Resolved HTTP port. */
  port: number;
  /** NEXUS version string (banner-friendly). */
  nexusVersion: string;
  /** Optional override for the loopback acp-token path (tests). */
  acpTokenPath?: string;
  /** Optional readable label for `server_label` (defaults to hostname). */
  serverLabel?: string;
  /** Test seam — when present, used instead of file read. */
  acpTokenOverride?: string | null;
  /** ⛔ false 면 토큰을 싣지 않는다 — 다른 웹사이트(교차 출처)의 요청(🅢 2026-09-26 실측: `Origin: https://evil.example` 에
   *  200 ⊕ `access-control-allow-origin: *` ⊕ `auto_token` 원문 → 브라우저로 연 아무 페이지가 관리 토큰을 읽을 수 있었다).
   *  허용 판정은 호출자(`connectInfoTokenAllowed`)가 한다. 생략 = 종전(시험 호환). */
  allowAutoToken?: boolean;
  /**
   * Incoming request Host (header or URL host). Used only when `hostname`
   * is a wildcard bind (`0.0.0.0` / `::` / empty) so advertised URLs are
   * the address the client actually reached — not the unroutable bind.
   * Required for wildcard binds; missing/empty authority fails closed.
   */
  requestHost?: string;
}

export interface ConnectInfoBody {
  acp_url: string;
  voice_url: string | null;
  token_required: boolean;
  token_hint: string;
  server_label: string;
  auto_token: string | null;
}

/** Hostname + optional explicit port parsed from a request Host / URL host. */
export interface RequestAuthority {
  hostname: string;
  port?: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '']);

export function defaultAcpTokenPath(): string {
  return joinPath(homedir(), '.elanous', 'acp-token');
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

export function isWildcardBindHost(hostname: string): boolean {
  return WILDCARD_BIND_HOSTS.has(hostname);
}

export class ConnectInfoAdvertisementError extends Error {
  readonly code = 'connect-info-host-required' as const;
  constructor(message = 'connect-info requires a reachable request host for wildcard binds') {
    super(message);
    this.name = 'ConnectInfoAdvertisementError';
  }
}

/**
 * Parse a Host header / URL host into hostname + optional explicit port.
 * IPv6 `[addr]:port` keeps the port; bare `[addr]` or unbracketed IPv6 has none.
 */
export function parseRequestAuthority(requestHost: string): RequestAuthority | null {
  const trimmed = requestHost.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end <= 1) return null;
    const hostname = trimmed.slice(1, end);
    if (!hostname) return null;
    const rest = trimmed.slice(end + 1);
    if (!rest) return { hostname };
    if (!rest.startsWith(':')) return null;
    const port = parseHostPort(rest.slice(1));
    if (port === undefined) return null;
    return { hostname, port };
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon > 0 && trimmed.indexOf(':') === colon) {
    const hostname = trimmed.slice(0, colon);
    if (!hostname) return null;
    const port = parseHostPort(trimmed.slice(colon + 1));
    if (port === undefined) return null;
    return { hostname, port };
  }
  return { hostname: trimmed };
}

function parseHostPort(raw: string): number | undefined {
  if (!/^\d{1,5}$/.test(raw)) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return port;
}

/** Strip `:port` from a Host header / URL host. IPv6 `[addr]:port` → `addr`. */
export function hostnameFromRequestHost(requestHost: string): string {
  return parseRequestAuthority(requestHost)?.hostname ?? '';
}

function formatHostForUrl(hostname: string): string {
  return hostname.includes(':') ? `[${hostname}]` : hostname;
}

function advertisedPort(ctx: ConnectInfoCtx, authority: RequestAuthority | null): number {
  return authority?.port ?? ctx.port;
}

/**
 * Hostname that belongs in advertised URLs / default `server_label`.
 * Wildcard binds never leak; concrete binds keep the existing bind host.
 */
export function advertisedHostname(ctx: ConnectInfoCtx): string {
  if (!isWildcardBindHost(ctx.hostname)) return ctx.hostname;
  return resolveWildcardAuthority(ctx).hostname;
}

function resolveWildcardAuthority(ctx: ConnectInfoCtx): RequestAuthority {
  const authority = ctx.requestHost ? parseRequestAuthority(ctx.requestHost) : null;
  if (!authority?.hostname) {
    throw new ConnectInfoAdvertisementError();
  }
  return authority;
}

export function buildConnectInfo(ctx: ConnectInfoCtx): ConnectInfoBody {
  const wildcard = isWildcardBindHost(ctx.hostname);
  const authority = wildcard ? resolveWildcardAuthority(ctx) : null;
  const host = wildcard ? authority!.hostname : ctx.hostname;
  // Concrete binds keep the historical `ws://${hostname}` assembly.
  // Wildcard binds wrap IPv6 so the advertised URL is a usable host.
  const hostForUrl = wildcard ? formatHostForUrl(host) : host;
  const port = advertisedPort(ctx, authority);
  const acpUrl = `ws://${hostForUrl}:${port}/v1/acp`;
  const voiceUrl = `ws://${hostForUrl}:${port}/v1/voice/ws`;
  const serverLabel = ctx.serverLabel ?? `${host} (NEXUS ${ctx.nexusVersion})`;

  // 🔐 2026-09-26(🅣 전수): 원시 bearer 를 HTTP 로 내보내지 않는다. «바인드가 루프백»은 «요청자가 이 기계»를 뜻하지 않는다 —
  //   `tailscale serve --tls-terminated-tcp` 는 tailnet 요청을 localhost 로 프록시하므로 상대 주소도 127.0.0.1 로 보이고,
  //   Origin 이 없는 요청(curl·Pod)은 교차 출처 검사를 안 탄다. 같은 uid 의 로컬 도구는 토큰 파일을 직접 읽는다(remotes-cli).
  const autoToken: string | null = null;
  const tokenRequired = autoToken === null;
  const tokenHint = '~/.elanous/acp-token on the server host (paste content into bearer · same-host CLI reads the file)';

  return {
    acp_url: acpUrl,
    voice_url: voiceUrl,
    token_required: tokenRequired,
    token_hint: tokenHint,
    server_label: serverLabel,
    auto_token: autoToken,
  };
}

export function handleConnectInfoGet(ctx: ConnectInfoCtx): Response {
  let body: ConnectInfoBody;
  try {
    body = buildConnectInfo(ctx);
  } catch (err) {
    if (err instanceof ConnectInfoAdvertisementError) {
      return jsonResponse({ error: err.code, detail: err.message }, 400);
    }
    throw err;
  }
  if (debug.enabled) {
    debug.log('nexus.connect-info.get', ctx.hostname, {
      port: ctx.port,
      autoToken: body.auto_token ? 'present' : 'absent',
    });
  }
  return jsonResponse(body, 200);
}

// ---------------------------------------------------------------------------
// T4.D — POST /v1/nexus/connect-info/mint-token
// ---------------------------------------------------------------------------
//
// PWA `Generate connect token` 카드 가 호출. 사용자가 다른 머신에서
// `elanous nexus connect <host>` 시 paste 할 token 을 mint. 본 endpoint 는
// 이미 인증된 (bearer 있는) 호출자만 mint 가능 — http-server.ts 의 bearer
// gate 가 가드. 미loopback caller 도 mint 할 수 있어 PWA on phone 에서
// generate → copy → paste-on-laptop 흐름이 정착.
//
// 기본 모드: existing `~/.elanous/acp-token` 의 raw bearer 를 그대로 반환.
// future v2 (ROADMAP §9.4) — mutual auth 시 5min TTL single-use JWT 로
// 강화. 지금은 single-host dogfood 우선이라 raw bearer 가 합리적.

export interface MintTokenBody {
  /** Raw bearer the receiver pastes into `elanous nexus connect`. */
  token: string;
  /** ms-since-epoch. null = 만료 없음 (raw bearer · v1 simple mode). */
  expiresAt: number | null;
  /** Human-readable copy hint. */
  hint: string;
}

export function buildMintTokenResponse(ctx: ConnectInfoCtx): MintTokenBody {
  const path = ctx.acpTokenPath ?? defaultAcpTokenPath();
  let token: string | null = null;
  if (ctx.acpTokenOverride !== undefined) {
    token = ctx.acpTokenOverride;
  } else if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8').trim();
      if (raw.length > 0) token = raw;
    } catch {
      token = null;
    }
  }
  if (!token) {
    throw new Error('acp-token unavailable on the NEXUS host');
  }
  return {
    token,
    expiresAt: null,
    hint: 'Paste into `elanous nexus connect <host>` on the other device. Same token works on every device — re-mint after rotate.',
  };
}

export function handleConnectTokenMint(ctx: ConnectInfoCtx): Response {
  let body: MintTokenBody;
  try {
    body = buildMintTokenResponse(ctx);
  } catch (err) {
    return jsonResponse(
      { error: 'token-unavailable', detail: (err as Error).message },
      503,
    );
  }
  if (debug.enabled) {
    debug.log('nexus.connect-info.mint-token', 'ok', {
      hostname: ctx.hostname,
    });
  }
  return jsonResponse(body, 201);
}

/** 관리 토큰을 connect-info 에 실어도 되는 요청인가 — Origin 이 없거나(로컬 프로세스 · 토큰 파일을 어차피 읽을 수 있다),
 *  이 데몬이 서빙한 페이지(Origin 호스트 == 요청 Host)거나, 루프백 출처(PWA 개발 서버)일 때만.
 *  브라우저는 Origin 을 위조할 수 없으므로 다른 웹사이트는 셋 다 아니다. */
export function connectInfoTokenAllowed(origin: string | null, requestHost: string | null): boolean {
  if (!origin || origin === 'null') return origin === null;
  let o: URL;
  try { o = new URL(origin); } catch { return false; }
  if (requestHost && o.host === requestHost) return true;
  return o.hostname === 'localhost' || o.hostname === '127.0.0.1' || o.hostname === '[::1]' || o.hostname === '::1';
}
