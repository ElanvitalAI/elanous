'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

/** 지금 주소의 질의(`?view=…`)를 위로 올린다 — useSearchParams 는 정적 export 에서 Suspense 안에서만 쓸 수 있어
 *  메뉴 전체가 아니라 이 탐침만 감싼다(LOOP-NAV-ACTIVE · SidebarNav 의 Showroom 주석과 같은 이유). */
export function NavSearchProbe({ onSearch }: { onSearch: (search: string) => void }): null {
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? '';
  useEffect(() => { onSearch(search); }, [search, onSearch]);
  return null;
}
