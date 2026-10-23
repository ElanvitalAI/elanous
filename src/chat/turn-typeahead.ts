// ── 턴 중 타이핑 보존 (C-d-3' · 2026-07-13) ─────────────────────────────────
//
// 대표 dogfood: 턴 스트리밍 중 타이핑이 에코 없이 유실 — "포커스가 안 돌아온다"
// 체감의 실체. ref 정렬(RESEARCH-input-focus-essential §3b):
//   codex — 턴 중에도 composer 가 키를 받고 제출은 steer/queue 로 흡수
//           (`pending_steers`·`queued_user_messages`).
//   CC    — focus 식에 isLoading 없음 · 제출은 enqueue() + 버퍼 클리어.
// elanous: 스트리밍 키 사다리에서 printable/backspace/enter 를 이 버퍼로 보존
// (에코는 호출측이 composer zone 에 직접 페인트), 턴 종료 시 FIFO로 넘긴다.

import { pasteFoldToken, shouldFoldPaste } from './paste-fold.js';

export interface TurnTypeaheadState {
  /** 아직 Enter 하지 않은 현재 작성 중 입력. */
  buffer: string;
  /** Enter 한 입력들. 턴 종료 뒤 입력 순서대로 자동 제출한다. */
  queuedSubmissions: string[];
  /**
   * `queuedSubmissions` 와 같은 순서의 짝 — 턴 «안» 주입 레지스트리(`session/pending-input`) 항목 id.
   * `null`(또는 칸이 모자람) = 레지스트리에 안 넣은 항목. ⭐ 이 id 로 배수·되꺼내기·턴 종료 승격을
   * «짝지어» 떨어낸다 — 위치·문자열로 짝지으면 같은 발화가 두 번 들어간다(10-14 중복 수리).
   */
  queuedPendingIds?: (string | null)[];
  /** «지금 밀어 넣기»가 «다음 도구 경계 최우선»으로 떨어졌다(도는 도구가 취소 불가). 큐가 비거나 턴이 끝나면 지운다. */
  steerPriority?: boolean;
  /** 이번 턴에 도구 경계로 들어간 수 — 큐가 비었을 때 «✓ 넣음» 줄로 보인다. 턴이 끝나면 지운다. */
  injectedCount?: number;
  /**
   * 턴 중 긴 붙여넣기 — 버퍼엔 `[붙여넣음 #k · N줄 · M자]` 토큰, 원문은 여기(TUI-PASTE-WHILE-STREAMING · 10-22).
   * 제출·넘김 때 토큰을 원문으로 되돌린다. 짝이 없으면 칸을 두지 않는다.
   */
  pastes?: Array<[token: string, raw: string]>;
  /** 토큰 번호 — 한 버퍼 안에서 겹치지 않게. */
  pasteSeq?: number;
}

