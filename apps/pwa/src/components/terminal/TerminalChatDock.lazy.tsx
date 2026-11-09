'use client';

import dynamic from 'next/dynamic';
export const TerminalChatDockLazy = dynamic(
  () => import('./TerminalChatDock').then((module) => module.TerminalChatDock),
  { ssr: false, loading: () => null },
);
