// `elanous mcp reload` — 도는 데몬의 MCP 클라이언트만 다시 세운다.
//
// 대표 2026-09-10: *"그런데 왜 재부팅해야만 리로드 되게끔 구조가 되어 있나요?"*
//
// 이 CLI 는 `POST /v1/nexus/admin/mcp-reload` 한 발이다. 데몬이 config 를 다시
// 읽고(`reloadUserConfig`) 옛 클라이언트를 내린 뒤 새로 등록한다. OAuth 토큰은
// 저장소(`auth.json`)에서 «호출 때마다» 읽히므로 `elanous mcp login` 직후
// 이 명령 하나로 자격증명까지 살아난다.
//
// ⛔ 데몬이 없으면 재장전할 대상이 없다 — 그건 오류가 아니라 «상태»이므로
//    exit 1 로 내되 「다음에 무엇을 하라」를 같이 말한다(데몬을 띄우면 어차피
//    기동 경로가 config 를 새로 읽는다).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { resolveDaemonEndpoint } from '../nexus/daemon-endpoint.js';

const ADMIN_MCP_RELOAD_PATH = '/v1/nexus/admin/mcp-reload';

interface ServerRow {
  status?: unknown;
  toolCount?: unknown;
  /** `McpServerBootResult.reason` 과 같은 이름 — 실패 사유. */
  reason?: unknown;
  /** `McpServerBootResult.reasonClass` — 실패 분류. */
  reasonClass?: unknown;
}

/** Fail-soft read of the loopback ACP token the rest of the CLI already uses. */
function readAcpToken(): string | null {
  const tokenPath = join(getElanousConfigDir(), 'acp-token');
  try {
    if (!existsSync(tokenPath)) return null;
    const token = readFileSync(tokenPath, 'utf8').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Strip the live ACP token from user-facing text. Empty tokens are not substituted. */
function maskTokenInText(text: string, token: string | null): string {
  if (!token) return text;
  return text.split(token).join('[redacted]');
}

export interface McpReloadCliOpts {
  nexusBaseUrl?: string;
  out?: { log: (s: string) => void; error: (s: string) => void };
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface McpReloadCliResult {
  exitCode: number;
  /** 재장전 뒤 등록된 총 도구 수. 실패면 undefined. */
  registered?: number;
}

export async function runMcpReload(opts: McpReloadCliOpts = {}): Promise<McpReloadCliResult> {
  const rawOut = opts.out ?? {
    log: (s: string) => process.stdout.write(`${s}\n`),
    error: (s: string) => process.stderr.write(`${s}\n`),
  };
  const base = opts.nexusBaseUrl ?? resolveDaemonEndpoint()?.baseUrl;
  if (base === undefined) {
    rawOut.error('✗ 데몬 주소를 모른다 — `elanous nexus show`');
    return { exitCode: 1 };
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${base}${ADMIN_MCP_RELOAD_PATH}`;
  const token = readAcpToken();
  const out = {
    log: (s: string) => rawOut.log(maskTokenInText(s, token)),
    error: (s: string) => rawOut.error(maskTokenInText(s, token)),
  };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (err: unknown) {
    out.error(`✗ NEXUS 데몬에 닿지 못했습니다 (${url})`);
    out.error(`  ${err instanceof Error ? err.message : String(err)}`);
    out.error('  데몬이 없으면 재장전할 대상도 없습니다 — `elanous nexus run` 으로 띄우면 기동 경로가 config 를 새로 읽습니다.');
    return { exitCode: 1 };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    out.error(`✗ 데몬 응답을 JSON 으로 못 읽었습니다 (HTTP ${res.status})`);
    return { exitCode: 1 };
  }

  if (!res.ok) {
    const rec = (body ?? {}) as Record<string, unknown>;
    out.error(`✗ MCP 재장전 실패 (HTTP ${res.status}): ${String(rec.error ?? 'unknown')}`);
    if (typeof rec.hint === 'string') out.error(`  ${rec.hint}`);
    if (typeof rec.message === 'string') out.error(`  ${rec.message}`);
    if (res.status === 401) {
      if (token) out.error('  토큰은 있다 — 값은 출력하지 않습니다.');
      else out.error('  토큰을 못 읽었다 — config 의 acp-token 을 읽을 수 없어 Authorization 헤더를 붙이지 않았습니다.');
    }
    // ⭐ 실측 2026-09-10: 이 라우트 «전»에 뜬 데몬은 404 가 아니라 **405
    //    method-not-allowed** 를 낸다(모르는 POST 경로의 일반 폴백). 그 문면만
    //    보면 「내가 메서드를 잘못 썼나」로 읽힌다 — 그러니 도구가 말해 준다.
    //    ⛔ 이 한 번의 재부팅은 「구조가 재부팅을 요구한다」가 아니라 「재부팅을
    //       없애는 코드를 «싣는» 재부팅」이다. 그 뒤로는 다시 필요 없다.
    if (res.status === 404 || res.status === 405) {
      out.error('  이 데몬은 mcp-reload 배선 «없이» 떴습니다 — 한 번만 재부팅하면 그 뒤로는 이 명령이 듭니다:');
      out.error('    launchctl kickstart -k "gui/$(id -u)/com.elanous.nexus"');
    }
    return { exitCode: 1 };
  }

  const rec = (body ?? {}) as Record<string, unknown>;
  if (rec.reloaded === false) {
    out.log(`· 재장전을 건너뛰었습니다 — ${String(rec.skippedReason ?? 'unknown')}`);
    out.log('  config 의 `mcp.enabled` 가 false 입니다.');
    return { exitCode: 0, registered: 0 };
  }

  const registered = typeof rec.registered === 'number' ? rec.registered : 0;
  const perServer = (rec.perServer ?? {}) as Record<string, ServerRow>;
  const ids = Object.keys(perServer).sort();
  const failedIds = ids.filter((id) => String(perServer[id]?.status ?? '') === 'failed');
  if (failedIds.length > 0) {
    const named = failedIds
      .map((id) => {
        const cls = perServer[id]?.reasonClass;
        return typeof cls === 'string' && cls.length > 0 ? `${id}(${cls})` : id;
      })
      .join(' · ');
    out.log(`⚠ 끊긴 서버 ${failedIds.length}개 — ${named}`);
  } else {
    out.log(`✓ MCP 재장전 완료 — 서버 ${ids.length}개 · 도구 ${registered}개 등록`);
  }
  let failed = 0;
  for (const id of ids) {
    const row = perServer[id] ?? {};
    const status = String(row.status ?? 'unknown');
    const count = typeof row.toolCount === 'number' ? row.toolCount : 0;
    const mark = status === 'ready' ? '✓' : status === 'disabled' ? '·' : '✗';
    if (status === 'failed') failed += 1;
    const tail = typeof row.reason === 'string' && row.reason.length > 0 ? ` — ${row.reason}` : '';
    out.log(`  ${mark} ${id.padEnd(16)} ${status.padEnd(8)} tools=${count}${tail}`);
  }
  // ⭐ 서버 «하나»가 실패해도 나머지는 붙었다. 그래서 exit 는 「전부 초록인가」가
  //    아니라 「실패가 있나」로 가른다 — 스크립트가 그 차이를 읽을 수 있어야 한다.
  return { exitCode: failed > 0 ? 1 : 0, registered };
}
