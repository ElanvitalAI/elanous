'use client';

import dynamic from 'next/dynamic';
import type { ComponentProps } from 'react';
import type { XtermView } from './XtermView';

type XtermViewProps = ComponentProps<typeof XtermView>;

const LazyXtermView = dynamic<XtermViewProps>(
  () => import('./XtermView').then((module) => module.XtermView),
  {
    ssr: false,
    loading: ({ error, retry }) => (
      <div className="flex h-full min-h-0 w-full items-center justify-center bg-[#0d0c08] text-sm text-[#e9e3d4]" role={error ? 'alert' : 'status'}>
        {error ? (
          <div className="flex flex-col items-center gap-2">
            <span>터미널을 불러오지 못했습니다.</span>
            <button type="button" className="rounded border border-[#e9e3d4]/50 px-3 py-1 hover:bg-white/10" onClick={retry}>
              다시 시도
            </button>
          </div>
        ) : '터미널 연결 중…'}
      </div>
    ),
  },
);

export function XtermViewLazy(props: XtermViewProps) {
  return <LazyXtermView {...props} />;
}
