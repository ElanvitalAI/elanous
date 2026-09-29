'use client';

// Intake 화면 위에 «승인 대기 아이디어 PR»을 한 줄로 알린다 — 승인 탭이 사이드바에만 있어서 Intake 에서 안 보였다.
// 목록을 못 읽으면(권한 없음·오프라인) 아무것도 그리지 않는다.

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { createMergeApprovalsApi, type MergeApproval } from '@/lib/merge-approvals-api';

type PendingItem = Pick<MergeApproval, 'number' | 'title' | 'state' | 'draft'>;

export function pendingApprovals<T extends PendingItem>(items: readonly T[]): T[] {
  return items.filter((item) => item.state === 'OPEN' && !item.draft);
}

export function IntakeApprovalsBannerView({ items }: { items: readonly PendingItem[] }) {
  const pending = pendingApprovals(items);
  if (pending.length === 0) return null;
  const shown = pending.slice(0, 3);
  return (
    <div className="mx-auto max-w-lg px-4 pt-4">
    <section aria-label="승인 대기" className="rounded-lg border border-emerald-600/40 bg-emerald-500/10 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">흡수 아이디어 승인 대기 {pending.length}건</p>
        <Link href="/approvals" className="rounded-md bg-emerald-700 px-3 py-1 text-white hover:bg-emerald-800">Approvals 에서 보기 →</Link>
      </div>
      <ul className="mt-2 space-y-1">
        {shown.map((item) => (
          <li key={item.number} className="break-words">
            <Link href={`/approvals?pr=${item.number}`} className="underline">#{item.number}</Link> · {item.title}
          </li>
        ))}
        {pending.length > shown.length && <li className="text-muted-foreground">외 {pending.length - shown.length}건</li>}
      </ul>
    </section>
    </div>
  );
}

export function IntakeApprovalsBanner() {
  const { client } = useDaemon();
  const api = useMemo(() => createMergeApprovalsApi({ client }), [client]);
  const [items, setItems] = useState<MergeApproval[]>([]);
  useEffect(() => {
    let active = true;
    api.list().then(({ items: listed }) => { if (active) setItems(listed); }).catch(() => { if (active) setItems([]); });
    return () => { active = false; };
  }, [api]);
  return <IntakeApprovalsBannerView items={items} />;
}
