'use client';

import { useEffect, useState } from 'react';
import { listOpenDecisions, type OpenDecision } from '@/lib/decisions-api';

/** 마감-오름순, 같은 마감은 raisedAt 순 — 동률은 소스 순서를 유지한다(안정 정렬). */
function queueOrder(items: OpenDecision[]): OpenDecision[] {
  return [...items].sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity)
    || (a.raisedAt ?? '').localeCompare(b.raisedAt ?? ''));
}

type QueueState = { total: number; items: OpenDecision[]; error: string | null; loading: boolean };

/** 읽기 전용 «결정 대기 N» 칸 — N 은 «총» 열린 결정 수(상위 3건으로 잘리면 «상위 3건 표시»로 명시) ·
 *  상위 3건 + /decisions 링크. decide 호출은 하지 않는다(뒤 조각). */
export function AutopilotDecisionQueue({ client }: { client: { fetchResponse: (path: string, init?: RequestInit) => Promise<Response> } }) {
  const [queue, setQueue] = useState<QueueState>({ total: 0, items: [], error: null, loading: true });

  useEffect(() => {
    let active = true;
    setQueue({ total: 0, items: [], error: null, loading: true });
    void listOpenDecisions(client).then(items => {
      const ordered = queueOrder(items);
      if (active) setQueue({ total: ordered.length, items: ordered.slice(0, 3), error: null, loading: false });
    }).catch(error => {
      if (active) setQueue({ total: 0, items: [], error: error instanceof Error ? error.message : String(error), loading: false });
    });
    return () => { active = false; };
  }, [client]);

  return <section aria-label="결정 대기" className="mb-4 rounded-xl border border-border bg-card p-4">
    {queue.loading ? <p role="status">결정 대기 읽는 중</p>
      : queue.error ? <p role="alert">결정 대기 못 읽음 · {queue.error}</p>
      : queue.total === 0 ? <p>열린 결정 없음</p>
      : <div>
        <p className="text-sm font-medium">{`결정 대기 ${queue.total}건${queue.total > queue.items.length ? ' · 상위 3건 표시' : ''}`}</p>
        <ol className="mt-2 space-y-1">
          {queue.items.map(item => <li key={item.id} className="text-sm break-words">
            <span aria-label={item.title}>{`${item.title}${item.dueAt ? ` · 기한 ${item.dueAt}` : ''}`}</span>
          </li>)}
        </ol>
      </div>}
    <a href="/decisions" className="mt-2 inline-block text-sm underline">결정 대기 카드 열기</a>
  </section>;
}