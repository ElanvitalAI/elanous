'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { routeMaturity } from '@/lib/route-maturity';

function insideDemo() {
  if (typeof window === 'undefined') return false;
  const demo = new URL(window.location.href).searchParams.get('demo');
  if (demo !== null) return demo === '1';
  try { return window.localStorage.getItem('elanous.inside.demo') === '1'; } catch { return false; }
}

export function MaturityBanner() {
  const pathname = usePathname();
  const inside = pathname?.replace(/\/+$/, '') === '/inside' || pathname?.replace(/\/+$/, '') === '/app/inside';
  const [demo, setDemo] = useState<boolean | null>(null);
  useEffect(() => {
    if (!inside) return;
    const sync = () => setDemo(insideDemo());
    sync();
    window.addEventListener('elanous:inside-demo', sync);
    return () => window.removeEventListener('elanous:inside-demo', sync);
  }, [inside]);
  const maturity = routeMaturity(inside ? '/inside' : pathname ?? '');
  if ((inside && demo === true) || (maturity !== 'beta' && maturity !== 'broken')) return null;
  return (
    <div role="status" className="border-b border-border bg-muted px-4 py-2 text-sm text-foreground">
      {maturity === 'beta' ? '베타 — 화면과 동작이 바뀔 수 있습니다.' : '이 화면은 지금 고치는 중입니다.'}
    </div>
  );
}
