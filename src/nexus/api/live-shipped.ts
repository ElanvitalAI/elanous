// `/v1/live/shipped?since=<ISO|6h>` — Live 탭 SHIPPED(🅢 09-28 10:1x ①: «영웅 SHIPPED 0 은 치명적 — 병합 PR 수로»).
// 로그의 판단 이벤트가 아니라 **GitHub 의 병합 PR 수**다 — 우주(운영·시험·Pod)와 무관하게 같은 수가 나온다.
// 저장소 = Worktrees·Design 과 같은 해석(`harness.defaultRepo` → 데몬 cwd) 의 origin. ⛔ 데몬 이벤트 루프를 막지 않는다(비동기 spawn) ·
// 같은 창은 60초 캐시(Live 는 5초마다 묻는다). 못 셌으면 `merged: null` 과 이유 — 0 으로 접지 않는다.

import { debug } from '../../debug/log.js';
import { parseSinceParam } from './log-fabric.js';
import { resolveWorktreesRepoRoot } from './worktrees.js';
import { jsonResponse } from './json-response.js';

export const LIVE_SHIPPED_PATH = '/v1/live/shipped';
const CACHE_MS = 60_000;

export interface LiveShippedDeps {
  authorize?: (request: Request) => boolean;
  now?: () => number;
  /** 저장소 슬러그(`owner/name`) — 없으면 null. */
  repoSlug?: () => Promise<string | null>;
  /** 병합 PR 수 — gh 검색. 실패는 throw. */
  countMerged?: (slug: string, sinceIso: string) => Promise<number>;
}

async function run(cmd: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

/** `git@github.com:o/n.git` · `https://github.com/o/n(.git)` → `o/n`. */
export function slugFromRemote(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

async function defaultRepoSlug(): Promise<string | null> {
  const root = resolveWorktreesRepoRoot();
  if (!root) return null;
  const r = await run(['git', '-C', root, 'remote', 'get-url', 'origin']);
  return r.code === 0 ? slugFromRemote(r.out) : null;
}

async function defaultCountMerged(slug: string, sinceIso: string): Promise<number> {
  const q = `repo:${slug} is:pr is:merged merged:>=${sinceIso}`;
  const r = await run(['gh', 'api', '-X', 'GET', 'search/issues', '-f', `q=${q}`, '-f', 'per_page=1', '--jq', '.total_count']);
  if (r.code !== 0) throw new Error(`gh search failed rc=${r.code}: ${r.err.trim().slice(0, 200)}`);
  const n = Number(r.out.trim());
  if (!Number.isInteger(n) || n < 0) throw new Error(`gh search returned '${r.out.trim().slice(0, 40)}'`);
  return n;
}

const cache = new Map<string, { at: number; body: Record<string, unknown> }>();

export function _resetLiveShippedCacheForTest(): void { cache.clear(); }

export async function handleLiveShipped(req: Request, deps: LiveShippedDeps = {}): Promise<Response> {
  if (req.method.toUpperCase() !== 'GET') return jsonResponse({ error: 'method-not-allowed' }, 405);
  if (!deps.authorize?.(req)) return jsonResponse({ error: 'unauthorized' }, 401);
  const now = deps.now?.() ?? Date.now();
  const raw = new URL(req.url).searchParams.get('since') ?? '24h';
  const sinceMs = parseSinceParam(raw, now);
  if (sinceMs === null) return jsonResponse({ error: 'invalid-since' }, 400);
  // 분 단위로 내린다 — 같은 창의 반복 질문이 같은 캐시 키를 쓰게.
  const sinceIso = new Date(Math.floor(sinceMs / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const hit = cache.get(sinceIso);
  if (hit && now - hit.at < CACHE_MS) return jsonResponse({ ...hit.body, cached: true });
  const slug = await (deps.repoSlug ?? defaultRepoSlug)();
  if (!slug) return jsonResponse({ merged: null, since: sinceIso, reason: 'no-repository' });
  let body: Record<string, unknown>;
  try {
    const merged = await (deps.countMerged ?? defaultCountMerged)(slug, sinceIso);
    body = { merged, since: sinceIso, repo: slug, source: 'github' };
  } catch (e) {
    debug.log('live.shipped', 'count-failed', { reason: e instanceof Error ? e.message : String(e) });
    return jsonResponse({ merged: null, since: sinceIso, repo: slug, reason: 'gh-failed' });
  }
  cache.set(sinceIso, { at: now, body });
  return jsonResponse(body);
}
