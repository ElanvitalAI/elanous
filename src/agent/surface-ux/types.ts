// SurfaceUx — cross-surface UX adapter interface (2026-07-20).
//
// PLAN-cross-surface-ux-adapter-2026-07-20. 무거운 자율 워크플로우(SelfImplement·
// delegate·autopilot mission·terminal)를 텔레그램/디스코드/PWA/iOS/Android/ACP/TUI/CLI
// 어디서 트리거해도 같은 UX(승인 버튼·진행·큰결과 첨부)로 굴러가게 하는 **단일 번들**.
//
// 이건 새 프리미티브가 아니라 **기존 4프리미티브를 묶은 어댑터**:
//   confirm  ← ConfirmChannel[]  (requestConfirmation race)
//   question ← QuestionChannel[] (requestQuestion race)
//   spillFile← FileSink          (per-chat sendFile)
//   progress ← emitFeedback      (FeedbackEnvelope tool.progress)
// 이 4개는 이미 `DaemonToolDispatchCtx` 위를 흐른다(daemon-tools/types.ts). SurfaceUx 는
// 그걸 툴이 4필드로 저글링하지 않게 한 겹 감싼다. 미지원 능력은 no-op / fail-closed.

import type { ConfirmRequest } from '../../hitl/confirm.js';
import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
} from '../../ask-user-question/types.js';

/** 트리거된 서피스 — 관측/로그 라벨 + 렌더 분기용. `unknown` 은 ctx 만 주어지고
 *  서피스가 명시 안 된 경우(대부분 동작엔 무관·라벨만). */
export type SurfaceKind =
  | 'telegram'
  | 'discord'
  | 'pwa'
  | 'ios'
  | 'android'
  | 'acp'
  | 'tui'
  | 'cli'
  | 'unknown';

/** 큰 출력(diff·stdout·리포트)을 파일 첨부로 spill. FileSink.sendFile 위임. */
export interface SurfaceSpillFile {
  /** 본문. Buffer 는 utf8 문자열로 coerce(바이너리는 sendImage 별도 · 여기선 텍스트). */
  content: string | Buffer;
  /** 확장자 — 'diff'(패치) / 'txt'(그 외). 클라이언트 신택스 힌트. */
  ext: string;
  /** 전체 파일명(식별성). 생략 시 sink 가 generic 이름. `spillFileName` 로 유도. */
  name?: string;
  /** 1줄 캡션(툴 타이틀 + 크기 등). */
  caption?: string;
}

/** 무거운 자율툴이 소비하는 서피스-무관 UX 번들. 툴은 이걸 받아 서피스가 텔레그램인지
 *  ACP 인지 신경 안 쓴다 — 팩토리가 서피스별 구현으로 뒤를 채운다. */
export interface SurfaceUx {
  /** 트리거 서피스(라벨·렌더 분기). */
  readonly surface: SurfaceKind;
  /** 상호작용 인간이 닿는가(confirm/question 이 실답을 받을 수 있는가). false 면
   *  confirm 은 fail-closed(false)·question 은 null 을 즉시 반환한다. */
  readonly interactive: boolean;
  /** HITL 승인(버튼). 채널 없으면 **fail-closed → false**(자동승인 금지·제1원칙). */
  confirm(req: ConfirmRequest): Promise<boolean>;
  /** 구조화 질문(N옵션). 채널 없으면 null(호출자가 default-and-note). */
  question(req: AskUserQuestionRequest, opts?: { timeoutMs?: number }): Promise<AskUserQuestionResult | null>;
  /** 큰 출력 파일 첨부(fire-and-forget · 실패 삼킴). sink 없으면 no-op. */
  spillFile(f: SurfaceSpillFile): void;
  /** 진행 상태 push(비동기·best-effort). emitFeedback 없으면 no-op. */
  progress(msg: string, opts?: { phase?: 'start' | 'delta' | 'end' }): void;
}
