/** Next TUI shell-approval session seam.
 *
 * The interactive prompt for Bash/RunShell and plugin-graph confirmations was
 * previously state + copy + lifecycle inline in `entry.ts`, so every approval
 * behavior change (see the duplicated `kind` hunks across #37096/#37108/#37110/#37197)
 * edited four disjoint ranges of the entry hotspot. The session owns the prompt
 * state machine here; `entry.ts` keeps only render integration and key routing.
 * Source: P0-ENTRY-TS-HOTSPOT-SEAM (TC 2순위) · behavior must stay identical to
 * the inline implementation guarded by `entry-shell-approval-pty.test.ts`.
 */
import { applyShellApprovalKey, NEXT_TUI_SHELL_APPROVAL_MAX_WINDOW_MS, NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS } from '../tui-client/next-shell-approval.js';
import { APPROVAL_APPROVED, APPROVAL_DECLINED, type ApprovalOutcome } from '../graph-runner/approval-outcome.js';
import { shellApprovalCommandViewport } from './core/entry-render.js';
import type { Key } from '../tui.js';

export type NextTuiShellApprovalKind = 'bash' | 'graph';
export type NextTuiShellApprovalCancelReason = 'timeout' | 'turn-cancelled' | 'host-cancelled';

export interface NextTuiShellApprovalPrompt {
  readonly callId: string;
  readonly command: string;
  readonly kind: NextTuiShellApprovalKind;
  scroll: number;
  timer: ReturnType<typeof setTimeout> | null;
  readonly resolve: (outcome: ApprovalOutcome) => void;
}

export interface NextTuiShellApprovalViewport {
  readonly columns: number;
  readonly rows: number;
  readonly sidetabWidth: number;
}

export interface NextTuiShellApprovalPorts {
  /** Bridge to the entry status line. */
  readonly setStatus: (status: string) => void;
  /** Bridge to the entry render loop. */
  readonly render: () => void;
  /** Test seam mirroring `NextTuiOptions.shellApprovalTimeoutMs`. */
  readonly timeoutMs?: number;
  /** Live terminal metrics used to clamp prompt scrolling. */
  readonly viewport: () => NextTuiShellApprovalViewport;
}

export const shellApprovalPromptTitle = (kind: NextTuiShellApprovalKind): string =>
  kind === 'graph' ? '플러그인 그래프 승인 · 요청 내용' : 'Bash 실행 승인 · 전체 명령';

export const shellApprovalPromptHelp = (kind: NextTuiShellApprovalKind): string =>
  kind === 'graph' ? 'y 승인 · n 거부 · Enter 기본 N · Esc 거부' : 'y 실행 · n 거부 · Enter 기본 N · Esc 거부';

export const shellApprovalRequestStatus = (kind: NextTuiShellApprovalKind): string =>
  kind === 'graph' ? '플러그인 그래프 승인 필요 · 기본 N' : 'Bash 실행 승인 필요 · 기본 N';

export const shellApprovalDecisionStatus = (kind: NextTuiShellApprovalKind, approved: boolean): string =>
  kind === 'graph'
    ? (approved ? '플러그인 그래프 승인됨' : '플러그인 그래프 거부됨')
    : (approved ? 'Bash 명령 승인됨' : 'Bash 명령 거부됨');

export const SHELL_APPROVAL_TIMEOUT_STATUS = 'Bash 승인 시간 초과 · 거부됨';

/** Bash keeps «denied»; a graph approval nobody answered is on hold, not refused. */
export const shellApprovalTimeoutStatus = (kind: NextTuiShellApprovalKind): string =>
  kind === 'graph' ? '플러그인 그래프 승인 시간 초과 · 보류됨(거부 아님)' : SHELL_APPROVAL_TIMEOUT_STATUS;
export const shellApprovalCancelStatus = (kind: NextTuiShellApprovalKind): string =>
  kind === 'graph' ? '플러그인 그래프 승인 취소됨 · 보류됨(거부 아님)' : 'Bash 승인 취소됨 · 거부됨';

/** The host prompt ends one second before the child's own timer so the host answers first. A request may ask for a longer
 *  window (review-publish waits for the owner), but never beyond the owner publish-approval window. */
export const requestTimeoutMs = (timeoutMs: number | undefined, requestedWindowMs?: number): number => {
  const window = typeof requestedWindowMs === 'number' && Number.isFinite(requestedWindowMs) && requestedWindowMs > NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS
    ? Math.min(requestedWindowMs, NEXT_TUI_SHELL_APPROVAL_MAX_WINDOW_MS) : NEXT_TUI_SHELL_APPROVAL_TIMEOUT_MS;
  const ceiling = window - 1_000;
  return Math.max(1, Math.min(timeoutMs ?? ceiling, ceiling));
};

