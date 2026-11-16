import type { HarnessAskUserCall } from '../tui-client/next-harness-ask-user.js';
import { safeStatusText } from './core/render.js';

export interface HarnessAskUserPorts {
  readonly sessionId: () => string | null;
  readonly canBegin: () => boolean;
  readonly onBegin: () => void;
  readonly onSettled: () => void;
  readonly setStatus: (value: string) => void;
  readonly render: () => void;
}

export function harnessAskUserComposerLines(call: HarnessAskUserCall): string[] {
  return [
    '질문 · 한 번 답변하면 이 라운드를 마칩니다',
    ...call.round.questions.map((question, index) => `${index + 1}. ${safeStatusText(question)}`),
    ...call.round.assumptions.map((assumption, index) => `가정 ${index + 1}. ${safeStatusText(assumption)}`),
  ];
}

export function createHarnessAskUserSession(ports: HarnessAskUserPorts) {
  let scroll = 0;
  let viewportLines: readonly string[] = [];
  let viewportRows = 0;
  let active: { call: HarnessAskUserCall; resolve: (answer: string | null) => void;
    timer: ReturnType<typeof setTimeout> } | null = null;
  const settle = (value: string | null, status: string) => {
    const current = active;
    if (!current) return;
    active = null;
    clearTimeout(current.timer);
    ports.onSettled();
    ports.setStatus(status);
    current.resolve(value);
    ports.render();
  };
  return {
    active: () => active?.call ?? null,
    begin: (call: HarnessAskUserCall): Promise<string | null> => new Promise(resolve => {
      if (active || call.sessionId !== ports.sessionId() || !ports.canBegin()) { resolve(null); return; }
      // Source: the child request has a five-minute deadline; the host expires just before it.
      const timer = setTimeout(() => settle(null, '인터뷰 시간 초과 · 답변 없음'), 5 * 60_000 - 1_000);
      active = { call, resolve, timer };
      scroll = 0;
      ports.onBegin();
      ports.setStatus('인터뷰 답변 입력 · PgUp/PgDn 내용 보기 · Enter 제출 · Esc 보류');
      ports.render();
    }),
    viewport: (lines: readonly string[], maxRows: number): string[] => {
      const size = Math.max(0, maxRows);
      viewportLines = lines;
      viewportRows = size;
      scroll = Math.min(scroll, Math.max(0, lines.length - size));
      return lines.slice(scroll, scroll + size);
    },
    scroll: (direction: 'up' | 'down'): void => {
      const size = Math.max(1, viewportRows);
      const step = Math.max(1, size - 1);
      scroll = Math.max(0, Math.min(Math.max(0, viewportLines.length - size), scroll + (direction === 'down' ? step : -step)));
      ports.render();
    },
    submit: (answer: string): void => {
      if (!active) return;
      if (!answer.trim()) { settle(null, '인터뷰 답변 없음 · 라운드 종료'); return; }
      if (Buffer.byteLength(answer) > 8192 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(answer)) {
        settle(null, '인터뷰 답변 형식 오류 · 라운드 종료'); return;
      }
      settle(answer.trim(), '인터뷰 답변 전달됨');
    },
    cancel: (callId: string): void => {
      if (active?.call.callId === callId) settle(null, '인터뷰 보류 · 답변 없음');
    },
    escape: (): void => settle(null, '인터뷰 보류 · 답변 없음'),
    dispose: (): void => settle(null, '인터뷰 종료 · 답변 없음'),
  };
}
