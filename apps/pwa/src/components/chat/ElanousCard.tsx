'use client';

import { useState } from 'react';
import type { ElanousCardData, ElanousCardKind } from '@/lib/elanous-card';

// REL9p — one card per ```elanous-card``` block (contract: src/domains/elanous-card.ts).
const HEADINGS: Record<ElanousCardKind, string> = {
  'coo-admin': '운영 할 일',
  'release-schedule': '판 일정',
  'release-checklist': '판별 칸',
};

const INITIAL_ITEMS = 12;

function safeHref(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed.includes('\\')) return undefined;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }
  return /^\/(?!\/)/.test(trimmed) ? trimmed : undefined;
}

/** «D-3» · «오늘» · «2일 지남» — from the server's daysLeft, not the viewer's clock. */
function dayBadge(daysLeft: number | null): { label: string; tone: 'overdue' | 'soon' | undefined } | undefined {
  if (daysLeft === null) return undefined;
  if (daysLeft < 0) return { label: `${-daysLeft}일 지남`, tone: 'overdue' };
  if (daysLeft === 0) return { label: '오늘', tone: 'soon' };
  return { label: `D-${daysLeft}`, tone: daysLeft <= 3 ? 'soon' : undefined };
}

export function ElanousCard({ card }: { card: ElanousCardData }) {
  const [expanded, setExpanded] = useState(false);
  const sorted = card.items.map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.daysLeft ?? Infinity) - (b.item.daysLeft ?? Infinity) || a.index - b.index);
  const visible = expanded ? sorted : sorted.slice(0, INITIAL_ITEMS);

  return (
    <section className="rounded-lg border border-border bg-card p-3 text-card-foreground" data-elanous-card-kind={card.kind}>
      <h3 className="mb-2 text-sm font-semibold">{HEADINGS[card.kind]} <span className="font-normal text-muted-foreground">· {card.items.length}</span></h3>
      {card.items.length === 0 && <p className="text-xs text-muted-foreground">항목이 없습니다</p>}
      <ul className="space-y-2">
        {visible.map(({ item, index }) => {
          const href = item.url ? safeHref(item.url) : undefined;
          const badge = dayBadge(item.daysLeft);
          return (
            <li key={index} className="rounded border border-border/60 px-2 py-1.5 text-sm" data-elanous-card-item={index}>
              <div className="flex flex-wrap items-baseline gap-2">
                {badge && (
                  <span
                    data-due-status={badge.tone}
                    className={badge.tone === 'overdue' ? 'font-semibold text-red-600 dark:text-red-400' : badge.tone === 'soon' ? 'font-semibold text-orange-600 dark:text-orange-400' : 'text-muted-foreground'}
                  >
                    {badge.label}
                  </span>
                )}
                {href
                  ? <a className="font-medium text-primary underline underline-offset-2" href={href} target="_blank" rel="noopener noreferrer">{item.title}</a>
                  : <span className="font-medium">{item.title}</span>}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {[item.state, item.owner, item.due ?? undefined].filter(Boolean).join(' · ')}
              </p>
            </li>
          );
        })}
      </ul>
      {card.items.length > INITIAL_ITEMS && !expanded && (
        <button type="button" className="mt-2 text-xs font-medium text-primary underline underline-offset-2" onClick={() => setExpanded(true)}>
          {card.items.length - INITIAL_ITEMS}개 더 보기
        </button>
      )}
    </section>
  );
}
