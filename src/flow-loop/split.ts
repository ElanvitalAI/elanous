import type { TaskCard } from '../task-cards/card-store.js';

export interface SplitCell { id: string; title: string; seat?: string; host?: string }

/** FLOW1: only explicitly assigned work may enter a seat's queue. The same proposal is used in shadow and live. */
export function splitCard(card: TaskCard, _opts: { shadow?: boolean } = {}): SplitCell[] {
  const intake = [...card.sections].reverse().find(section => section.key.startsWith('intake:wish:'));
  let text = card.title;
  if (intake) {
    let body: unknown;
    try { body = JSON.parse(intake.content); } catch { body = intake.content; }
    if (typeof body === 'string') text = body;
    else if (body && typeof body === 'object' && typeof (body as { text?: unknown }).text === 'string') text = (body as { text: string }).text;
  }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const cells: SplitCell[] = lines.map((line, index) => {
    const match = /^(?:[-*]|\d+[.)])?\s*\[(OP|MK|TC|UX)\]\s*(.+)$/u.exec(line);
    if (match) return { id: `${card.id}-${index + 1}`, title: match[2]!.trim(), seat: match[1]! };
    // 담당 없는 행도 칸으로 남긴다 — seat 가 없으니 대기열엔 못 들어가고 tick 이 unplaced-no-owner 로 센다.
    return { id: `${card.id}-${index + 1}`, title: line.replace(/^(?:[-*]|\d+[.)])\s*/u, '') };
  });
  // 의뢰 본문이 있으면 담당이 하나도 없어도 행마다 칸으로 남긴다. 본문 없이 제목뿐일 때만 카드 한 칸.
  return intake || cells.some(cell => cell.seat) ? cells : [{ id: card.id, title: card.title }];
}
