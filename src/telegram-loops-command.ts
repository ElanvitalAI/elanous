import { dashboardLoops } from './domains/dashboard-data.js';
import { readSchedulesInventory } from './nexus/api/schedules-read.js';
import { loadLoopRows, LOOP_SCHEDULES_PATH, LOOPS_PATH } from './loops/status-rows.js';

export interface LoopsSources {
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
    if (!rows.length) return '모두 정상';
    const problems = rows.filter(row => row.verdict === '늦음' || row.verdict === '실패');
    const ordered = [
      ...problems.filter(row => row.verdict === '늦음'),
      ...problems.filter(row => row.verdict === '실패'),
    ];
    const summary = (['살아 있음', '꺼짐', '판정 불가'] as const)
      .map(verdict => `${verdict} ${rows.filter(row => row.verdict === verdict).length}`).join(' · ');
    const lines = ['루프·크론 현황'];
    let shown = 0;
    for (const row of ordered.slice(0, 10)) {
      const line = `• ${row.verdict === '늦음' ? '🔴' : '❌'} ${row.verdict} · ${clean(row.name)} (${clean(row.layer)}) · ${clean(row.mode)} · 마지막 ${row.lastRun ?? '기록 없음'} · ${clean(row.id)}`;
      // Leave room for the summary and an omission count under Telegram's 4096-character cap.
      if (lines.join('\n').length + line.length + summary.length + 60 > 4000) break;
      lines.push(line);
      shown++;
    }
    if (shown < ordered.length) lines.push(`… ${ordered.length - shown}개 더`);
    lines.push(summary);
    return lines.join('\n');
  } catch {
    return '루프 현황 못 읽음';
  }
}
