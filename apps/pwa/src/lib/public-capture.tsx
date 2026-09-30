'use client';
// «공개 캡처»(`?capture=public`) — 녹화·스크린샷 전에 켠다. 주소는 마운트 뒤에 읽는다(SSR·시험 환경엔 window 가 없다).
import { useEffect, useState, type ReactNode } from 'react';

export function isPublicCaptureUrl(search: string): boolean {
  return new URLSearchParams(search).get('capture') === 'public';
}

export function usePublicCapture(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => { if (typeof window !== 'undefined' && isPublicCaptureUrl(window.location.search)) setOn(true); }, []);
  return on;
}

/** Renders nothing in public capture — for money/usage chips (USD · credits) that must not appear in public footage. */
export function HideInPublicCapture({ children }: { children: ReactNode }) {
  return usePublicCapture() ? null : <>{children}</>;
}
