import { Suspense } from 'react';
import { InsidePage } from '@/components/inside/InsidePage';
import { INSIDE_LOOP_INTERACTION } from './loop-focus';

export const metadata = { title: '엘라누스 안쪽 · elanous' };

export default function Page() {
  // `/inside?ref=<루프 id>` 조작의 진입 계약 — 고른 루프 ID 를 읽는 파라미터 이름을 children(InsidePage) 호출부에 배선한다.
  return <Suspense fallback={null}><InsidePage loopInteraction={INSIDE_LOOP_INTERACTION} /></Suspense>;
}
