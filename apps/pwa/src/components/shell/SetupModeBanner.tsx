'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useNexusHealthIfMounted } from '@/nexus/hooks/use-nexus-state';
import { setupModeBannerText } from '@/lib/setup-mode';

export function SetupModeBanner() {
  const pathname = usePathname();
  const healthQuery = useNexusHealthIfMounted();
  const text = pathname == null || healthQuery.isError || healthQuery.isPending || healthQuery.isLoading
    ? null
    : setupModeBannerText(healthQuery.data, pathname);
  if (!text) return null;

  return (
    <div
      role="status"
      data-testid="setup-mode-banner"
      className="flex items-center justify-between gap-3 border-b border-border bg-muted px-3 py-1.5 text-xs text-foreground"
    >
      <span>{text}</span>
      <Link href="/setup" className="shrink-0 font-semibold underline underline-offset-2">
        /setup
      </Link>
    </div>
  );
}
