'use client';

// 2026-05-07 dogfood feedback — 사용자가 "세션 ID 가 chat preview text
// 와 섞여서 식별 어렵다 + 복사할 방법 없다" 호소. 본 fix:
//   1. 세션 ID short (8자) 가 pill 첫 group · "sess:" 라벨 + 명시적
//      Copy 버튼 (click → navigator.clipboard.writeText + ✓ 피드백)
//   2. preview text 는 secondary group 으로 분리 (visual separator
//      `border-l` · muted styling · ID 와 시각적으로 안 섞이게)
//   3. dropdown 안에 full ID + Copy 버튼 + 메시지 카운트 (기존 단축
//      ID 만 보였던 표 강화)
//
// 동일 컴포넌트가 ChatLayout (`/chat`) + TerminalChatDock (`/term` dock)
// 양쪽에서 mount 되므로 한 군데 fix 가 두 surface 모두 적용.
//
// 본 fix 이전 design context (보존):
//
// Image-pipeline followup #3 (2026-05-05) — fork affordance + PR #4.5
// 강화 (preview text · origin pill · attach/forget dropdown).
//
// Click on the GitFork icon uses two-step armed pattern:
//   1. First click sets `confirmArmed=true` for 4s; the button paints
//      red + the title swaps to "Click again to fork".
//   2. Second click within the window calls `forkSession()` and shows
//      a brief "(forked)" via the title.
//   3. Idle 4s → armed state clears, no fork happens.
//
// PR #4.5 추가:
// - sessionId prop — workspace 의 chat 탭이 자기 sessionId 를 명시
//   override (단일 탭 `/chat` 은 무지정 = DaemonProvider sessionId 사용)
// - SessionsService 에서 preview / origin 가져와 라벨로 표시
// - `⌄` dropdown — "다른 세션 attach" / "이 세션 잊기" callback 노출
//   (callback 미지정 시 dropdown item 자체가 안 보임 — single-tab 페이지
//   의 동작 보존)

