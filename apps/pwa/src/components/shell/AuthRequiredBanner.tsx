'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { dismissAuthRequired, onAuthRequired } from '@/lib/auth-required';

export function AuthRequiredBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => onAuthRequired(() => setVisible(true)), []);

  if (!visible) return null;
  return (
    <div role="alert" data-testid="auth-required-banner" className="flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground">
      <span>이 기기는 아직 데몬에 연결되지 않았습니다(인증 필요). 토큰이 있는 기기에서 설정 › 연결 토큰을 만들고, 이 기기의 설정 › 데몬 연결에 붙여넣으세요.</span>
      <Link href="/settings" className="shrink-0 font-semibold underline underline-offset-2">/settings</Link>
      <button type="button" aria-label="연결 안내 닫기" onClick={() => { dismissAuthRequired(); setVisible(false); }} className="shrink-0 rounded px-2 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">닫기</button>
    </div>
  );
}
