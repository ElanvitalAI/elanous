'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { SIDEBAR_NAV_ITEMS } from '@/components/shell/sidebar-nav-items';

export default function NotFound() {
  const pathname = usePathname();
  const missingPath = pathname || '알 수 없는 주소';

  return (
    <main data-testid="not-found" className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40 px-6 py-12 sm:px-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10">
        <header className="flex flex-col gap-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">elanous PWA</p>
          <h1 className="text-3xl font-bold leading-tight sm:text-4xl">여기엔 없습니다</h1>
          <p className="text-sm text-muted-foreground"><code>{missingPath}</code> 주소는 이 앱에 없습니다. 갈 수 있는 화면을 선택하세요.</p>
        </header>
        <nav aria-label="이동 가능한 화면">
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {SIDEBAR_NAV_ITEMS.map(({ href, label }) => <li key={href}>
              <Link href={href} className="block rounded-lg border border-border bg-card p-4 font-medium hover:border-primary">{label}</Link>
            </li>)}
          </ul>
        </nav>
      </div>
    </main>
  );
}
