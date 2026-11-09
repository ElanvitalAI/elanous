'use client';

import dynamic from 'next/dynamic';

export const TuiMirrorViewLazy = dynamic(
  () => import('./TuiMirrorView').then((module) => module.TuiMirrorView),
  { ssr: false, loading: () => null },
);
