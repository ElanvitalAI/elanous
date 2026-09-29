// NEXUS · POST /v1/schedules/action — 스케줄 쓰기 액션 (P2 · 2026-07-08)
//
// /scheduler PWA 가 read(/v1/dashboard/schedules) 옆에서 adopt/release/enable/
// disable/delete/update/create 를 실행하는 창구. **CLI(elanous cron)·tool
// (schedule_manage) 과 동일한 dispatchScheduleManage 백엔드를 재사용**해 전 표면이 한
// 진실(schedule_registry)을 조작하도록 한다 — 표면별 로직 중복 없음.
//
// dashboard 계열 write(refresh-live) 과 같은 신뢰 수준(loopback + tailscale
// serve 로만 노출). 파괴적 액션(delete/adopt)은 자동 백업(~/.elanous/backups) 이
// dispatchScheduleManage 안에서 보장.

import { jsonResponse } from './http-server.js';

interface ScheduleActionBody {
  action?: string;
  id?: string;
  cron?: string;
  command?: string;
  category?: string;
  note?: string;
  confirm?: boolean;
}

export async function handleSchedulesActionPost(
  req: Request,
  dispatch?: (args: Record<string, unknown>) => Promise<unknown>,
): Promise<Response> {
  let body: ScheduleActionBody;
  try {
    body = (await req.json()) as ScheduleActionBody;
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!action) return jsonResponse({ error: 'action 필수 (adopt/release/enable/disable/delete/update/create)' }, 400);
  if (['delete', 'migrate', 'adopt', 'release'].includes(action) && body.confirm !== true) {
    const id = typeof body.id === 'string' ? body.id : '';
    return jsonResponse({ dryRun: true, action, id,
      plan: `${id || '(id 미지정)'}: ${action} 적용 예정 — confirm:true 로 확인 후 실행.` });
  }

  const run = dispatch ?? (await import('../../domains/schedule-manage-tool.js')).dispatchScheduleManage;
  const result = await run({
    action,
    ...(body.id !== undefined ? { id: body.id } : {}),
    ...(body.cron !== undefined ? { cron: body.cron } : {}),
    ...(body.command !== undefined ? { command: body.command } : {}),
    ...(body.category !== undefined ? { category: body.category } : {}),
    ...(body.note !== undefined ? { note: body.note } : {}),
  });
  // dispatchScheduleManage 는 {error} 또는 결과 객체를 반환 — 그대로 전달(프론트가 판정).
  return jsonResponse(result);
}
