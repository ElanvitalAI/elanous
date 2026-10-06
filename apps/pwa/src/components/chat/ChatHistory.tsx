'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChatMessageView } from './ChatMessage';
import { ChatPendingDecision } from './ChatPendingDecision';
import type { ChatMessage } from '@/lib/chat-runtime';
import {
  createStickState, findScrollViewport, followBehavior, isScrollIntentKey, onUserScroll,
  shouldFollowOnGrowth, shouldShowJumpToBottom, USER_SCROLL_INTENT_EVENTS, type StickState,
} from '@/lib/chat-autoscroll';
import {
  loadSnapshot,
  saveSnapshot,
  snapshotKey,
} from '@/lib/snapshot';

interface Props {
  messages: ChatMessage[];
  pending: boolean;
  /** BACKLOG #3 — workspace tab id for scroll-position snapshot. */
  tabId?: string;
}

const SCROLL_PERSIST_DEBOUNCE_MS = 250;

/** 컴포저(입력창)가 마지막 줄을 덮지 않도록 두는 바닥 여백.
 *  📏 실측 2026-08-21: 컴포저 83px · 스크롤러 paddingBottom «0px» ⇒ 마지막 줄이 입력창에 붙었다. */
const COMPOSER_CLEARANCE = 'pb-24';

