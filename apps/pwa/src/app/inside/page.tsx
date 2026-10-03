import { Suspense } from 'react';
import { InsidePage } from '@/components/inside/InsidePage';

export const metadata = { title: '엘라누스 안쪽 · elanous' };

export default function Page() {
  return <Suspense fallback={null}><InsidePage /></Suspense>;
}
