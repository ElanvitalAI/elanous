'use client';

import Link from 'next/link';
import { DesignCheckPanel } from '@/components/design/DesignCheckPanel';

export default function DesignCheckPage() {
  return (
    <div className="space-y-3">
      <div className="mx-auto max-w-3xl px-6 pt-6">
        <Link href="/apps" className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          ← 앱 스튜디오
        </Link>
      </div>
      <DesignCheckPanel />
    </div>
  );
}