/** 버퍼 속 붙여넣기 토큰을 원문으로 되돌린다(한 번에 훑는다). 순수. */
export function expandTurnTypeaheadPastes(text: string, pastes: TurnTypeaheadState['pastes']): { text: string; used: number } {
  const held = (pastes ?? []).filter(([token]) => text.includes(token));
  if (held.length === 0) return { text, used: 0 };
  const map = new Map(held);
  const re = new RegExp(held.map(([t]) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return { text: text.replace(re, (m) => map.get(m) ?? m), used: held.length };
}

/** 버퍼(와 남길 글)에 더는 없는 붙여넣기 짝을 놓는다. 비면 칸을 뗀다. 순수. */
function prunePastes(state: TurnTypeaheadState): TurnTypeaheadState {
  if (!state.pastes) return state;
  const live = state.pastes.filter(([token]) => state.buffer.includes(token));
  if (live.length === state.pastes.length) return state;
  if (live.length > 0) return { ...state, pastes: live };
  const { pastes: _p, pasteSeq: _s, ...rest } = state;
  return rest;
}

/** 큐 길이에 맞춘 id 짝(모자라면 null 로 채운다). 순수. */
export function turnTypeaheadPendingIds(state: TurnTypeaheadState): (string | null)[] {
  const ids = state.queuedPendingIds ?? [];
  return state.queuedSubmissions.map((_, i) => ids[i] ?? null);
}

function presentIds(ids: readonly (string | null)[]): string[] {
  return ids.filter((id): id is string => typeof id === 'string');
}

/** 짝이 하나도 없으면 칸을 아예 안 둔다(`undefined` 키도 없이) — 레지스트리를 안 쓰는 경로의 상태 모양을 옛 그대로 둔다. */
function idsField(ids: readonly (string | null)[]): { queuedPendingIds?: (string | null)[] } {
  return ids.some(id => id !== null) ? { queuedPendingIds: [...ids] } : {};
}

/** 상태에서 id 짝 칸을 뗀다 — `idsField` 와 함께 써서 옛 짝이 스프레드로 살아남지 않게 한다. */
function withoutIds(state: TurnTypeaheadState): TurnTypeaheadState {
  if (!('queuedPendingIds' in state)) return state;
  const { queuedPendingIds: _ids, ...rest } = state;
  return rest;
}

/** 큐 index 번째 항목에 레지스트리 id 를 단다. 순수. 범위 밖이면 그대로. */
export function attachTurnTypeaheadPendingId(
  state: TurnTypeaheadState,
  index: number,
  id: string,
): TurnTypeaheadState {
  if (index < 0 || index >= state.queuedSubmissions.length) return state;
  const ids = turnTypeaheadPendingIds(state);
  ids[index] = id;
  return { ...withoutIds(state), ...idsField(ids) };
}

/**
 * 턴 «안» 주입(steer) 대상인가. ⛔ 슬래시는 뺀다 — 명령은 턴이 끝난 뒤 FIFO 로만 실행한다
 * (모델에 `/…` 문면이 발화로 들어가면 명령이 아니라 잡음이다 · Claude Code 도 같은 경계에서 뺀다).
 */
export function isTurnTypeaheadSteerable(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !trimmed.startsWith('/');
}

export function createTurnTypeaheadState(): TurnTypeaheadState {
  return { buffer: '', queuedSubmissions: [] };
}

/** printable 판정 — 단일 문자(한글 음절/자모·유니코드 포함) 또는 space.
 *  'up'/'tab'/'escape'/'pageup'/'f1' 같은 명명 키는 길이>1 이라 자연 배제.
 *  ★ j/k/f/g/G 도 문자로 취급한다. */
export function isTypeaheadPrintable(key: { name: string; ctrl?: boolean; alt?: boolean }): boolean {
  if (key.ctrl || key.alt) return false;
  if (key.name === 'space') return true;
  return [...key.name].length === 1;
}

export type TurnTypeaheadKeyResult = {
  state: TurnTypeaheadState;
  /** true = 이 키를 typeahead 가 소유(스트리밍 사다리의 다른 핸들러로 보내지 않음). */
  consumed: boolean;
  /** true = buffer/queue 가 바뀜 — 호출측이 에코를 다시 그린다. */
  changed: boolean;
  /** 등록소가 관측용으로 표시한 슬래시 명령의 즉시 실행 요청. 실행은 호출측의 책임이다. */
  immediateSubmission?: string;
  /** 비어 있지 않은 Enter 입력의 제출 경로 분류. */
  submissionDisposition?: 'immediate' | 'fifo';
  /** 큐에서 «다른 길»로 빠진 항목의 레지스트리 id — 호출측이 레지스트리에서도 떨어낸다(되꺼내기). */
  releasedPendingIds?: string[];
  /** 빈 입력에서 Enter(대기 항목이 있을 때) = «지금 밀어 넣기» 요청. 판정·실행은 호출측의 책임이다. */
  pushNowRequested?: boolean;
  /** 붙여넣기를 버퍼에 받았다 — 관측(`tui.paste`)은 호출측이 남긴다. */
  pasted?: { folded: boolean; lines: number; chars: number };
};

/** 등록소 소유의 관측용 표시 조회. 이름·문법·실행 정책은 이 순수 판정기에 두지 않는다. */
export type TurnTypeaheadImmediateSubmissionLookup = (text: string) => boolean;

/** 줄바꿈 키 — Shift+Enter · Alt+Enter · Ctrl+J(`input-control-key.ts` 와 같은 꼴). */
export function isTypeaheadNewlineKey(key: { name: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }): boolean {
  if (key.name === 'enter') return !key.ctrl && !key.meta && (!!key.shift || !!key.alt);
  return key.name === 'j' && !!key.ctrl && !key.alt && !key.shift && !key.meta;
}

/** 에코·큐 행은 한 줄로 그린다 — 버퍼 속 줄바꿈은 `↵` 로 보여 준다(행을 깨지 않는다). */
function oneLine(text: string): string {
  return text.replace(/\n/g, '↵');
}

/** 스트리밍 중 키 1개 판정(순수). mouse/비-press/수정키는 소유하지 않는다.
 *  - printable → buffer 누적
 *  - backspace → 마지막 코드포인트 제거(빈 버퍼면 미소유 — 기존 semantics 보존)
 *  - shift/alt+enter · ctrl+j → buffer 에 줄바꿈(빈 buffer 면 소유만)
 *  - enter → 비어 있지 않은 buffer를 FIFO 제출 큐에 넣고 다음 문장을 위한 buffer를 비운다
 *  - 빈 buffer 에서 enter(대기 항목이 있을 때) → «지금 밀어 넣기» 요청(`pushNowRequested`)
 *  - ctrl+up → 대기 항목 «전부»를 입력 순서대로 buffer 앞으로 되꺼낸다(편집 가능한 것만 이 큐에 든다)
 *  - escape 등 나머지 → 미소유(턴 중단 등 기존 경로 그대로) */
export function applyTurnTypeaheadKey(
  state: TurnTypeaheadState,
  // ⭐ `shift`·`meta` 도 선언한다 — 상류 대시보드가 실제로 싣는 필드다. 구조적 타이핑이라
  //    선언이 없어도 런타임엔 들어오므로, 빠뜨리면 정확한 조합 판정을 타입으로 못 쓴다.
  key: { name: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; mouse?: unknown; kind?: string; paste?: string },
  isImmediateSubmission?: TurnTypeaheadImmediateSubmissionLookup,
): TurnTypeaheadKeyResult {
  if (key.mouse) return { state, consumed: false, changed: false };
  if (key.kind && key.kind !== 'press') return { state, consumed: false, changed: false };

  // ⭐ 턴 중 붙여넣기 — 종전엔 소유하지 않아 스트리밍 사다리에서 조용히 버려졌다(10-22 설치본 99edcfa 재현).
  //    짧은 글은 버퍼에 그대로 · 긴 글은 자리표시 토큰(원문은 `pastes`) · 제출하면 원문 전부가 FIFO 로 간다.
  if (key.name === 'paste') {
    // 원문(끝 줄바꿈 포함)은 그대로 쥐고 제출한다 — 줄 수·글자 수 표시만 끝 줄바꿈 하나를 빼고 센다(r1 must-fix · paste-fold 와 같은 규칙).
    const raw = typeof key.paste === 'string' ? key.paste.replace(/\r\n?/g, '\n') : '';
    const shown = raw.replace(/\n$/, '');
    if (!raw) return { state, consumed: true, changed: false };
    const lines = shown.split('\n').length;
    if (!shouldFoldPaste(shown)) {
      return { state: { ...state, buffer: state.buffer + raw }, consumed: true, changed: true, pasted: { folded: false, lines, chars: shown.length } };
    }
    const seq = (state.pasteSeq ?? 0) + 1;
    const token = pasteFoldToken(seq, shown);
    return {
      state: { ...state, buffer: state.buffer + token, pastes: [...(state.pastes ?? []), [token, raw]], pasteSeq: seq },
      consumed: true,
      changed: true,
      pasted: { folded: true, lines, chars: shown.length },
    };
  }

  if (key.name === 'backspace' && !key.ctrl && !key.alt) {
    if (!state.buffer) return { state, consumed: false, changed: false };
    // 토큰 끝에서 지우면 토큰 «통째로»(반쯤 지운 토큰은 원문도 글도 아니다).
    const tail = state.pastes?.find(([token]) => state.buffer.endsWith(token));
    if (tail) return { state: prunePastes({ ...state, buffer: state.buffer.slice(0, -tail[0].length) }), consumed: true, changed: true };
    const cps = [...state.buffer];
    cps.pop();
    return { state: prunePastes({ ...state, buffer: cps.join('') }), consumed: true, changed: true };
  }

  // ⭐ 턴 중에도 Shift+Enter(⊕ Alt+Enter · Ctrl+J)는 «줄바꿈»이다 — 유휴 입력창과 같은 계약.
  //    종전엔 수식자를 안 보고 «제출»(FIFO 대기)로 떨어져, 도는 턴 위에 쓰던 여러 줄이 반토막으로 나갔다.
  //    빈 버퍼의 줄바꿈은 소유만 하고 버퍼는 안 바꾼다(맨 앞 빈 줄을 만들지 않는다).
  if (isTypeaheadNewlineKey(key)) {
    if (!state.buffer) return { state, consumed: true, changed: false };
    return { state: { ...state, buffer: `${state.buffer}\n` }, consumed: true, changed: true };
  }

  if (key.name === 'enter' && !key.ctrl && !key.alt && !key.shift) {
    if (!state.buffer.trim()) {
      // ⭐ 「한 번 더 Enter = 지금」 — 큐가 비면 옛 계약 그대로 소유하지 않는다.
      if (state.queuedSubmissions.length === 0) return { state, consumed: false, changed: false };
      return { state, consumed: true, changed: false, pushNowRequested: true };
    }
    const submitted = expandTurnTypeaheadPastes(state.buffer, state.pastes).text;
    const cleared = prunePastes({ ...state, buffer: '' });
    try {
      if (state.buffer.startsWith('/') && isImmediateSubmission?.(state.buffer)) {
        return {
          state: cleared,
          consumed: true,
          changed: true,
          immediateSubmission: submitted,
          submissionDisposition: 'immediate',
        };
      }
    } catch {
      // A registry lookup failure must preserve the typed input on the existing FIFO path.
    }
    return {
      state: {
        buffer: '',
        queuedSubmissions: [...state.queuedSubmissions, submitted],
        ...idsField([...turnTypeaheadPendingIds(state), null]),
      },
      consumed: true,
      changed: true,
      submissionDisposition: 'fifo',
    };
  }

  // ⛔ 정확한 조합만 소유한다 — 수식자를 덜 보면 `ctrl+shift+up` 같은 조합까지 삼켜
  //    다른 층이 쓸 키를 조용히 먹는다.
  if (key.name === 'up' && key.ctrl && !key.alt && !key.shift && !key.meta) {
    if (state.queuedSubmissions.length === 0) return { state, consumed: false, changed: false };
    // ⭐ 전부 꺼낸다(Claude Code 동형) — 한 건씩이면 여러 건을 고칠 때 순서가 뒤집힌다.
    //   입력 순서를 지키고, 치던 초안은 맨 뒤에 둔다.
    const recalled = [...state.queuedSubmissions, ...(state.buffer ? [state.buffer] : [])].join('\n');
    const released = presentIds(turnTypeaheadPendingIds(state));
    return {
      state: { ...withoutIds(state), buffer: recalled, queuedSubmissions: [], steerPriority: undefined },
      consumed: true,
      changed: true,
      ...(released.length > 0 ? { releasedPendingIds: released } : {}),
    };
  }

  if (isTypeaheadPrintable(key)) {
    const ch = key.name === 'space' ? ' ' : key.name;
    return { state: { ...state, buffer: state.buffer + ch }, consumed: true, changed: true };
  }

  return { state, consumed: false, changed: false };
}

/** Restores an immediate-dispatch candidate to the tail of the existing FIFO after dispatch rejects it. */
export function restoreTurnTypeaheadSubmission(
  state: TurnTypeaheadState,
  text: string,
): TurnTypeaheadState {
  return {
    ...withoutIds(state),
    queuedSubmissions: [...state.queuedSubmissions, text],
    ...idsField([...turnTypeaheadPendingIds(state), null]),
  };
}

export type TurnTypeaheadHandoff =
  | { kind: 'none' }
  | { kind: 'prefill'; text: string; pastes?: Array<[token: string, raw: string]> }
  | { kind: 'submit'; text: string; pendingId?: string };

/** 턴 종료 때 FIFO의 다음 항목 하나를 꺼낸다. 큐가 비면 미제출 buffer는 prefill한다. */
export function dequeueTurnTypeaheadHandoff(
  state: TurnTypeaheadState,
): { handoff: TurnTypeaheadHandoff; state: TurnTypeaheadState } {
  const [next, ...queuedSubmissions] = state.queuedSubmissions;
  if (next !== undefined) {
    const [pendingId, ...queuedPendingIds] = turnTypeaheadPendingIds(state);
    return {
      handoff: pendingId ? { kind: 'submit', text: next, pendingId } : { kind: 'submit', text: next },
      state: { ...withoutIds(state), queuedSubmissions, ...idsField(queuedPendingIds) },
    };
  }
  if (!state.buffer) return { handoff: { kind: 'none' }, state };
  // 토큰째 넘기고 짝도 같이 넘긴다 — 받는 입력창이 짝을 넘겨받아(`initialPastes`) 토큰으로 보이고 제출 때 편다.
  const pastes = state.pastes?.filter(([token]) => state.buffer.includes(token));
  return { handoff: { kind: 'prefill', text: state.buffer, ...(pastes?.length ? { pastes } : {}) }, state: createTurnTypeaheadState() };
}

/** 턴 범위 표시(최우선·넣음 수)를 지운다 — 다음 턴으로 넘기지 않는다. 순수. */
function clearTurnScopedMarks(state: TurnTypeaheadState): TurnTypeaheadState {
  if (state.steerPriority === undefined && state.injectedCount === undefined) return state;
  const { steerPriority: _p, injectedCount: _n, ...rest } = state;
  return rest;
}

/** «지금 밀어 넣기»가 다음 경계 최우선으로 떨어졌음을 적는다. 레지스트리에 든 항목이 없으면 그대로. 순수. */
export function markTurnTypeaheadPriority(state: TurnTypeaheadState): TurnTypeaheadState {
  return presentIds(turnTypeaheadPendingIds(state)).length > 0 ? { ...state, steerPriority: true } : state;
}

/** ⭐ 턴 종료 드레인 **한 걸음** — `src/dashboard/index.ts` 의 inner-loop 가 반복마다 이걸 부른다.
 *  ⛔ 종전엔 그 순서(dequeue → state 교체 → nextInitial 누적 → submit 이면 enter 주입)가
 *     `index.ts` 안에만 있어서, 테스트가 그 순서를 **베껴 모사**할 수밖에 없었다. 베낀 테스트는
 *     배선 회귀를 못 잡는다(무인 리뷰 must-fix). ⇒ 순서 자체를 여기로 옮겨 **같은 코드**를
 *     테스트가 타게 한다. `index.ts` 는 결과를 화면·키 주입에 배선하기만 한다. */
export function drainTurnTypeaheadOnce(
  state: TurnTypeaheadState,
  carriedInitial: string | null | undefined,
  opts?: { interrupted?: boolean },
): {
  state: TurnTypeaheadState;
  nextInitial: string | undefined;
  injectEnter: boolean;
  /**
   * ⭐ 이번 걸음에 큐를 «떠난» 항목의 레지스트리 id — 호출측이 레지스트리에서도 떨어낸다.
   *   안 떨어내면 승격된 발화(새 프롬프트)가 다음 턴 둘째 바퀴에 «또» 들어가고(턴 종료),
   *   composer 로 돌아간 글이 고치기 전 문면으로 모델에 들어간다(중단 복원).
   */
  releasedPendingIds: string[];
  /** `nextInitial` 속 붙여넣기 토큰의 원문 — 받는 입력창에 `initialPastes` 로 넘긴다. */
  initialPastes?: Array<[token: string, raw: string]>;
} {
  state = clearTurnScopedMarks(state);
  if (opts?.interrupted && state.queuedSubmissions.length > 0) {
    const restored = [...state.queuedSubmissions, ...(state.buffer ? [state.buffer] : [])].join('\n');
    const pastes = state.pastes?.filter(([token]) => state.buffer.includes(token));
    return {
      state: createTurnTypeaheadState(),
      nextInitial: carriedInitial ? `${carriedInitial}\n${restored}` : restored,
      injectEnter: false,
      releasedPendingIds: presentIds(turnTypeaheadPendingIds(state)),
      ...(pastes?.length ? { initialPastes: pastes } : {}),
    };
  }
  const { handoff, state: remaining } = dequeueTurnTypeaheadHandoff(state);
  if (handoff.kind === 'none') {
    return { state: remaining, nextInitial: carriedInitial ?? undefined, injectEnter: false, releasedPendingIds: [] };
  }
  return {
    state: remaining,
    nextInitial: carriedInitial ? `${carriedInitial}${handoff.text}` : handoff.text,
    injectEnter: handoff.kind === 'submit',
    releasedPendingIds: handoff.kind === 'submit' && handoff.pendingId ? [handoff.pendingId] : [],
    ...(handoff.kind === 'prefill' && handoff.pastes ? { initialPastes: handoff.pastes } : {}),
  };
}

/** Backwards-compatible non-mutating handoff decision for a caller that only needs the next action. */
export function resolveTurnTypeaheadHandoff(state: TurnTypeaheadState): TurnTypeaheadHandoff {
  return dequeueTurnTypeaheadHandoff(state).handoff;
}

/**
 * ★ ***대기 큐를 «통째로» 비우고 그 내용을 낸다*** — `B3`(턴 «안» 주입)의 공급원. 순수.
 *
 * ⛔ 「비우면서 돌려준다」가 계약이다 — 안 비우면 같은 발화가 다음 루프 경계에서 «또» 들어간다.
 * ⚠️ 버퍼(치던 중인 초안)는 «건드리지 않는다» — 그건 아직 제출되지 않은 글이다.
 */
export function drainTurnTypeaheadQueue(
  state: TurnTypeaheadState,
): { state: TurnTypeaheadState; drained: string[] } {
  if (state.queuedSubmissions.length === 0) return { state, drained: [] };
  return {
    state: { ...withoutIds(state), queuedSubmissions: [] },
    drained: [...state.queuedSubmissions],
  };
}

/**
 * ★ 라이브 턴 안으로 배수된 발화의 상태 전이 + 챗로그 문장. 순수.
 *
 * `items`(레지스트리 항목 · id 포함)를 주면 ***id 가 짝지어지는 항목만*** 떨어내고 문장도 그것만 적는다.
 *   ⛔ 앞에서부터 `slice(drained.length)` 하면 같은 버킷의 남의 항목(goal-loop 제어 메모)이나
 *   이미 되꺼낸 항목 때문에 엉뚱한 대기 발화가 떨어진다(10-14 중복 수리).
 * `items` 가 없으면 옛 계약(앞에서부터 떨어내기)을 지킨다.
 * 버퍼는 건드리지 않는다. 배수된 것이 없으면 문장도 없다.
 *
 * 문면은 `renderTurnTypeaheadQueueRow` 와 나란히 읽힌다:
 *   대기 `⏳ 대기 1건 · "<내용>" · 턴 종료 시 전송`
 *   배수 `⏳ 턴 안 1건 · "<내용>" · 라이브 턴으로 전송`
 *
 * ⚠️ 이 함수는 순수 조각이다 — 대시보드 배선·debug.log 는 호출측 책임
 *    (이 착지는 그 배선을 넣지 않는다).
 */
export function drainedIntoTurn(
  state: TurnTypeaheadState,
  drained: readonly string[],
  items?: readonly { id: string; text: string }[],
): { state: TurnTypeaheadState; sentence: string | null; matched: string[] } {
  if (drained.length === 0) return { state, sentence: null, matched: [] };
  let next: TurnTypeaheadState;
  let matched: string[];
  if (items) {
    const drainedIds = new Set(items.map(item => item.id));
    const ids = turnTypeaheadPendingIds(state);
    const keep = ids.map(id => id === null || !drainedIds.has(id));
    matched = state.queuedSubmissions.filter((_, i) => !keep[i]);
    next = {
      ...withoutIds(state),
      queuedSubmissions: state.queuedSubmissions.filter((_, i) => keep[i]),
      ...idsField(ids.filter((_, i) => keep[i])),
    };
  } else {
    matched = [...drained];
    next = {
      ...withoutIds(state),
      queuedSubmissions: state.queuedSubmissions.slice(drained.length),
      ...idsField(turnTypeaheadPendingIds(state).slice(drained.length)),
    };
  }
  if (matched.length === 0) return { state: next, sentence: null, matched };
  next = { ...next, injectedCount: (next.injectedCount ?? 0) + matched.length };
  if (presentIds(turnTypeaheadPendingIds(next)).length === 0) delete next.steerPriority;
  const count = matched.length;
  const label = count === 1 ? '⏳ 턴 안 1건' : `⏳ 턴 안 ${count}건`;
  const quoted = matched.map(text => `"${text}"`).join(' · ');
  return {
    state: next,
    sentence: `${label} · ${quoted} · 라이브 턴으로 전송`,
    matched,
  };
}

/** 스트리밍 에코 라인(무색) — composer zone 1줄에 그릴 내용.
 *
 *  ⛔⭐⭐ `B1`(2026-08-19 · 대표 지시) — ***큐 표시는 여기에 그리지 않는다.***
 *    대표: *"이 내용을 입력기에 그리는게 아니라 스트리밍 프롬프트에 그려야 하는것입니다."*
 *    ⇒ 큐 문면은 `renderTurnTypeaheadQueueRow()` 가 «따로» 내고, 스트리밍 표시줄 위에 그려진다.
 *    ⚠️ `includeQueueSuffix` 는 옛 호출부 보존용이다 — 기본은 «안 붙인다».
 *  width 초과 시 앞부분 절단(커서 쪽 = 끝부분 우선 표시 · textInput 동형). */
export function renderTurnTypeaheadEcho(
  state: TurnTypeaheadState,
  width: number,
  opts?: { includeQueueSuffix?: boolean },
): string {
  const count = state.queuedSubmissions.length;
  const suffix = opts?.includeQueueSuffix && count > 0 ? `  ⏎ ${count}건 대기 · 턴 종료 시 전송` : '';
  const budget = Math.max(8, width - 2 - [...suffix].length);
  const buffer = oneLine(state.buffer);
  const cps = [...buffer];
  const shown = cps.length > budget ? cps.slice(cps.length - budget).join('') : buffer;
  return `${shown}${suffix}`;
}

/**
 * ★ ***큐 «행»*** — 스트리밍 영역에 그릴 한 줄. 큐가 비면 `null`. 순수.
 *
 * ⭐ ref 정렬(grok-build): 큐 항목은 ⓐ「큐 행」으로 한 번 ⓑ 승격 뒤 `❯` 블록으로 한 번 보인다.
 *   ⛔ 두 번 «동시에» 보이면 회귀다.
 * ⭐ 그리고 ***내용을 보여 준다*** — 「1건 대기」만으로는 «무엇이» 대기 중인지 모른다.
 *   대기가 여럿이면 «가장 먼저 나갈 것»(FIFO 머리)을 보여 준다.
 */
export function renderTurnTypeaheadQueueRow(
  state: TurnTypeaheadState,
  width: number,
): string | null {
  const count = state.queuedSubmissions.length;
  if (count === 0) {
    // ✓ 넣음 — 도구 경계로 들어간 뒤 큐가 비었다(턴이 끝나면 지워진다).
    const injected = state.injectedCount ?? 0;
    return injected > 0 ? `✓ 넣음 ${injected}건 · 도는 턴에 이어서 반영` : null;
  }
  const head = oneLine(state.queuedSubmissions[0] ?? '');
  // ⭐ 항목 상태를 보인다 — 레지스트리에 든 것은 다음 도구 경계에, 안 든 것(슬래시·세션 없음)은 응답 뒤에 나간다.
  const steerable = presentIds(turnTypeaheadPendingIds(state)).length;
  const waiting = count - steerable;
  const parts: string[] = [];
  if (steerable > 0) parts.push(`${state.steerPriority ? '⚡ 최우선 · 다음 도구 경계에 넣음' : '↳ 다음 도구 경계에 넣음'} ${steerable}건`);
  if (waiting > 0) parts.push(`⏳ 대기(응답 뒤) ${waiting}건`);
  const label = parts.join(' · ');
  // 되꺼내기·밀어 넣기 키를 화면에 적는다 — 안내가 없어 대기 발화를 취소·수정할 길을 몰랐다(2026-09-26 베어 VM 실측 · UX 12).
  const tail = ' · Ctrl+↑ 되꺼내기 · 빈 Enter 지금 밀어 넣기';
  const budget = Math.max(8, width - [...label].length - [...tail].length - 5);
  const cps = [...head];
  const shown = cps.length > budget ? `${cps.slice(0, budget).join('')}…` : cps.join('');
  return `${label} · "${shown}"${tail}`;
}
