// 넥서스 밖 텔레그램 폴러 → core 워크플로 트리거 전달.
//
// `elanous telegram run` 은 core 와 다른 프로세스라 `workflowDaemon.dispatchTelegram` 을 직접 못 부른다.
// core 의 `POST /v1/workflows/telegram-dispatch`(bearer)로 넘긴다. core 가 재시작 중이면(연결 실패·503)
// 짧게 재시도하고, 그래도 안 되면 버리고 관측을 남긴다 — 큐는 아직 없다(관측으로 빈도를 먼저 잰다).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from './debug/log.js';
import { getElanousConfigDir } from './elanous-config-dir.js';
import { readNexusRuntime } from './nexus/runtime.js';
import type { TelegramEvent } from './workflow-runtime/triggers/telegram-source.js';

export type TelegramDispatchResults = Array<{ workflowName: string; nodeId: string; ok: boolean; error?: string }>;

export interface TelegramDispatchForwardDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: () => string | null;
  token?: () => string | null;
  attempts?: number;
  retryMs?: number;
}

/** 런타임 파일의 pid 가 살아 있나 — 죽은 데몬이 남긴 파일의 포트는 «지금 다른 프로세스»의 것일 수 있다. */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** 이 우주의 core 주소. 런타임이 없거나, 포트가 없거나, 그 pid 가 죽었으면 `null` — 보내지 않는다.
 *  🩸 2026-09-25 실측: 테스트 우주에 09-10 에 죽은 넥서스(pid 47214)의 runtime.json 이 `httpPort: 31415` 로 남아 있었고,
 *  그 포트는 지금 운영 넥서스다 ⇒ 테스트 러너가 운영 core 로 보냈다(401 · 토큰이 없어 피해 0). */
export function defaultBaseUrl(deps: { runtime?: () => ReturnType<typeof readNexusRuntime>; alive?: (pid: number) => boolean } = {}): string | null {
  const rt = (deps.runtime ?? readNexusRuntime)();
  if (typeof rt?.httpPort !== 'number') return null;
  if (!(deps.alive ?? pidAlive)(rt.pid)) {
    debug.log('telegram.run', 'core-runtime-stale', { pid: rt.pid, httpPort: rt.httpPort, startedAt: rt.startedAt });
    return null;
  }
  const rawHost = rt.httpHost ?? '127.0.0.1';
  const host = rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost;
  return `http://${host}:${rt.httpPort}`;
}

export function defaultToken(): string | null {
  const p = join(getElanousConfigDir(), 'acp-token');
  try { return existsSync(p) ? readFileSync(p, 'utf-8').trim() || null : null; } catch { return null; }
}

/** core 로 넘긴다. 성공하면 core 의 결과를, 끝내 못 넘기면 빈 배열을 돌려준다(폴러는 멈추지 않는다). */
export async function forwardTelegramDispatch(
  event: TelegramEvent,
  deps: TelegramDispatchForwardDeps = {},
): Promise<TelegramDispatchResults> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, deps.attempts ?? 3);
  const retryMs = deps.retryMs ?? 2_000;
  const token = (deps.token ?? defaultToken)();
  const base = (deps.baseUrl ?? (() => defaultBaseUrl()))();
  if (base === null) {
    debug.log('telegram.run', 'workflow-dispatch-skipped', { kind: event.kind, reason: 'no-core-runtime' });
    return [];
  }
  const url = `${base}/v1/workflows/telegram-dispatch`;
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ event }),
      });
      if (res.ok) {
        const body = await res.json() as { results?: TelegramDispatchResults };
        const results = Array.isArray(body.results) ? body.results : [];
        debug.log('telegram.run', 'workflow-dispatch-forwarded', { kind: event.kind, attempt, matched: results.length });
        return results;
      }
      last = `http ${res.status}`;
      // 401·400 은 다시 쳐도 같다 — 503(데몬 기동 중)만 재시도한다.
      if (res.status !== 503) break;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (attempt < attempts) await sleep(retryMs);
  }
  debug.log('telegram.run', 'workflow-dispatch-failed', { kind: event.kind, attempts, reason: last, tokenPresent: token !== null });
  return [];
}
