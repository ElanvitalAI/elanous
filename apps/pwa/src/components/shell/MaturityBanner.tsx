'use client';

import { usePathname } from 'next/navigation';
import { routeMaturity } from '@/lib/route-maturity';

export function MaturityBanner() {
  const pathname = usePathname();
  const maturity = routeMaturity(pathname ?? '');
  if (maturity !== 'beta' && maturity !== 'broken') return null;
  return (
    <div role="status" className="border-b border-border bg-muted px-4 py-2 text-sm text-foreground">
      {maturity === 'beta' ? '베타 — 화면과 동작이 바뀔 수 있습니다.' : '이 화면은 지금 고치는 중입니다.'}
    </div>
  );
}
