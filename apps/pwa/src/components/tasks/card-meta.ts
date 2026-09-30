// 보드 카드 아래 한 줄 — 사람이 읽는 모양으로(원시 ISO 시각 · «Incidents 0 · —» 를 싣지 않는다).

/** «방금 · N분 전 · N시간 전» — 하루가 넘으면 기기 시간대의 «M/D HH:MM». */
export function relativeTime(at: number, now: number, timeZone?: string): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
  const parts = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) })
    .formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 카드 메타 조각: 열린 사고가 있으면 «사고 N» · 런이 있으면 «런 abcd1234» · 마지막에 시각. */
export function cardMetaParts(card: { runId?: string | null; updatedAt: number }, openIncidents: number, now: number, timeZone?: string): string[] {
  return [
    ...(openIncidents > 0 ? [`사고 ${openIncidents}`] : []),
    ...(card.runId ? [`런 ${card.runId.replace(/^run-/, '').slice(0, 8)}`] : []),
    relativeTime(card.updatedAt, now, timeZone),
  ];
}
