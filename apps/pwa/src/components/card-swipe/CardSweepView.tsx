'use client';

// R5.2 — card stack + swipe state machine.
//
// Renders up to N sessions as a stack of SessionCards. The topmost
// card receives 4-direction swipe gestures (attachSwipe4); each
// direction maps to a decision the parent dispatches via `onDecision`:
//
//   left  → 'reject'
//   right → 'approve'
//   up    → 'pause'
//   down  → 'expand'
//
// Decision semantics are defined by the caller (R5.4 wires them to
// ACP messages); this component is concerned only with gesture →
// decision routing + advancing the stack. Keyboard fallbacks (arrow
// keys + space) so the view is usable without touch.
//
// Cross-ref:
//   apps/pwa/src/components/card-swipe/SessionCard.tsx (item)
//   apps/pwa/src/lib/swipe-gesture.ts (attachSwipe4)
//   내부 문서 `ROADMAP-pwa-pre-ios-gap-2026-05-09` §R5

import { useCallback, useEffect, useRef, useState } from 'react';

import { attachSwipe4, type SwipeDirection4 } from '@/lib/swipe-gesture';
import { SessionCard, type CardSessionData } from './SessionCard';

export type CardDecision = 'reject' | 'approve' | 'pause' | 'expand';

const DIRECTION_TO_DECISION: Record<SwipeDirection4, CardDecision> = {
  left: 'reject',
  right: 'approve',
  up: 'pause',
  down: 'expand',
};

const KEY_TO_DECISION: Record<string, CardDecision> = {
  ArrowLeft: 'reject',
  ArrowRight: 'approve',
  ArrowUp: 'pause',
  ArrowDown: 'expand',
  // Mouse-only fallback for desktop users — space = approve (the
  // most-likely decision per dogfood expectation).
  ' ': 'approve',
};

interface Props {
  sessions: readonly CardSessionData[];
  /** Called when the topmost card receives a decision. Parent owns
   *  the dispatch (POST to `/v1/control-signals` · ACP forward · etc.). */
  onDecision: (session: CardSessionData, decision: CardDecision) => void;
  /** Optional empty-state message. Defaults to a localized hint. */
  emptyText?: string;
  /** Test seam — disable the stack visual (no transforms) for SSR. */
  disableStackTransform?: boolean;
}

const DEFAULT_EMPTY = '진행 중인 대화 없음 · 새 대화를 시작하세요';

export function CardSweepView({
  sessions,
  onDecision,
  emptyText = DEFAULT_EMPTY,
  disableStackTransform: _disableStackTransform = false,
}: Props) {
  const [topIndex, setTopIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Reset the cursor when the sessions list shrinks below the
  // current top index (e.g. a session was removed externally).
  useEffect(() => {
    if (topIndex >= sessions.length) setTopIndex(0);
  }, [sessions.length, topIndex]);

  const top = sessions[topIndex];

  const dispatch = useCallback(
    (decision: CardDecision) => {
      if (!top) return;
      onDecision(top, decision);
      setTopIndex((idx) => Math.min(idx + 1, sessions.length));
    },
    [top, sessions.length, onDecision],
  );

  // Swipe gesture binding. Re-attach when the topmost card id
  // changes so the closure captures the right session.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !top) return;
    return attachSwipe4(el, {
      onSwipe: (dir) => dispatch(DIRECTION_TO_DECISION[dir]),
    });
  }, [top, dispatch]);

  // Keyboard fallback — no listener bound when the deck is empty so
  // arrow keys retain their default behavior on the surrounding page.
  useEffect(() => {
    if (!top) return;
    const onKey = (e: KeyboardEvent) => {
      const decision = KEY_TO_DECISION[e.key];
      if (!decision) return;
      e.preventDefault();
      dispatch(decision);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [top, dispatch]);

  if (!top) {
    return (
      <div
        data-testid="card-sweep-empty"
        className="flex h-72 items-center justify-center rounded-2xl border border-dashed border-border text-sm text-muted-foreground"
      >
        {emptyText}
      </div>
    );
  }

  // Render up to 3 cards — top + 2 peeking behind. Cuts memory
  // pressure on long active lists; the user only ever sees 3 anyway.
  const visible = sessions.slice(topIndex, topIndex + 3);

  return (
    <div
      ref={containerRef}
      data-testid="card-sweep-view"
      data-top-index={topIndex}
      className="relative h-72 select-none touch-none"
      role="region"
      aria-label="대화 카드 데크 · 좌우 = 거절/승인 · 위 = 잠시 멈춤 · 아래 = 펼치기"
      tabIndex={0}
    >
      {visible.map((s, i) => (
        <SessionCard
          key={s.id}
          session={s}
          active={i === 0}
          stackIndex={i}
        />
      ))}
      <div
        data-testid="card-sweep-progress"
        className="absolute -bottom-6 left-0 right-0 text-center text-[10px] text-muted-foreground"
      >
        {topIndex + 1} / {sessions.length}
      </div>
    </div>
  );
}