export function ChatHistory({ messages, pending, tabId }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const persistKey = snapshotKey('chatScroll', tabId);

  // BACKLOG #3 — restore the persisted scrollTop on first mount so an
  // LRU-frozen tab returns to the same vertical position the user left
  // it at. We *don't* override the auto-scroll-to-bottom on subsequent
  // message updates — that's still endRef.scrollIntoView below.
  useEffect(() => {
    const root = findScrollViewport(viewportRef.current);
    if (!root) return;
    const stored = loadSnapshot<number>(persistKey);
    if (typeof stored === 'number' && stored > 0) {
      root.scrollTop = stored;
    }
  }, [persistKey]);

  // Persist scrollTop whenever the user scrolls — debounced so a fast
  // wheel doesn't write 60 entries/sec.
  useEffect(() => {
    const root = findScrollViewport(viewportRef.current);
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        saveSnapshot(persistKey, root.scrollTop);
      }, SCROLL_PERSIST_DEBOUNCE_MS);
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [persistKey]);

  // ⛔⭐⭐ **「자라는 것」을 따라간다 — 「늘어나는 것」만이 아니라.**
  //
  //  📏 초판은 `[messages.length, pending]` 에만 반응했다. 그래서 마지막 메시지가
  //    스트리밍으로 «자라는» 동안 화면이 그대로 있고 새 줄이 컴포저 뒤로 숨었다
  //    (대표 2026-08-21: *"스크롤이 답답하고 하단 작업이 가려진다"*).
  //  ⇒ `ResizeObserver` 로 내용 높이 변화를 직접 본다.
  //  ⛔ 그리고 «무조건» 따라가지 않는다 — 위로 올려 읽는 사람을 낚아채지 않는다(`shouldFollow`).
  const [detached, setDetached] = useState(false);
  const stickRef = useRef<StickState>(createStickState());
  const userJustSentRef = useRef(false);
  const lastCountRef = useRef(messages.length);
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (messages.length > lastCountRef.current && last?.role === 'user') {
      userJustSentRef.current = true;
    }
    lastCountRef.current = messages.length;
  }, [messages]);

  useEffect(() => {
    const root = findScrollViewport(viewportRef.current);
    const content = endRef.current?.parentElement;
    if (!root || !content) return;

    // ⛔⭐⭐ **선언이 «앞»이어야 한다** — `follow(false)` 가 아래에서 바로 불리므로
    //   이 `let` 이 뒤에 있으면 TDZ 로 «죽는다»(타입 검사로는 안 잡힌다 · 실제로 한 번 그랬다).
    let pointerDragging = false;

    const follow = (streaming: boolean): void => {
      // ⛔⭐ 사람이 «누르고 있는 동안»은 따라가지 않는다 — 스크롤바를 잡고 있는데 화면이
      //   튀면 조작 자체가 불가능하다. 손을 떼면 `endPointerDrag` 가 최종 위치로 확정한다.
      if (pointerDragging) return;
      const geometry = {
        scrollTop: root.scrollTop,
        scrollHeight: root.scrollHeight,
        clientHeight: root.clientHeight,
      };
      setDetached(shouldShowJumpToBottom(geometry));
      // ⛔ 「지금 거리」가 아니라 «사람이 마지막에 정한 붙어 있음»으로 판단한다.
      //   성장 자체가 거리를 벌리므로, 지금 재면 바닥에 있던 사람도 못 따라간다.
      if (!shouldFollowOnGrowth(stickRef.current, userJustSentRef.current)) return;
      userJustSentRef.current = false;
      // ⛔ 센티넬(`endRef`)로 `scrollIntoView` 하면 «그 아래 패딩만큼» 늘 빈 채로 멈춘다
      //   (하단 여백 96px 을 두었으므로 항상 96px 이 남는다). 그래서 컨테이너를 «진짜 끝»으로 민다.
      root.scrollTo({ top: root.scrollHeight, behavior: followBehavior(streaming) });
    };

    follow(false);

    const geometry = () => ({
      scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight,
    });

    // ⛔⭐⭐⭐ **`scroll` 은 「버튼을 띄울까」만 정한다 — 「붙어 있음」은 «건드리지 않는다».**
    //
    //  📏 2026-08-22(대표 *"스크롤링 하단으로 내리기가 작동이 잘 안 된다"*): 초판은 여기서
    //  `onUserScroll` 을 불렀다. ⇒ ***프로그램 스크롤도 `scroll` 을 낸다.***
    //  「맨 아래로」가 `smooth` 로 내려가는 «동안» 중간 위치들이 흘러들어
    //  ***방금 `true` 로 되돌린 `stuck` 이 곧바로 `false` 가 됐고***, 마운트의 `follow(false)` 도
    //  `smooth` 라 ***자동 따라가기가 처음부터 죽었다.***
    //  ⇒ 🔑 위치만 보는 이 갱신은 «안전»하다(상태를 안 바꾼다).
    // ⛔⭐⭐ **스크롤바 드래그는 «한 순간»이 아니라 «구간»이다** — 무인 리뷰 must-fix(PR #11311):
    //   *"`pointerdown` 뒤 RAF 는 썸이 실제로 이동하기 «전»에 측정되며, 이후 drag 의 `scroll` 은
    //   버튼만 갱신하므로 `stickRef` 가 갱신되지 않는다."* ⇒ ***스크롤바로 위로 읽어도 낚아채진다.***
    //   ⛔📏 1차 수렴은 「그 구간의 `scroll` 을 사람으로 친다」였고 리뷰가 **다시** 짚었다 —
    //     *"일반 클릭·텍스트 선택 중 도는 프로그램 smooth 스크롤도 사람으로 오판한다."*
    //   🔑 ⇒ 그래서 구간이 하는 일을 ***「판정」에서 「멈춤」으로*** 바꿨다:
    //     누르는 동안 **따라가기를 멈추고**(`follow` 첫 줄) 「붙어 있음」은 «안 건드린다».
    //     손을 뗄 때 «최종 위치»로 **한 번** 확정한다 ⇒ 일반 클릭이면 위치가 그대로라 오판이 없다.
    let pendingFrame: number | null = null;

    const measureAsUser = (): void => {
      const g = geometry();
      stickRef.current = onUserScroll(stickRef.current, g);
      setDetached(shouldShowJumpToBottom(g));
    };

    const handleScrollPosition = (): void => {
      // ⛔⭐ 드래그 «중»에도 「붙어 있음」을 «안 바꾼다» — 무인 리뷰 must-fix 2차(PR #11311):
      //   *"`pointerdown` 을 뷰포트 «내부의 모든 클릭»에 대해 켜므로, 일반 클릭·텍스트 선택 중
      //   진행되는 프로그램 smooth 스크롤도 사람으로 오판한다."*
      //   🔑 ⇒ 드래그는 «구간»이되, 그 구간에서 하는 일은 ***「판정」이 아니라 「멈춤」***이다.
      //     손을 뗄 때 «최종 위치»로 «한 번» 확정한다(`endPointerDrag`).
      setDetached(shouldShowJumpToBottom(geometry()));
    };

    // ⭐⭐ 「붙어 있음」은 ***사람의 입력***으로만 바뀐다 — 프로그램 스크롤은 입력을 내지 않으므로
    //   원리상 오판될 수 없다. ⚠️ 입력 «직후»엔 아직 안 움직였으므로 다음 프레임에 잰다.
    const handleUserIntent = (e: Event): void => {
      if (e.type === 'keydown' && !isScrollIntentKey((e as KeyboardEvent).key)) return;
      if (e.type === 'pointerdown') {
        // ⭐ 누르고 있는 «구간» — 이 동안 자동 따라가기를 멈춘다(사람이 조작 중이다).
        //   ⛔ 여기서 「붙어 있음」을 판정하지 «않는다» — 아직 안 움직였고,
        //     일반 클릭인지 스크롤바 드래그인지 이 시점엔 알 수 없다.
        pointerDragging = true;
        // ⛔⭐⭐⭐ **진행 중이던 프로그램 `smooth` 스크롤을 «여기서 멈춘다»** —
        //   무인 리뷰 must-fix 3차(PR #11311): *"이미 진행 중인 smooth 스크롤 중 콘텐츠를
        //   클릭했다가 `pointerup` 하면 «중간 프로그램 위치»를 확정해 `stuck=false` 로 오판한다."*
        //   🔑 누른 «그 순간»의 자리에 못 박으면, 그 뒤의 위치 변화는 ***사람의 것뿐***이다.
        //     ⇒ 「일반 클릭은 오판 불가」가 «그제서야» 참이 된다.
        root.scrollTo({ top: root.scrollTop, behavior: 'auto' });
        return;
      }
      if (typeof requestAnimationFrame === 'function') {
        // ⭐ 예약한 프레임은 cleanup 에서 «취소»한다 — 안 하면 언마운트 뒤 옛 뷰포트를 재서
        //   상태를 흔든다(무인 리뷰 should-fix).
        if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
        pendingFrame = requestAnimationFrame(() => { pendingFrame = null; measureAsUser(); });
      } else {
        measureAsUser();
      }
    };
    const endPointerDrag = (): void => {
      if (!pointerDragging) return;
      pointerDragging = false;
      // ⭐ 손을 뗀 «최종» 위치로 «한 번» 확정한다.
      //   ⛔ 일반 클릭이면 위치가 그대로이므로 판정도 그대로다 — 오판이 없다.
      measureAsUser();
    };

    root.addEventListener('scroll', handleScrollPosition, { passive: true });
    // ⛔⭐⭐⭐ **`pointerdown` 은 «감싸는 쪽»에 건다** — 무인 리뷰 must-fix 3차(PR #11311):
    //   *"Radix `ScrollArea` 의 스크롤바/썸은 Viewport 밖의 «sibling» 이므로 `root` 에만 걸면
    //   스크롤바 드래그 시작을 «받지 못한다»."* ⇒ 그러면 드래그 중 follow 가 사람을 바닥으로 끈다.
    //   📏 그리고 ***내 라이브 실험이 그것을 못 잡았다*** — 뷰포트에 이벤트를 «직접 쏴서»
    //     진짜 스크롤바 경로를 한 번도 안 거쳤다(리뷰가 「Goodhart」라 부른 그것).
    //   ⇒ 🔑 wrapper(`viewportRef.current`)는 뷰포트 ⊕ 스크롤바를 «둘 다» 품는다.
    const intentRoot: HTMLElement = viewportRef.current ?? root;
    for (const type of USER_SCROLL_INTENT_EVENTS) {
      // ⭐ 휠·터치는 뷰포트에서 나지만 wrapper 로 «버블»한다 — 한 곳에 걸면 둘 다 받는다.
      intentRoot.addEventListener(type, handleUserIntent, { passive: true });
    }
    // ⚠️ 손을 떼는 것은 뷰포트 «밖»에서도 일어난다(드래그 중 커서가 벗어난다) ⇒ window 에 건다.
    const win = typeof window !== 'undefined' ? window : null;
    win?.addEventListener('pointerup', endPointerDrag, { passive: true });
    win?.addEventListener('pointercancel', endPointerDrag, { passive: true });

    const detach = (): void => {
      if (pendingFrame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = null;
      }
      root.removeEventListener('scroll', handleScrollPosition);
      for (const type of USER_SCROLL_INTENT_EVENTS) intentRoot.removeEventListener(type, handleUserIntent);
      win?.removeEventListener('pointerup', endPointerDrag);
      win?.removeEventListener('pointercancel', endPointerDrag);
    };
    if (typeof ResizeObserver === 'undefined') return detach;
    const ro = new ResizeObserver(() => { follow(true); });
    ro.observe(content);
    return () => { ro.disconnect(); detach(); };
  }, [messages.length, pending]);

  // ⛔⭐ 훅은 «조기 반환 앞»에 둔다. 2026-08-21: 이 `useCallback` 을 아래(빈 대화 반환 뒤)에
  //   두었더니 렌더마다 훅 수가 달라져 ***PWA 가 통째로 죽었다***
  //   (`Application error: a client-side exception has occurred`).
  //   ⚠️ 이 저장소엔 리액트 시험 도구가 «없어» 시험으로는 원리상 못 잡는다 — 실물이 잡았다.
  const jumpToBottom = useCallback(() => {
    const root = findScrollViewport(viewportRef.current);
    // ⭐ 눌렀다는 것은 「다시 따라와라」는 의도다 — 상태를 «붙임»으로 되돌린다.
    stickRef.current = { stuck: true };
    root?.scrollTo({ top: root.scrollHeight, behavior: 'smooth' });
  }, []);

  if (messages.length === 0 && !pending) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
        <p>무엇이든 말을 걸어 보세요.</p>
        <p className="text-xs"><code className="rounded bg-muted px-1.5 py-0.5 font-mono">:help</code> 를 치면 명령 목록이 나옵니다.</p>
        <ChatPendingDecision />
      </div>
    );
  }

  return (
    <div ref={viewportRef} className="relative flex-1 min-h-0">
      <ScrollArea className="h-full">
        <div className={`flex flex-col gap-1 pt-2 ${COMPOSER_CLEARANCE}`}>
          {messages.map((m) => (
            <ChatMessageView key={m.id} message={m} />
          ))}
          <ChatPendingDecision />
          {pending && (
            <div className="flex justify-start px-4 py-3">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                thinking…
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </ScrollArea>
      {/* ⛔⭐ 「맨 아래로」 — 한 번 위로 올라가면 «다시 내려올 수단»이 없어서 답답했다
          (대표 2026-08-21). 떨어졌을 때만 뜬다. */}
      {detached && (
        <button
          type="button"
          onClick={jumpToBottom}
          data-elanous-jump-to-bottom="true"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur transition-colors hover:bg-accent"
        >
          맨 아래로 ↓
        </button>
      )}
    </div>
  );
}
