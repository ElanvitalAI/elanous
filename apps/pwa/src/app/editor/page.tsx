'use client';

import { Suspense } from 'react';
import { GraphEditor } from '@/components/editor/GraphEditor';

export default function EditorPage() {
  return <Suspense fallback={<p className="p-4 text-sm">편집기를 불러오는 중…</p>}><GraphEditor /></Suspense>;
}