export function createShellApprovalSession(ports: NextTuiShellApprovalPorts) {
  let prompt: NextTuiShellApprovalPrompt | null = null;
  let lastResolvedCallId: string | null = null;
  let lastResolvedKind: NextTuiShellApprovalKind = 'bash';

  const settlePrompt = (pending: NextTuiShellApprovalPrompt, approved: boolean, status: string): void => {
    prompt = null;
    if (pending.timer) clearTimeout(pending.timer);
    lastResolvedCallId = pending.callId;
    lastResolvedKind = pending.kind;
    ports.setStatus(status);
    pending.resolve(approved ? APPROVAL_APPROVED : APPROVAL_DECLINED);
  };

  /** Like `begin`, but says WHY when nobody decided (another prompt is up, the window ran out, the request was cancelled). */
  const beginDecision = (command: string, callId: string, kind: NextTuiShellApprovalKind, windowMs?: number): Promise<ApprovalOutcome> =>
    new Promise<ApprovalOutcome>((resolve) => {
      // Busy is not a refusal: the owner has not seen this request.
      if (prompt) { resolve({ approved: false, reason: 'unavailable' }); return; }
      const pending: NextTuiShellApprovalPrompt = { callId, command, kind, scroll: 0, timer: null as ReturnType<typeof setTimeout> | null, resolve };
      prompt = pending;
      pending.timer = setTimeout(() => {
        if (prompt !== pending) return;
        prompt = null;
        lastResolvedCallId = callId;
        lastResolvedKind = kind;
        ports.setStatus(shellApprovalTimeoutStatus(kind));
        resolve({ approved: false, reason: 'timeout' });
        ports.render();
      }, requestTimeoutMs(ports.timeoutMs, windowMs));
      ports.setStatus(shellApprovalRequestStatus(kind));
      ports.render();
    });

  return {
    /** The prompt the entry render loop should project, if any. */
    active: (): NextTuiShellApprovalPrompt | null => prompt,
    /** Handler registered via `setNextTuiShellApprovalHandler` (answers the child with the reason when nobody decided). */
    beginDecision,
    /** Boolean form for callers that only need yes/no: anything undecided is false. */
    begin: async (command: string, callId: string, kind: NextTuiShellApprovalKind): Promise<boolean> =>
      (await beginDecision(command, callId, kind)).approved,
    /** Handler registered via `setNextTuiShellApprovalCancelHandler`. */
    cancel: (callId: string, reason: NextTuiShellApprovalCancelReason): void => {
      const active = prompt;
      const kind = active?.callId === callId ? active.kind : lastResolvedKind;
      const message = reason === 'timeout' ? shellApprovalTimeoutStatus(kind) : shellApprovalCancelStatus(kind);
      if (active?.callId === callId) {
        prompt = null;
        if (active.timer) clearTimeout(active.timer);
        lastResolvedCallId = callId;
        lastResolvedKind = active.kind;
        ports.setStatus(message);
        active.resolve({ approved: false, reason });
        ports.render();
      } else if (lastResolvedCallId === callId) {
        // The child may time out while the host is processing a delayed reply.
        // Keep the final visible state fail-closed for this exact request.
        ports.setStatus(message);
        ports.render();
      }
    },
    /** Route one key while a prompt is active; returns false when no prompt is active. */
    handleKey: (key: Key): boolean => {
      const active = prompt;
      if (!active) return false;
      const decision = applyShellApprovalKey(key.name, key);
      if (decision.kind === 'pending') {
        if (key.name === 'up' || key.name === 'down') {
          const { columns, rows, sidetabWidth } = ports.viewport();
          const viewport = shellApprovalCommandViewport(active.command, columns, sidetabWidth, rows, active.scroll);
          active.scroll = Math.max(0, Math.min(
            Math.max(0, viewport.lines.length - viewport.pageSize), viewport.scroll + (key.name === 'down' ? 1 : -1),
          ));
        }
      } else {
        settlePrompt(active, decision.approved, shellApprovalDecisionStatus(active.kind, decision.approved));
      }
      return true;
    },
    /** Fail-close any surviving prompt during entry shutdown. */
    dispose: (): void => {
      const pending = prompt;
      prompt = null;
      if (pending?.timer) clearTimeout(pending.timer);
      pending?.resolve({ approved: false, reason: 'host-cancelled' });
    },
  };
}

export type NextTuiShellApprovalSession = ReturnType<typeof createShellApprovalSession>;
