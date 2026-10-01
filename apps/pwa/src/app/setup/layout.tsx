// PWA `/setup` Phase 1 (2026-05-19) — wizard layout shell.
//
// v2 단순화: step machine 없음. 단순 wrapper — header (logo) + main.
// `/setup` 자체와 `/setup/done` 만 라우트 됨. 추가 step 도입 시 본 layout
// 이 sidebar 등을 흡수하도록 grow.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'elanous · setup',
  description: 'First-time LLM provider setup for elanous PWA.',
};

export default function SetupLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          elanous · 셋업
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          AI 연결
        </h1>
        <p className="text-sm text-muted-foreground">
          대화를 시작하려면 쓸 AI 하나만 골라 주세요. 나머지(페르소나 · 채널 · 아이폰 · 음성)는{' '}
          <span className="font-mono">/settings</span> 에서 언제든 바꿀 수 있어요.
        </p>
      </header>
      <section className="flex flex-1 flex-col">{children}</section>
    </main>
  );
}
