import type { McpTransport, McpServerSpec, McpConfig } from './types.js';
import { spreadIfDefined } from './coercion.js';
import { debug } from '../debug/log.js';

function parseMcpCommand(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const command: string[] = [];
  for (const part of raw) {
    if (typeof part !== 'string' || part.length === 0) return undefined;
    command.push(part);
  }
  if (command.length === 0) return undefined;
  return command;
}

function normalizeMcpTransport(raw: unknown): McpTransport | undefined {
  if (typeof raw !== 'string') return undefined;
  const kind = raw.trim();
  if (kind === 'stdio') return 'stdio';
  if (kind === 'http' || kind === 'streamable-http') return 'http';
  return undefined;
}

/** User-visible diagnostic for the one silent-drop contract this landing breaks. */
export function formatMcpUrlWithoutTransportDiagnostic(id: string): string {
  return `[user-config] mcp server "${id}" has a url but no transport; set transport to "http"`;
}

function warnMcpUrlWithoutTransport(id: string): void {
  const message = formatMcpUrlWithoutTransportDiagnostic(id);
  try { console.warn(message); } catch { /* parse must never throw */ }
  try {
    debug.log('user-config.mcp', 'url-without-transport', { id, hint: 'http' });
  } catch { /* parse must never throw */ }
}

/** ⛔⭐ **권한 필드다 — 「모르는 값은 허가하지 않는다」로 읽는다.**
 *
 *  배열이 아니면 `undefined`(= 아무것도 허가 안 함) · 배열이면 «비지 않은 문자열»만 남긴다.
 *  ⇒ 오타·잘못된 타입이 «허가를 늘리는» 방향으로는 절대 못 간다(항목 단위 fail-closed).
 *  ⛔ 서버 전체를 버리지는 않는다 — 오타 하나로 서버가 조용히 사라지면 더 나쁘다.
 *
 *  📌 이 함수가 «없어서» 회귀가 났다: 필드는 `McpServerSpec` 에 있는데 파서가 안 읽어
 *  config 에 적은 `authorizedTools` 가 조용히 버려졌고, `registerMcpClients` 가 항상 빈
 *  배열을 돌아 ***모든 MCP 프록시 툴이 영구히 거부***됐다(사후 리뷰가 잡음). */
function parseMcpHandshakeTimeoutMs(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const timeoutMs = Math.floor(raw);
  return timeoutMs >= 1 && timeoutMs <= 2_147_483_647 ? timeoutMs : undefined;
}

function parseMcpAuthorizedTools(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (name.length === 0) continue;
    if (!out.includes(name)) out.push(name);   // 중복은 접는다 — 결정론
  }
  return out;
}

function parseMcpServerSpec(raw: unknown): McpServerSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id.trim().length > 0 ? r.id.trim() : undefined;
  if (!id) return undefined;
  const enabled: boolean | undefined =
    typeof r.enabled === 'boolean' ? r.enabled : undefined;
  // ⛔ 권한 필드 — 네 반환 경로 «전부»에 실어야 한다(하나만 빠져도 그 조합에서 허가가 죽는다).
  const authorizedTools = parseMcpAuthorizedTools(r.authorizedTools);
  const handshakeTimeoutMs = parseMcpHandshakeTimeoutMs(r.handshakeTimeoutMs);
  // Presence ≠ validity. `null` / `42` / `''` / `'   '` are explicit
  // malformed transports (silent drop), not "transport omitted".
  const transportPresent = Object.hasOwn(r, 'transport');
  const transport = normalizeMcpTransport(r.transport);
  const url = typeof r.url === 'string' && r.url.length > 0 ? r.url : undefined;
  const oauthIssuer = typeof r.oauthIssuer === 'string' && r.oauthIssuer.trim().length > 0
    ? r.oauthIssuer.trim()
    : undefined;
  const oauthTokenEndpoint = typeof r.oauthTokenEndpoint === 'string' && r.oauthTokenEndpoint.trim().length > 0
    ? r.oauthTokenEndpoint.trim()
    : undefined;
  const bearerTokenEnv = typeof r.bearerTokenEnv === 'string' && r.bearerTokenEnv.trim().length > 0
    ? r.bearerTokenEnv.trim()
    : undefined;
  const command = parseMcpCommand(r.command);

  // 1. Field combination validity — before transport inference.
  // `{ id, command, url }` is mixed malformed whether or not transport is
  // written: legacy `command` already means stdio, so this is not the
  // URL-only copy-paste trap. Silent drop, never warn.
  if (r.command !== undefined && r.url !== undefined) return undefined;
  if (transport === 'http' && r.command !== undefined) return undefined;
  if (transport === 'stdio' && r.url !== undefined) return undefined;

  // 2. Explicit transport value validation.
  if (transportPresent && transport === undefined) return undefined;

  // 3. Legacy stdio inference: omitted transport + command → child process.
  if (!transportPresent && command) {
    return {
      id,
      transport: 'stdio',
      command,
      ...spreadIfDefined('enabled', enabled),
      ...spreadIfDefined('handshakeTimeoutMs', handshakeTimeoutMs),
      ...spreadIfDefined('authorizedTools', authorizedTools),
    };
  }

  // 4. URL-only trap: omitted transport + url (and no command — mixed
  // already returned). Intentional break of silent-drop: name the entry
  // and tell the user to set `http`.
  if (!transportPresent && url) {
    warnMcpUrlWithoutTransport(id);
    return undefined;
  }

  if (transport === 'http') {
    if (!url) return undefined;
    return {
      id,
      transport: 'http',
      url,
      ...spreadIfDefined('oauthIssuer', oauthIssuer),
      ...spreadIfDefined('oauthTokenEndpoint', oauthTokenEndpoint),
      ...spreadIfDefined('bearerTokenEnv', bearerTokenEnv),
      ...spreadIfDefined('enabled', enabled),
      ...spreadIfDefined('handshakeTimeoutMs', handshakeTimeoutMs),
      ...spreadIfDefined('authorizedTools', authorizedTools),
    };
  }

  // Explicit `stdio` requires command.
  if (!command) return undefined;
  return {
    id,
    transport: 'stdio',
    command,
    ...spreadIfDefined('enabled', enabled),
    ...spreadIfDefined('handshakeTimeoutMs', handshakeTimeoutMs),
    ...spreadIfDefined('authorizedTools', authorizedTools),
  };
}

export function parseMcpConfig(raw: unknown): McpConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const enabled = r.enabled === false ? false : undefined; // strict false flips off
  const handshakeTimeoutMs = parseMcpHandshakeTimeoutMs(r.handshakeTimeoutMs);
  const widgetServerId = typeof r.widgetServerId === 'string' && r.widgetServerId.trim().length > 0
    ? r.widgetServerId.trim()
    : undefined;
  const servers: McpServerSpec[] = [];
  if (Array.isArray(r.servers)) {
    for (const entry of r.servers) {
      const spec = parseMcpServerSpec(entry);
      if (spec) servers.push(spec);
    }
  }
  // Keep a named widget binding even when the server list is empty or
  // absent so boot can log unknown-widget-server-id and fall back.
  // The master switch alone is still enough to retain `{ enabled: false }`.
  if (servers.length === 0 && enabled === undefined && handshakeTimeoutMs === undefined && widgetServerId === undefined) return undefined;
  return {
    servers,
    ...(enabled === false ? { enabled: false } : {}),
    ...spreadIfDefined('handshakeTimeoutMs', handshakeTimeoutMs),
    ...spreadIfDefined('widgetServerId', widgetServerId),
  };
}

