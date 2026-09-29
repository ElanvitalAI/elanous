// `/v1/live/detail` — Live 탭 «화려함 MAX» 스위치(대표 2026-09-28 · 기획 #21443 §0c).
// GET = 지금 상태(꺼짐이면 `{ on: false }`) · POST `{ scope?: 'all'|'<runId>', ttlMin?: number, by? }` = 켜기(ttlMin 0 = 끄기).
// 소유자 토큰만(승인 탭과 같은 `checkAuth`). 상태는 파일(`src/live/detail-switch.ts`) — 하니스·런이 다른 프로세스에서 읽는다.

import { debug } from '../../debug/log.js';
import { LIVE_DETAIL_DEFAULT_TTL_MIN, readLiveDetail, writeLiveDetail } from '../../live/detail-switch.js';
import { jsonResponse } from './json-response.js';

export const LIVE_DETAIL_PATH = '/v1/live/detail';

export interface LiveDetailDeps {
  authorize?: (request: Request) => boolean;
  path?: string;
  now?: () => number;
}

function view(state: ReturnType<typeof readLiveDetail>, now: number) {
  return state
    ? { on: true, scope: state.scope, since: state.since, until: state.until, remainingMs: Math.max(0, state.until - now), ...(state.by ? { by: state.by } : {}) }
    : { on: false, defaultTtlMin: LIVE_DETAIL_DEFAULT_TTL_MIN };
}

export async function handleLiveDetail(req: Request, deps: LiveDetailDeps = {}): Promise<Response> {
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') return jsonResponse({ error: 'method-not-allowed' }, 405);
  if (!deps.authorize?.(req)) {
    debug.log('live.detail', 'refused', { method, reason: 'unauthorized' });
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const now = deps.now?.() ?? Date.now();
  const fileOpts = deps.path ? { path: deps.path } : {};
  if (method === 'GET') return jsonResponse(view(readLiveDetail({ ...fileOpts, now }), now));
  let body: { scope?: unknown; ttlMin?: unknown; by?: unknown } = {};
  try { body = (await req.json()) as typeof body; } catch { /* 빈 본문 = 기본값으로 켜기 */ }
  if (body.ttlMin !== undefined && (typeof body.ttlMin !== 'number' || !Number.isFinite(body.ttlMin) || body.ttlMin < 0)) {
    return jsonResponse({ error: 'invalid-ttl' }, 400);
  }
  if (body.scope !== undefined && (typeof body.scope !== 'string' || !/^(all|[\w.:-]{1,128})$/.test(body.scope))) {
    return jsonResponse({ error: 'invalid-scope' }, 400);
  }
  const state = writeLiveDetail({
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
    ...(typeof body.ttlMin === 'number' ? { ttlMin: body.ttlMin } : {}),
    ...(typeof body.by === 'string' ? { by: body.by.slice(0, 64) } : {}),
  }, { ...fileOpts, now });
  return jsonResponse(view(state, now));
}
