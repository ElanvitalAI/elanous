'use client';

import { useEffect, useState, type ReactNode } from 'react';

interface Props {
  activeId: string | null;
  tabs: readonly string[];
  status: 'connected' | 'connecting' | 'disconnected';
  onSwitch: (id: string) => void;
  onAdd: () => void;
  actions: ReactNode;
  children: ReactNode;
}

const connection = {
  connected: { label: '연결됨', color: 'bg-emerald-500' },
  connecting: { label: '연결 중', color: 'bg-amber-500' },
  disconnected: { label: '끊김', color: 'bg-rose-500' },
} as const;

export function CompactTerminalBar({ activeId, tabs, status, onSwitch, onAdd, actions, children }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    if (!sheetOpen && !pickerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setPickerOpen(false); setSheetOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerOpen, sheetOpen]);

  return <>
    <div className="relative flex h-10 max-h-10 shrink-0 items-center justify-between border-b border-zinc-800 bg-background px-2" aria-label="간결한 터미널 상단바">
      <div className="relative min-w-0 max-w-[calc(50%_-_12px)] flex-1">
        <button type="button" className="max-w-full truncate rounded px-2 py-1 text-left text-xs" aria-label="터미널 고르기" aria-expanded={pickerOpen} onClick={() => { setSheetOpen(false); setPickerOpen((open) => !open); }}>
          {activeId ?? '터미널 준비 중'} ▾
        </button>
        {pickerOpen && <div className="absolute left-0 top-full z-40 max-h-[60vh] min-w-48 overflow-auto rounded border border-zinc-700 bg-background p-1 shadow-xl" role="menu" aria-label="열린 터미널">
          {tabs.map((id) => <button key={id} type="button" role="menuitem" className="block w-full truncate rounded px-2 py-2 text-left text-sm hover:bg-accent" aria-current={id === activeId ? 'true' : undefined} onClick={() => { onSwitch(id); setPickerOpen(false); }}>{id}</button>)}
          <button type="button" role="menuitem" className="block w-full rounded px-2 py-2 text-left text-sm hover:bg-accent" onClick={() => { onAdd(); setPickerOpen(false); }}>+ 새 터미널</button>
        </div>}
      </div>
      <span className={`absolute left-1/2 h-2 w-2 -translate-x-1/2 rounded-full ${connection[status].color}`} title={connection[status].label} aria-label={connection[status].label} role="status" />
      <button type="button" className="shrink-0 rounded px-2 py-1 text-lg leading-none" aria-label="터미널 더보기" aria-expanded={sheetOpen} onClick={() => { setPickerOpen(false); setSheetOpen((open) => !open); }}>⋯</button>
    </div>
    {sheetOpen && <button type="button" className="fixed inset-0 z-40 bg-black/50" aria-label="터미널 메뉴 닫기" onClick={() => setSheetOpen(false)} />}
    <section className={sheetOpen ? 'fixed inset-x-0 bottom-0 z-50 max-h-[75dvh] overflow-y-auto rounded-t-xl border-t border-zinc-700 bg-background p-4 shadow-2xl' : 'hidden'} aria-label="터미널 더보기 시트" aria-hidden={!sheetOpen}>
      <div className="mb-3 flex items-center justify-between"><span className="text-sm font-medium">터미널 동작</span><button type="button" onClick={() => setSheetOpen(false)} aria-label="터미널 메뉴 닫기">닫기</button></div>
      <div className="flex flex-wrap gap-2 border-b border-zinc-800 pb-3">{children}</div>
      <div className="pt-3">{actions}</div>
    </section>
  </>;
}
