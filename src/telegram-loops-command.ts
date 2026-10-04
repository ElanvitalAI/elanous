import { dashboardLoops } from './domains/dashboard-data.js';
import { readSchedulesInventory } from './nexus/api/schedules-read.js';
import { loadLoopRows, LOOP_SCHEDULES_PATH, LOOPS_PATH, type LoopRow } from './loops/status-rows.js';

interface LoopsSources {
  schedules: () => unknown;
  loops: () => unknown;
  now: () => number;
}

const defaultSources: LoopsSources = {
  schedules: () => ({ schedules: readSchedulesInventory() }),
  loops: () => ({ loops: dashboardLoops() }),
  now: Date.now,
};

const clean = (text: string) => text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Read the same two inventories and apply the same row verdicts as PWA /loops. */
export async function telegramLoopsStatus(args: string[], sources: LoopsSources = defaultSources): Promise<string> {
  if (args.length) return '사용법: /loops';
  try {
    const rows = await loadLoopRows(async (path) => {
      if (path === LOOP_SCHEDULES_PATH) return sources.schedules();
      if (path === LOOPS_PATH) return sources.loops();
      throw new Error('unknown inventory');
    }, sources.now());
    if (!rows.length) return '등록된 루프·크론이 없습니다.';
    const counts = (['늦음', '실패', '살아 있음', '꺼짐', '판정 불가'] as const)
      .map(verdict => `${verdict} ${rows.filter(row => row.verdict === verdict).length}`);
    const priority: Record<LoopRow['verdict'], number> = { '늦음': 0, '실패': 1, '살아 있음': 2, '꺼짐': 3, '판정 불가': 4 };
    const lines = rows.slice().sort((a, b) => priority[a.verdict] - priority[b.verdict]).map(row =>
      `• ${row.verdict === '늦음' ? '🔴' : row.verdict === '실패' ? '❌' : row.verdict === '살아 있음' ? '🟢' : '⚪'} ${row.verdict} · ${clean(row.name)} (${clean(row.layer)}) · ${clean(row.mode)} · 마지막 ${row.lastRun ?? '기록 없음'} · ${clean(row.id)}`);
    let reply = ['루프·크론 현황', counts.join(' · ')].join('\n');
    for (const [index, line] of lines.entries()) {
      // Telegram caps a message at 4096 characters; leave space for an explicit omission count.
      if (reply.length + line.length + 35 > 4000) return `${reply}\n… ${lines.length - index}개 더 (메시지 길이 제한)`;
      reply += `\n${line}`;
    }
    return reply;
  } catch {
    return '루프 현황을 읽지 못했습니다. 일부 레지스트리 조회가 실패했습니다. 데몬 연결을 확인하세요.';
  }
}
