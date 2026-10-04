// R4 (2026-07-07) — finance dashboard read API (ROADMAP-organic-signal-engine).
//
//   GET /v1/dashboard/summary   — 캡스톤 국면·신호 통계·디깅·알파 헤더
//   GET /v1/dashboard/timeline  — 신호 타임라인 (?hours=48&floor=6)
//   GET /v1/dashboard/heatmap   — 자산×국가×섹터 매력도 + US 섹터 + 뉴스 분포
//   GET /v1/dashboard/digs      — 디깅 리포트 피드 (?limit=20)
//   GET /v1/dashboard/loop-activity — 루프 활동 그래프 (?since=24h)
//
// 전부 read-only · 캐시/로컬 SQLite 만 (dashboard-data.ts) — 라이브 fetch 없음.
// PWA 폴링(60s) 대상. reflection.ts 패턴(CORS·checkAuth seam) 상속.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  dashboardSummary, dashboardTimeline, dashboardHeatmap, dashboardDigs, dashboardSchedules, dashboardOntology, dashboardBacktest, dashboardLoops, dashboardOps, dashboardOpsMission,
} from '../../domains/dashboard-data.js';
import { readLiveSnapshot } from '../../domains/market-live.js';
import { marketSessions } from '../../domains/finance.js';
import { loopActivity } from '../../loops/activity.js';

export interface DashboardRouteOpts {
  /** Auth check seam. */
  checkAuth?: (req: Request) => boolean;
  /** Test seam — 실제 detached 수집 spawn 대체. */
  spawnCollector?: () => void;
  /** Read-only activity provider for isolated route tests. */
  loopActivity?: typeof loopActivity;
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '600',
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

/** /v1/dashboard/:section → section 이름 (미지원 경로 null). */
export function parseDashboardPath(pathname: string): string | null {
  const m = /^\/v1\/dashboard\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  const seg = decodeURIComponent(m[1]!);
  return ['summary', 'timeline', 'heatmap', 'digs', 'schedules', 'ontology', 'backtest', 'loops', 'loop-activity', 'ops'].includes(seg) ? seg : null;
}

/** POST /v1/dashboard/refresh-live — 온디맨드 라이브 재수집 트리거 (refresh 버튼 설계 ·
 *  대표 지시 2026-07-07). 게이트: ①장중(세션 라이브)만 ②최근 3분 내 수집분 있으면 skip
 *  (연타 방지). 수집은 detached 자식 프로세스(스크립트 재사용) — 데몬 이벤트루프 무차단.
 *  응답 즉시 {started|skipped} — PWA 가 지연 재로드로 새 스냅샷 픽업. */
export function handleDashboardRefreshLive(req: Request, opts: DashboardRouteOpts = {}): Response {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (opts.checkAuth && !opts.checkAuth(req)) return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  const s = marketSessions();
  const alive = s.usLive || s.krLive || s.usOvernight;
  if (!alive) return jsonResponse({ ok: true, started: false, reason: 'market_closed', session: { us: s.us, kr: s.kr } }, 200);
  const fresh = readLiveSnapshot(3); // 3분 rate guard
  if (fresh) return jsonResponse({ ok: true, started: false, reason: 'fresh', ts: fresh.ts }, 200);
  try {
    if (opts.spawnCollector) {
      opts.spawnCollector();
    } else {
      // 데몬은 레포 루트에서 기동(`nexus run` 관례) — 번들 실행에서 import.meta 가
      // 어긋날 수 있어 cwd 기준. 없으면 소스 트리 기준 폴백.
      const candidates = [
        join(process.cwd(), 'scripts/market-live-snapshot.ts'),
        join(import.meta.dir, '../../../scripts/market-live-snapshot.ts'),
      ];
      const script = candidates.find(p => existsSync(p));
      if (!script) return jsonResponse({ ok: false, error: 'collector_script_not_found' }, 500);
      const child = spawn(process.execPath, [script, '--force'], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    return jsonResponse({ ok: true, started: true, etaSec: 45 }, 202);
  } catch (e) {
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message.slice(0, 100) : String(e) }, 500);
  }
}

export function handleDashboard(req: Request, section: string, opts: DashboardRouteOpts = {}): Response {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'GET') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
  if (opts.checkAuth && !opts.checkAuth(req)) return jsonResponse({ ok: false, error: 'unauthorized' }, 401);

  const q = new URL(req.url).searchParams;
  const num = (k: string, d: number) => {
    const v = Number(q.get(k));
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  try {
    switch (section) {
      case 'summary': return jsonResponse({ ok: true, summary: dashboardSummary() }, 200);
      case 'timeline': return jsonResponse({ ok: true, signals: dashboardTimeline(num('hours', 48), num('floor', 6)) }, 200);
      case 'heatmap': return jsonResponse({ ok: true, heatmap: dashboardHeatmap() }, 200);
      case 'digs': return jsonResponse({ ok: true, digs: dashboardDigs(num('limit', 20)) }, 200);
      case 'schedules': return jsonResponse({ ok: true, schedules: dashboardSchedules() }, 200);
      case 'ontology': return jsonResponse({ ok: true, ontology: dashboardOntology() }, 200);
      case 'backtest': return jsonResponse({ ok: true, backtest: dashboardBacktest() }, 200);
      case 'loops': return jsonResponse({ ok: true, loops: dashboardLoops() }, 200);
      case 'loop-activity': return jsonResponse({ ok: true, activity: (opts.loopActivity ?? loopActivity)({ since: q.get('since') ?? '24h' }) }, 200);
      case 'ops': {
        const mid = q.get('mission');
        if (mid) return jsonResponse({ ok: true, missionDetail: dashboardOpsMission(mid) }, 200);
        return jsonResponse({ ok: true, ops: dashboardOps() }, 200);
      }
      default: return jsonResponse({ ok: false, error: 'unknown_section' }, 404);
    }
  } catch (e) {
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message.slice(0, 120) : String(e) }, 500);
  }
}