import { useEffect, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { forkSession } from '@/lib/daemon-session';
import { useSessions } from '@/lib/use-sessions';
import {
  GitFork, ChevronDown, Trash2, ListTree, Info, MessageSquarePlus,
  Copy, Check,
} from 'lucide-react';
import { debugLog } from '@/lib/debug';
import { SessionIdChip } from './SessionIdChip';

const ARM_TIMEOUT_MS = 4000;
const COPY_FEEDBACK_MS = 1200;

const ORIGIN_LABEL: Record<string, string> = {
  cli: 'cli',
  pwa: 'pwa',
  tg: 'tg',
  dc: 'dc',
};

export interface SessionPillProps {
  /** workspace chat 탭 — 자기 탭의 sessionId 를 명시. 미지정 시
   *  DaemonProvider 의 default 사용 (single-tab `/chat` 동작 보존). */
  sessionId?: string;
  /** Dropdown 의 "다른 세션 attach" 가 호출. 미지정 시 menu item 미표시. */
  onAttachRequest?: () => void;
  /** Dropdown 의 "이 세션 잊기" 가 호출. 미지정 시 menu item 미표시. */
  onForgetRequest?: () => void;
}

/** Copy `value` to clipboard. Returns true on success — false on
 *  permission/insecure-context failure. Pure helper exported for unit
 *  test of the success-path branch. */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (!value) return false;
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** Truncate sessionId for display: first 8 chars + ellipsis when the
 *  full ID is longer than 8 chars · "—" when empty. Ellipsis 가 명시
 *  적이라 사용자가 "이게 전체 ID 인지 단축인지" 헷갈리지 않음
 *  (2026-05-07 dogfood feedback). 8자 이하 짧은 ID 는 ellipsis 없이
 *  그대로 (전체 = 표시값). 새 세션은 `crypto.randomUUID()` (UUID v4 ·
 *  128-bit · `apps/pwa/src/lib/daemon-session.ts:9`) 라 항상 36자
 *  → 항상 ellipsis 붙음. Pure helper exported for unit test. */
export function shortSessionId(sid: string | null | undefined): string {
  if (!sid) return '—';
  if (sid.length <= 8) return sid;
  return `${sid.slice(0, 8)}…`;
}

export function SessionPill(props: SessionPillProps = {}) {
  const daemon = useDaemon();
  const sessions = useSessions();
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Dropdown 의 full-ID copy 버튼 ✓ 피드백 (pill 의 단축 ID 클릭은
  // SessionIdChip 가 자체 state 관리). 두 위치를 분리해 한쪽 click 이
  // 다른쪽 ✓ 안 띄움.
  const [dropdownCopied, setDropdownCopied] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const sid = props.sessionId ?? daemon.sessionId;
  const summary = sessions.find((s) => s.id === sid);

  useEffect(() => {
    return () => {
      if (armTimer.current) clearTimeout(armTimer.current);
      if (dropdownCopyTimer.current) clearTimeout(dropdownCopyTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [menuOpen]);

  const onForkClick = (): void => {
    if (!confirmArmed) {
      setConfirmArmed(true);
      debugLog('webterm.session-pill.fork-armed', { sessionId: sid });
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => {
        setConfirmArmed(false);
        debugLog('webterm.session-pill.fork-disarmed-timeout', { sessionId: sid });
      }, ARM_TIMEOUT_MS);
      return;
    }
    if (armTimer.current) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
    setConfirmArmed(false);
    const next = forkSession();
    debugLog('webterm.session-pill.fork-confirmed', { previous: sid, next });
    daemon.setSessionId(next);
  };

  const onDropdownCopy = async (): Promise<void> => {
    if (!sid) return;
    const ok = await copyToClipboard(sid);
    debugLog('webterm.session-pill.copy', { sessionId: sid, ok, source: 'dropdown' });
    if (!ok) return;
    setDropdownCopied(true);
    if (dropdownCopyTimer.current) clearTimeout(dropdownCopyTimer.current);
    dropdownCopyTimer.current = setTimeout(() => setDropdownCopied(false), COPY_FEEDBACK_MS);
  };

  const buttonClass = confirmArmed
    ? 'rounded p-0.5 bg-destructive text-destructive-foreground hover:bg-destructive/90'
    : 'rounded p-0.5 hover:bg-secondary';
  // ⛔⭐⭐ **문면이 «반대로» 읽혔다** — 대표 2026-08-22: *"채팅에서 매번 같은 세션에서 시작하는데,
  //   새로운 세션으로 채팅을 시작하는 버튼이라던가 장치가 있어야 할 것 같습니다."*
  //   📏 그런데 ***기능은 이미 이 버튼이다*** — `forkSession()` 은 새 id 를 만들 뿐이고
  //     ***히스토리를 복사하지 않는다***(빈 새 대화다 · 실측: 눌렀더니 화면이 비고 「Start a
  //     conversation」이 떴다). ⇒ 못 찾은 것이지 없는 것이 아니었다.
  //   ⛔ 그 오해의 절반은 이 문면이었다 — *"keeps history attached to the current one"* 이
  //     «새 세션이 히스토리를 갖고 간다»로 읽힌다. 뜻은 «지금 세션에 그대로 남는다»였다.
  //   ⇒ 🔑 그래서 ***「무엇이 되는가」를 앞에, 「지금 것은 어떻게 되는가」를 뒤에*** 적는다.
  const buttonTitle = confirmArmed
    ? '한 번 더 누르면 새 대화가 시작됩니다 — 지금 대화는 그대로 저장되고 대화 목록에 남습니다'
    : '새 대화 시작 (두 번 클릭) — 빈 대화에서 새로 시작합니다';

  const previewText = summary?.lastMsgPreview ?? null;
  // ⭐ 메뉴는 «항상» 뜬다 — 아래 「새 대화 시작」 항목이 늘 있기 때문이다.
  //   ⛔ 이전엔 attach/forget 이 있을 때만 떠서, 그것을 안 넘긴 화면에는 메뉴 자체가 «없었다».
  const hasMenu = true;

  return (
    <div ref={menuRef} className="relative flex items-center">
      <div className="flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px]">
        {/* Group 1 — session ID (always visible · 식별 우선) · 클릭
            자체가 전체 ID 자동 복사 (SessionIdChip 가 처리 · ✓ 피드백
            1.2s). previously preview 가 있을 때 ID 가 hidden 되던 회귀
            fix. ellipsis "…" 로 단축 표시 명시. */}
        <span className="text-muted-foreground font-mono">대화:</span>
        <SessionIdChip sessionId={sid} source="pill" />

        {/* Group 2 — origin pill (cli/pwa/tg/dc 출처). 이전 디자인 유지. */}
        {summary?.origin && (
          <span className="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
            {ORIGIN_LABEL[summary.origin] ?? summary.origin}
          </span>
        )}

        {/* Group 3 — preview text (secondary · ID 와 시각적으로 분리).
            border-l 가 ID group 과의 visual boundary. truncate +
            muted text 로 ID prominence 보존. */}
        {previewText && (
          <span
            className="ml-1 max-w-[180px] truncate border-l border-border pl-2 text-muted-foreground"
            title={previewText}
          >
            {previewText}
          </span>
        )}

        {/* Group 4 — actions (fork · menu). border-l 로 분리. */}
        <span className="ml-1 flex items-center gap-1 border-l border-border pl-1.5">
          <button
            type="button"
            onClick={onForkClick}
            className={buttonClass}
            title={buttonTitle}
            aria-label={buttonTitle}
          >
            <GitFork className="h-3 w-3" />
          </button>
          {confirmArmed ? (
            <span className="text-[10px] text-destructive" aria-live="polite">
              새 대화?
            </span>
          ) : null}
          {hasMenu && (
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="대화 메뉴"
              className="rounded p-0.5 hover:bg-secondary"
              title="대화 메뉴"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          )}
        </span>
      </div>
      {menuOpen && (
        <div
          role="menu"
          className="absolute left-0 top-7 z-50 w-72 rounded-md border border-border bg-popover py-1 text-xs shadow-md"
        >
          {/* ⛔⭐⭐⭐ 「새 대화 시작」 — 대표 2026-08-22 요청으로 «이름을 붙여» 꺼냈다.
              📏 기능은 원래 위 `GitFork` 아이콘이었다(`forkSession()` 은 새 id 를 만들 뿐 히스토리를
                복사하지 않는다). ⇒ ***없어서가 아니라 「Fork」라는 이름과 작은 아이콘이라 못 찾은 것이다.***
              ⭐ 그래서 여기서는 ⑴ «하는 일»을 이름으로 쓰고 ⑵ «지금 대화가 어떻게 되는지»를 같이 적는다
                — 그것을 모르면 누르기가 무섭다.
              ⛔ 확인(2-클릭)을 요구하지 «않는다» — 파괴적이지 않고(기존 세션은 저장된다) 메뉴를 연 것
                자체가 의도다. 되돌리는 길은 아래 설명이 말한다. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const next = forkSession();
              debugLog('webterm.session-pill.new-chat', { previous: sid, next, source: 'menu' });
              daemon.setSessionId(next);
              setMenuOpen(false);
            }}
            className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-secondary"
          >
            <MessageSquarePlus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>
              새 대화 시작
              <span className="block text-[10px] text-muted-foreground">
                빈 대화에서 새로 시작합니다 · 지금 대화는 대화 목록에 남습니다
              </span>
            </span>
          </button>
          {props.onAttachRequest && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                props.onAttachRequest!();
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-secondary"
            >
              <ListTree className="h-3.5 w-3.5 text-muted-foreground" />
              다른 대화로 전환
            </button>
          )}
          {/* 세션 정보 — full ID + Copy + 메시지 카운트. pill 의 short
              ID 만으로 식별 안 될 때 (e.g. 같은 prefix 다른 세션) 전체
              ID 확인 + 복사 path. */}
          <div className="px-3 py-1.5 text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Info className="h-3 w-3 shrink-0" />
              <span className="text-[10px] uppercase tracking-wide">대화 ID</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <span
                className="flex-1 select-all break-all font-mono text-[11px] text-foreground"
                title={sid || ''}
              >
                {sid || '(미설정)'}
              </span>
              <button
                type="button"
                onClick={() => void onDropdownCopy()}
                disabled={!sid}
                className="shrink-0 rounded p-1 hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
                title={dropdownCopied ? '복사됨' : '대화 ID 전체 복사'}
                aria-label="대화 ID 복사"
                data-elanous-action="session-id-copy-dropdown"
              >
                {dropdownCopied
                  ? <Check className="h-3 w-3 text-emerald-500" />
                  : <Copy className="h-3 w-3" />}
              </button>
            </div>
            <div className="mt-1 text-[10px]">
              {summary?.msgCount ?? 0} 메시지
              {summary?.origin && ` · ${ORIGIN_LABEL[summary.origin] ?? summary.origin}`}
            </div>
          </div>
          {props.onForgetRequest && (
            <>
              <div className="my-1 border-t border-border" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  props.onForgetRequest!();
                  setMenuOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-rose-500 hover:bg-rose-500/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                이 대화 지우기
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
