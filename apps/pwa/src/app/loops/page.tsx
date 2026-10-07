import { Suspense } from 'react';
import { LoopsView } from '@/components/loops/LoopsView';

// 정적 export — `?view=` 는 클라이언트에서 읽는다(useSearchParams 는 Suspense 경계 안).
export default function LoopsPage() {
  return <Suspense fallback={null}><LoopsView /></Suspense>;
}
