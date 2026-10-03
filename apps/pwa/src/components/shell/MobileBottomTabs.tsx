'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MoreHorizontal, X } from 'lucide-react';
import { usePwaRole } from '@/lib/pwa-role';
import { routeMaturity } from '@/lib/route-maturity';
import { useShowBeta } from '@/lib/show-beta';
import { useOperator } from '@/lib/use-operator';
import { NAV_GROUPS, NAV_SHOW_HIDDEN_KEY, NAV_SHOW_LABS_KEY, SIDEBAR_NAV_ITEMS, visibleNavGroups, type NavGroupId } from './sidebar-nav-items';
import { NAV_PREFS_EVENT, readFlag } from './nav-visibility-prefs';

export function MobileBottomTabs() {
  const pathname = usePathname();
  const role = usePwaRole();
  const { showBeta } = useShowBeta();
  const operator = useOperator();
  const [prefs, setPrefs] = useState({ showLabs: false, showHidden: false });
  const [open, setOpen] = useState<NavGroupId | 'more' | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const read = () => setPrefs({ showLabs: readFlag(NAV_SHOW_LABS_KEY), showHidden: readFlag(NAV_SHOW_HIDDEN_KEY) });
    read();
    window.addEventListener(NAV_PREFS_EVENT, read);
    window.addEventListener('storage', read);
    return () => { window.removeEventListener(NAV_PREFS_EVENT, read); window.removeEventListener('storage', read); };
  }, []);
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(null); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const links = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)'));
      if (!links.length) return;
      const first = links[0]!;
      const last = links[links.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(event.target as Node)) dialogRef.current.focus();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
      triggerRef.current?.focus();
    };
  }, [open]);

  const visible = visibleNavGroups(SIDEBAR_NAV_ITEMS, prefs, role, operator, { showBeta });
  const allowed = new Set([...visible.main, ...visible.labs, ...visible.hidden]);
  const items = SIDEBAR_NAV_ITEMS.filter((item) => allowed.has(item));
  const groups = NAV_GROUPS.map((group) => ({ ...group, items: items.filter((item) => item.group === group.id) }))
    .filter((group) => group.items.length > 0);
  const tabs = groups.filter((group) => group.bottomTab);
  const extra = groups.filter((group) => !group.bottomTab);
  const path = (pathname ?? '/').replace(/\/+$/, '') || '/';
  const isActive = (item: typeof items[number]) => path === item.href || (item.href !== '/' && path.startsWith(`${item.href}/`))
    || (item.activeAlso ?? []).some((href) => path === href || path.startsWith(`${href}/`));
  const activeGroup = groups.find((group) => group.items.some(isActive));
  const sheetGroups = open === 'more' ? extra : groups.filter((group) => group.id === open);
  useEffect(() => {
    if (open && !sheetGroups.length) setOpen(null);
  }, [open, sheetGroups.length]);

  return (
    <>
      <nav aria-label="아래 탭" className="h-[calc(3.5rem+env(safe-area-inset-bottom))] shrink-0 border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
        <div className="flex h-full items-stretch">
          {tabs.map((group) => {
            const Icon = group.icon;
            const selected = activeGroup?.id === group.id;
            const className = `flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-xs ${selected ? 'font-semibold text-primary' : 'text-muted-foreground'}`;
            return group.items.length === 1 ? (
              <Link key={group.id} href={group.items[0]!.href as never} aria-label={group.label} aria-current={selected ? 'page' : undefined} className={className}>
                <Icon aria-hidden className="h-5 w-5" /><span>{group.label}</span>
                {role === 'general' && showBeta && group.items[0]!.href !== '/settings' && routeMaturity(group.items[0]!.href) === 'beta' && <span className="text-[10px] text-primary">실험</span>}
              </Link>
            ) : (
              <button key={group.id} type="button" aria-label={group.label} aria-expanded={open === group.id} aria-controls="mobile-nav-sheet" onClick={(event) => { triggerRef.current = event.currentTarget; setOpen(group.id); }} className={className}>
                <Icon aria-hidden className="h-5 w-5" /><span>{group.label}</span>
              </button>
            );
          })}
          <button type="button" aria-label="더보기" aria-expanded={open === 'more'} aria-controls="mobile-nav-sheet" onClick={(event) => { triggerRef.current = event.currentTarget; setOpen('more'); }} className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-xs ${activeGroup && !activeGroup.bottomTab ? 'font-semibold text-primary' : 'text-muted-foreground'}`}>
            <MoreHorizontal aria-hidden className="h-5 w-5" /><span>더보기</span>
          </button>
        </div>
      </nav>
      {open && sheetGroups.length > 0 && (
        <div className="fixed inset-0 z-50">
          <button type="button" aria-label="메뉴 닫기" className="absolute inset-0 bg-black/40" onClick={() => setOpen(null)} />
          <div ref={dialogRef} id="mobile-nav-sheet" role="dialog" aria-modal="true" aria-label={open === 'more' ? '더보기' : groups.find((group) => group.id === open)?.label} tabIndex={-1} className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-xl border border-border bg-background px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-lg">
            <div className="flex items-center justify-between">
              <span className="font-semibold">{open === 'more' ? '더보기' : groups.find((group) => group.id === open)?.label}</span>
              <button type="button" aria-label="메뉴 닫기" onClick={() => setOpen(null)} className="rounded-md p-2"><X aria-hidden className="h-5 w-5" /></button>
            </div>
            {sheetGroups.map((group) => (
              <section key={group.id} aria-label={group.label} className="mt-2">
                {open === 'more' && group.items.length > 1 && <h2 className="px-2 py-1 text-xs font-semibold text-muted-foreground">{group.label}</h2>}
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const experimental = role === 'general' && showBeta && item.href !== '/settings' && routeMaturity(item.href) === 'beta';
                  return <Link key={item.href} href={item.href as never} aria-current={isActive(item) ? 'page' : undefined} onClick={() => setOpen(null)} className="flex items-center gap-3 rounded-md px-3 py-3 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Icon aria-hidden className="h-4 w-4" />{item.label}
                    {experimental && <span className="rounded border border-primary/40 px-1 text-[10px] text-primary">실험</span>}
                  </Link>;
                })}
              </section>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
