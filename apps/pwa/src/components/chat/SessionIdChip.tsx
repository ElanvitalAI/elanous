'use client';

// 2026-05-07 dogfood feedback — "session id picker, chatui, terminal
// integrated chat ui 3군데에서 다 잘보여야 한다 + 세션 ID 값 자체를
// 누르면 자동 복사되어야 한다." 본 컴포넌트가 그 3 위치 모두에서
// 동일 UX 보장:
//   - SessionPill (ChatLayout `/chat`)
//   - SessionPill (TerminalChatDock `/term` dock — same import)
//   - SessionPicker (모달 list row)
//
// UX 계약:
//   1. 단축 ID + ellipsis ("8a7c3f2b…") · 9자 이상은 항상 ellipsis
//   2. ID 텍스트 자체가 button — click 시 navigator.clipboard.writeText
//      → ✓ 피드백 1.2s (icon swap · emerald color)
//   3. Tooltip 에 full ID + 단축 표시 안내
//   4. data-elanous-session-id attribute 로 dia CDP smoke 가능

import { useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { copyToClipboard, shortSessionId } from './SessionPill';
import { debugLog } from '@/lib/debug';

const COPY_FEEDBACK_MS = 1200;

export interface SessionIdChipProps {
  sessionId: string | null | undefined;
  /** 표시 컨텍스트 — debug log + telemetry 구분용. 기본 'inline'. */
  source?: 'pill' | 'picker' | 'dropdown' | 'inline';
  /** 외형 variant — 'default' = pill 안 inline · 'subtle' = picker
   *  list row 같은 secondary surface (opacity-70 base 등). */
  variant?: 'default' | 'subtle';
  /** 추가 className override (size · color 등 surface 별 조정). */
  className?: string;
  /** Copy icon 표시 여부 — picker list 처럼 dense 한 레이아웃에서는
   *  false 로 hide (텍스트 자체 click 만 active). 기본 true. */
  showCopyIcon?: boolean;
}

export function SessionIdChip({
  sessionId,
  source = 'inline',
  variant = 'default',
  className,
  showCopyIcon = true,
}: SessionIdChipProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const performCopy = async (): Promise<void> => {
    if (!sessionId) return;
    const ok = await copyToClipboard(sessionId);
    debugLog('webterm.session-id-chip.copy', { sessionId, ok, source });
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };

  const onClick = (ev: React.MouseEvent): void => {
    // Picker list row 안에서는 outer button 의 onClick (세션 attach)
    // 이 trigger 안 되도록 stopPropagation. caller 가 자체 propagation
    // 원하면 wrapping 안 하면 됨.
    ev.stopPropagation();
    void performCopy();
  };

  // SessionPicker 의 list row 가 outer `<button>` 인 경우 nested
  // button 은 invalid HTML. `<span role="button">` 로 렌더해서
  // 그 충돌 회피. keyboard 접근성은 onKeyDown 로 보강 (Enter / Space).
  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    ev.stopPropagation();
    void performCopy();
  };

  const idShort = shortSessionId(sessionId);
  const disabled = !sessionId;
  const tooltip = sessionId
    ? `대화 ID 전체 (${sessionId.length}자): ${sessionId}\n· 누르면 자동으로 복사됩니다 — 앞 8자만 표시합니다 (… 표시는 생략됨)\n· 새 대화를 시작하면 다른 ID가 발급됩니다`
    : '대화가 선택되지 않았습니다';

  return (
    <span
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      onKeyDown={disabled ? undefined : onKeyDown}
      title={tooltip}
      aria-label={sessionId ? `대화 ID ${sessionId} 복사` : '대화가 선택되지 않았습니다'}
      data-elanous-session-id={sessionId ?? ''}
      data-elanous-action="session-id-copy"
      className={cn(
        'inline-flex items-center gap-1 rounded font-mono transition-colors select-none focus:outline-none focus:ring-1 focus:ring-ring',
        variant === 'default'
          ? 'px-1 py-0.5 hover:bg-secondary'
          : 'opacity-70 hover:opacity-100 hover:bg-muted/40 px-0.5',
        copied && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        disabled && 'cursor-not-allowed opacity-40',
        !disabled && 'cursor-copy',
        className,
      )}
    >
      <span>{idShort}</span>
      {showCopyIcon && (
        copied
          ? <Check className="h-3 w-3" aria-hidden />
          : <Copy className="h-3 w-3 opacity-60" aria-hidden />
      )}
    </span>
  );
}
