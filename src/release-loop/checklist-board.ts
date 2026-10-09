import { debug } from '../debug/log.js';
import { checklistDevVersion, listChecklist, summarizeChecklist, type Checklist } from './checklist.js';

/** One text board shared by the Telegram and TUI slash surfaces. */
export function renderChecklistBoard(checklist: Checklist): string {
  const { green, yellow, red, done, blocked } = summarizeChecklist(checklist);
  const { bySeat } = summarizeChecklist({
    ...checklist,
    items: checklist.items.filter((item) => item.status === 'yellow'),
  });
  return [
    `판 ${checklist.version} · 초록 ${green} · 노랑 ${yellow} · 빨강 ${red} · 끝 ${done}`,
    `빨강 칸: ${blocked.join(', ') || '-'}`,
    `자리별 노랑: ${Object.entries(bySeat).sort(([a], [b]) => a.localeCompare(b)).map(([seat, count]) => `${seat} ${count}`).join(' · ') || '-'}`,
  ].join('\n');
}

/** Read and render the selected board without turning failures into zero counts. */
export function checklistBoardSlash(args: readonly string[], read: (version: string) => Checklist = listChecklist): string {
  if (args.length > 1) return '사용법: /board [판]';
  try {
    return renderChecklistBoard(read(args[0] ?? checklistDevVersion()));
  } catch (error) {
    debug.log('release.checklist', 'board-read-failed', { version: args[0] ?? null, error: error instanceof Error ? error.message : String(error) });
    return '판 체크리스트를 못 읽었다 — 「없다」가 아니다';
  }
}
